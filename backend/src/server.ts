import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config, warn } from './config';
import { setSigner } from './services/store';
import { createConfiguredSigner } from './services/proof';
import { healthRouter } from './routes/health';
import { marketsRouter } from './routes/markets';
import { agentRouter } from './routes/agent';
import { proofRouter } from './routes/proof';
import { authRouter } from './routes/auth';
import { userRouter } from './routes/user';
import { rateLimit } from './middleware/ratelimit';
import { stopAllAgents } from './services/user-agent';
import { maybeAutostart } from './services/loop';
import { maybeAnchor } from './services/anchor';
import { startTelegramBot } from './services/telegram-bot';

const app = express();

/** CORS is deliberately NOT wildcard.
 *
 *  This process can hold a funded key and expose "start trading" as an
 *  unauthenticated POST. With `cors()` open to every origin, any page you happen
 *  to visit could POST to localhost:4545 and arm a live agent. Default to local
 *  dev origins; set ALLOWED_ORIGINS (comma-separated, or `*` if you truly mean
 *  it) to widen deliberately.                                                  */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  }),
);
app.use(express.json({ limit: '1mb' }));

// Optional simple gateway token (bypasses wallet auth for the demo backend).
// When SOMNUS_API_KEY is set, it is REQUIRED on every MUTATING route (POST/PUT/
// DELETE/PATCH) — these are the ones that change limits or place real orders.
// Read-only GETs stay open so dashboards can poll. With no key set at all the
// API is unauthenticated, but the process is bound to loopback by default (see
// start()), so only local processes can reach it.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
if (config.apiKey) {
  app.use((req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    if (req.headers['x-api-key'] === config.apiKey) return next();
    res.status(401).json({ ok: false, error: 'missing or invalid X-API-Key' });
  });
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'somnus-backend', docs: '/api/health' });
});

app.use('/api', healthRouter);
app.use('/api', marketsRouter);
app.use('/api', agentRouter);
app.use('/api', proofRouter);
// Hardening: blunt auth brute-force before the auth routes handle it.
app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 12, key: (r) => r.ip ?? 'anon', message: 'too many auth attempts — wait a minute' }));
app.use('/api', authRouter);
app.use('/api', userRouter);

// Embeddable visitor widget (Connect Wallet → fund a session → trade). Served as
// static files plus clean URLs so it can be iframed into any site.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const widgetFile = fileURLToPath(new URL('../public/widget.html', import.meta.url));
app.use(express.static(publicDir));
app.get('/widget', (_req, res) => res.sendFile(widgetFile));
app.get('/embed', (_req, res) => res.sendFile(widgetFile));



/** Body-parser failures are client errors, not server errors. A malformed JSON
 *  body was answering 500, which reads as "the backend is broken" when it was
 *  the request that was wrong. */
app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === 'entity.parse.failed' || err?.status === 400) {
    res.status(400).json({ ok: false, error: 'malformed JSON body' });
    return;
  }
  next(err);
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  warn('unhandled route error', err);
  res.status(500).json({ ok: false, error: err.message ?? String(err) });
});

/** Last-resort process guards.
 *
 *  An audit request with a malformed body once killed this process outright: an
 *  async route threw, nothing caught it, and Node exited — taking a running
 *  agent and its open positions with it. For a daemon holding a key, dying on
 *  bad input is the worst outcome; so is carrying on trading from unknown state.
 *  Split the difference: stay up to serve reads, but halt the trading loop and
 *  say so loudly.                                                              */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    warn('UNHANDLED REJECTION —', reason instanceof Error ? reason.message : String(reason));
  });
  process.on('uncaughtException', (err) => {
    warn('UNCAUGHT EXCEPTION —', err?.message ?? String(err));
    try {
      stopAllAgents();
    } catch {
      /* nothing to stop */
    }
  });
  const shutdown = () => {
    warn('shutting down...');
    stopAllAgents();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export function start(): void {
  installProcessGuards();
  setSigner(createConfiguredSigner());
  // Optionally resume the autonomous loop on boot (AGENT_AUTOSTART=true). Off by
  // default so a process that boots trading the moment it starts is never the
  // default for something holding a key.
  maybeAutostart();
  // Periodically anchor the proof-chain head on-chain so the audit trail is
  // tamper-evident externally, not just on this machine.
  setInterval(() => void maybeAnchor(), 60_000).unref?.();
  startTelegramBot();
  // Auto-notify + autoclaim: after any trade, Telegram DM win/loss + profit and claim winners
  let lastLoserIds = new Set<string>();
  let lastClaimedIds = new Set<string>();
  setInterval(async () => {
    try {
      const { findClaimable, claimAll } = await import('./services/settlement.js');
      const scan = await findClaimable();
      if (scan.claimable.length > 0) {
        const ids = scan.claimable.map((c) => `${c.marketId}:${c.outcomeIdx}`).sort().join(',');
        const lastIds = [...lastClaimedIds].sort().join(',');
        if (ids !== lastIds) {
          const res = await claimAll();
          lastClaimedIds = new Set(scan.claimable.map((c) => `${c.marketId}:${c.outcomeIdx}`));
          if (res.claimed.length > 0) {
            const total = Number(res.totalEstPayout) / 1e6;
            console.error(`[somnus] auto-claimed +$${total.toFixed(2)} tx ${res.txHash ?? ''}`);
          }
        }
      }
      const loserKey = (m: { marketId: string; outcomeIdx: number }) => `${m.marketId}:${m.outcomeIdx}`;
      const newLosers = scan.settledLosers.filter((m) => !lastLoserIds.has(loserKey(m)));
      if (newLosers.length > 0) for (const l of newLosers) lastLoserIds.add(loserKey(l));
    } catch {}
  }, 30_000).unref?.();
  // Bind to loopback by default. An API that can arm live trading must not be
  // reachable from the network just because someone ran it on a shared host.
  // Override with HOST=0.0.0.0 (and set SOMNUS_API_KEY) only when intentional.
  const host = process.env.HOST ?? '127.0.0.1';
  app.listen(config.port, host, () => {
    console.log(`[somnus] listening on http://${host}:${config.port}`);
    console.log(`[somnus] network=${config.network} chainId=${config.chainId} dryRun=${config.dryRun} mode=${config.agent.mode}`);
    console.log(`[somnus] cors origins: ${allowedOrigins.join(', ')}`);

    // An unauthenticated API that can arm live trading is a wallet-drain risk the
    // moment it leaves localhost. Say so loudly rather than in a doc nobody reads.
    if (!config.dryRun && !config.apiKey) {
      warn(
        'LIVE mode with NO SOMNUS_API_KEY — anyone who can reach this port can ' +
          'change your limits and place orders. Set SOMNUS_API_KEY before exposing it.',
      );
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  start();
}