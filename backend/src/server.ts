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
import { attachMcp } from './mcp-http';
import { startTelegramBot } from './services/telegram-bot';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { userIdFromAuth } from './services/sessions';

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
app.use('/mcp', rateLimit({ windowMs: 60_000, max: 120, key: (r) => r.ip ?? 'anon', message: 'MCP rate limit reached' }));

// Embeddable visitor widget (Connect Wallet → fund a session → trade). Served as
// static files plus clean URLs so it can be iframed into any site.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const widgetFile = fileURLToPath(new URL('../public/widget.html', import.meta.url));
app.use(express.static(publicDir));
app.get('/widget', (_req, res) => res.sendFile(widgetFile));
app.get('/embed', (_req, res) => res.sendFile(widgetFile));

// ─── OAuth discovery + PKCE for any coding agent (ChatGPT/Claude/Cursor/Codex) ───
// Paybox-style: ChatGPT discovers via .well-known, redirects to /oauth/authorize → widget connect wallet → code → /oauth/token
const oauthCodes = new Map<string, { userId: string; clientId: string; redirectUri: string; codeChallenge: string; codeChallengeMethod: string; scope: string; resource: string; expires: number }>();
function baseUrl(req: import('express').Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  const host = req.headers.host ?? `127.0.0.1:${config.port}`;
  return `${proto}://${host}`;
}
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: ['mcp'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  });
});
app.post('/oauth/register', (req, res) => {
  // Dynamic client registration — ChatGPT sends client_name etc. Echo back a client_id.
  const cid = req.body?.client_id ?? `somnus-${randomUUID().slice(0, 8)}`;
  res.json({ client_id: cid, client_name: req.body?.client_name ?? 'Somnus MCP', scope: 'mcp' });
});
app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, resource } = req.query as Record<string, string>;
  if (!client_id || !redirect_uri || !code_challenge) { res.status(400).send('missing oauth params'); return; }
  // If already authed (JWT in Authorization), show consent immediately; else redirect to widget to connect wallet
  const auth = req.headers.authorization as string | undefined;
  const userId = userIdFromAuth(auth ?? '');
  if (!userId) {
    const qs = new URLSearchParams({ oauth: '1', client_id, redirect_uri, code_challenge, code_challenge_method: code_challenge_method ?? 'S256', state: state ?? '', scope: scope ?? 'mcp', resource: resource ?? '' }).toString();
    res.redirect(`/widget?${qs}`);
    return;
  }
  // Authed — issue code and redirect back to ChatGPT
  const code = randomUUID().replace(/-/g, '');
  oauthCodes.set(code, { userId, clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method ?? 'S256', scope: scope ?? 'mcp', resource: resource ?? '', expires: Date.now() + 300_000 });
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});
app.post('/oauth/token', (req, res) => {
  const { code, code_verifier, grant_type } = req.body ?? {};
  if (grant_type !== 'authorization_code' || !code || !code_verifier) { res.status(400).json({ error: 'invalid_grant' }); return; }
  const rec = oauthCodes.get(code);
  if (!rec || rec.expires < Date.now()) { res.status(400).json({ error: 'invalid_grant' }); return; }
  const calc = createHash('sha256').update(code_verifier).digest('base64url');
  const expected = rec.codeChallengeMethod === 'plain' ? code_verifier : calc;
  if (expected !== rec.codeChallenge) { res.status(400).json({ error: 'invalid_grant' }); return; }
  oauthCodes.delete(code);
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { sub: rec.userId, aud: rec.resource, scope: rec.scope, client_id: rec.clientId, iat: now, exp: now + 3600 };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(body)}`;
  const sig = createHmac('sha256', process.env.AUTH_SECRET ?? 'dev-only-somnus-auth-secret-change-me').update(data).digest('base64url');
  res.json({ access_token: `${data}.${sig}`, token_type: 'Bearer', expires_in: 3600, scope: rec.scope });
});

// Remote MCP endpoint — lets any coding agent or website drive Somnus over HTTP
// (as opposed to the local stdio server used by Claude Code/Cursor/Codex locally).
attachMcp(app);

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
  // Auto-notify + autoclaim: after any trade, tell the agent (ChatGPT/Claude) win/loss + profit and claim winners — no manual ask.
  let lastLoserIds = new Set<string>();
  let lastClaimedIds = new Set<string>();
  setInterval(async () => {
    try {
      const { findClaimable, claimAll } = await import('./services/settlement.js');
      const scan = await findClaimable();
      // Claim winners first — this also records settlements for losers
      let claimed: typeof scan.claimable = [];
      let txHash: string | undefined;
      if (scan.claimable.length > 0) {
        const ids = scan.claimable.map((c) => `${c.marketId}:${c.outcomeIdx}`).sort().join(',');
        const lastIds = [...lastClaimedIds].sort().join(',');
        if (ids !== lastIds) {
          const res = await claimAll();
          claimed = res.claimed;
          txHash = res.txHash;
          lastClaimedIds = new Set(scan.claimable.map((c) => `${c.marketId}:${c.outcomeIdx}`));
          if (claimed.length > 0) {
            const total = Number(res.totalEstPayout) / 1e6;
            const msg = `Somnus: Won +$${total.toFixed(2)} on ${claimed.length} market(s) — claimed tx ${txHash ?? ''} — check somnus_pnl`;
            console.error(`[somnus] ${msg}`);
            try {
              const { broadcastMcpMessage } = await import('./mcp-http.js');
              broadcastMcpMessage(msg);
            } catch {}
            try {
              const { broadcastStdioMessage } = await import('./mcp-server.js');
              (broadcastStdioMessage as (m: string) => void)(msg);
            } catch {}
          }
        }
      }
      // Losses — push once per newly settled loser
      const loserKey = (m: { marketId: string; outcomeIdx: number }) => `${m.marketId}:${m.outcomeIdx}`;
      const newLosers = scan.settledLosers.filter((m) => !lastLoserIds.has(loserKey(m)));
      if (newLosers.length > 0) {
        for (const l of newLosers) lastLoserIds.add(loserKey(l));
        const msg = `Somnus: Lost on ${newLosers.length} market(s) ${newLosers.map((l) => l.marketId.slice(-4)).join(',')} — check somnus_pnl for total`;
        console.error(`[somnus] ${msg}`);
        try {
          const { broadcastMcpMessage } = await import('./mcp-http.js');
          broadcastMcpMessage(msg);
        } catch {}
        try {
          const { broadcastStdioMessage } = await import('./mcp-server.js');
          (broadcastStdioMessage as (m: string) => void)(msg);
        } catch {}
      }
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