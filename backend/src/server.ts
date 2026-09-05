import express from 'express';
import cors from 'cors';
import { config, log, warn } from './config';
import { setSigner } from './services/store';
import { createConfiguredSigner } from './services/proof';
import { healthRouter, pingRouter } from './routes/health';
import { marketsRouter } from './routes/markets';
import { agentRouter } from './routes/agent';
import { proofRouter } from './routes/proof';
import { metricsRouter } from './routes/metrics';
import { mountMcp } from './mcp/http';
import { maybeAutostart, stopLoop, waitForIdle } from './services/loop';
import { maybeAnchor } from './services/anchor';
import { acquireLock, LockHeldError, releaseLock } from './services/lock';
import { checkClockSkew } from './services/clock';
import { logWalletState } from './services/wallet';
import { alertsConfigured } from './services/alerts';


const app = express();

/** Trust exactly one proxy hop.
 *
 *  Render (and any similar host) terminates TLS and forwards, so without this `req.ip`
 *  reports the PROXY's address for every request on earth. That is not merely imprecise:
 *  a per-caller rate limiter keyed on it degenerates into one shared bucket, and the first
 *  burst of traffic would 429 everybody at once — the exact failure a limiter is supposed
 *  to prevent.
 *
 *  `1`, not `true`: trusting every hop lets a caller prepend whatever `X-Forwarded-For`
 *  they like and appear to be a different client on each request. One hop is the one the
 *  host actually controls.
 *
 *  Harmless locally, where there is no proxy and no forwarded header to read.        */
app.set('trust proxy', 1);

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

/** Routes exempt from the gateway key even though they use POST.
 *
 *  MCP is JSON-RPC: every call is a POST, including "what tools do you have?".
 *  Gating on the HTTP method would demand a key for the handshake itself, so a
 *  public read-only endpoint would be unreachable without handing out the key that
 *  also authorises trading — exactly backwards.
 *
 *  This stays correct now that /mcp can also carry per-user wallet tools (see
 *  mcp/tools-user.ts), because the exemption is still not a trust decision about the
 *  caller. The gateway key authorises OPERATOR actions — changing the saved limits,
 *  trading the operator's wallet — and none of those are registered behind /mcp. The
 *  authority for a per-user tool is the caller's own `x-somnus-token`, which derives
 *  a wallet only they funded; requiring the operator's key on top would make a public
 *  endpoint unusable without publishing the very credential it protects.
 *
 *  `/api/proof/verify` is here for the same reason and no other: it is a POST only
 *  because it takes a body, it mutates nothing, and README:16 promises that ANYONE can
 *  audit the chain end-to-end. On the hosted deploy that promise returned 401 — the
 *  one claim the whole project rests on was the one the middleware blocked. The route
 *  caps caller-supplied entries so an unauthenticated request cannot spend unbounded
 *  CPU on signature recovery.                                                  */
const KEY_EXEMPT_PATHS = new Set(['/mcp', '/api/proof/verify']);

if (config.apiKey) {
  app.use((req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    if (KEY_EXEMPT_PATHS.has(req.path)) return next();
    if (req.headers['x-api-key'] === config.apiKey) return next();
    res.status(401).json({ ok: false, error: 'missing or invalid X-API-Key' });
  });
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'somnus-backend', docs: '/api/health' });
});

app.use('/api', healthRouter);
// Liveness at both `<host>/ping` and `<host>/api/ping`, so an uptime monitor's URL is
// the one somebody would guess. Its own router, so `/health` is not duplicated with it.
app.use('/', pingRouter);
app.use('/api', pingRouter);
app.use('/api', marketsRouter);
app.use('/api', agentRouter);
app.use('/api', proofRouter);
// Prometheus scrape endpoint. Deliberately NOT under /api: scrapers expect /metrics
// at the root, and it is a read-only text rendering of state /health already exposes.
app.use(metricsRouter);
// MCP at POST /mcp: read-only tools for anyone with the URL, plus per-user wallet
// tools for a caller who sends their own x-somnus-token. The operator's wallet is not
// reachable from here — trading it lives in the local stdio server.
mountMcp(app);



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
      stopLoop();
    } catch {
      /* nothing to stop */
    }
  });

  // Shutdown has to be ORDERLY, not immediate. `stopLoop(); process.exit(0)` cancels
  // the next tick and then kills the process wherever the current cycle happens to
  // be — and if that is between a live order landing on-chain and its ledger write,
  // the position exists and nothing local knows about it. A few seconds of waiting
  // is cheaper than a reconciliation diff on every deploy.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    warn(`${signal} received — stopping the loop and finishing any in-flight cycle...`);
    stopLoop();
    void waitForIdle(SHUTDOWN_GRACE_MS).then((clean) => {
      releaseLock();
      warn(clean ? 'shutdown clean' : 'shutdown forced with a cycle still in flight — run /api/agent/reconcile');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // A normal exit still has to give the lock back, or the next start reports a
  // phantom holder and refuses to run.
  process.on('exit', () => releaseLock());
}

const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 30_000);

/** Refuse to boot into a state that is unsafe rather than merely unusual, and report
 *  the things an operator would otherwise discover from a failed trade. */
async function preflight(): Promise<void> {
  // Only ONE process may own a data dir. All three concurrency invariants this
  // codebase documents — one append, one cycle, one claim — are module state, so
  // they hold within a process and not across two. Two processes interleaving
  // appends is the corruption that produced the backup files still in data/.
  try {
    acquireLock();
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(`\n[somnus] REFUSING TO START\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Clock first: every expiry decision is arithmetic on the host clock against
  // on-chain seconds, and drift makes all of it wrong without erroring once.
  const clock = await checkClockSkew(true);
  if (clock.skewSec !== undefined) {
    const line = `clock skew ${clock.skewSec}s vs chain`;
    if (clock.blocking) warn(`${line} — ABOVE the safe bound; trading is blocked until it is fixed`);
    else if (!clock.ok) warn(line);
    else log(line);
  } else if (clock.error) {
    warn(`could not measure clock skew: ${clock.error}`);
  }

  // What the wallet can actually afford. Cheap, and it turns "every order reverts"
  // into a line at startup.
  if (!config.dryRun) await logWalletState();
}

export function start(): void {
  installProcessGuards();
  setSigner(createConfiguredSigner());
  void preflight().then(() => {
    // Optionally resume the autonomous loop on boot (AGENT_AUTOSTART=true). Off by
    // default so a process that boots trading the moment it starts is never the
    // default for something holding a key. After preflight, so a locked data dir or
    // a broken clock is known before any order can be placed.
    maybeAutostart();
  });
  // Periodically anchor the proof-chain head on-chain so the audit trail is
  // tamper-evident externally, not just on this machine.
  setInterval(() => void maybeAnchor(), 60_000).unref?.();
  // Bind to loopback by default. An API that can arm live trading must not be
  // reachable from the network just because someone ran it on a shared host.
  // Override with HOST=0.0.0.0 (and set SOMNUS_API_KEY) only when intentional.
  const host = process.env.HOST ?? '127.0.0.1';
  app.listen(config.port, host, () => {
    console.log(`[somnus] listening on http://${host}:${config.port}`);
    console.log(`[somnus] network=${config.network} chainId=${config.chainId} dryRun=${config.dryRun} mode=${config.agent.mode}`);
    console.log(`[somnus] cors origins: ${allowedOrigins.join(', ')}`);
    console.log(`[somnus] alerts: ${alertsConfigured() ? 'webhook configured' : 'NOT configured (set ALERT_WEBHOOK_URL)'}`);

    // An unauthenticated API that can arm live trading is a wallet-drain risk the
    // moment it leaves localhost. Say so loudly rather than in a doc nobody reads.
    if (!config.dryRun && !config.apiKey) {
      warn(
        'LIVE mode with NO SOMNUS_API_KEY — anyone who can reach this port can ' +
          'change your limits and place orders. Set SOMNUS_API_KEY before exposing it.',
      );
    }
    // An unattended agent with no alerting is one you find out about in the morning.
    if (!config.dryRun && !alertsConfigured()) {
      warn(
        'LIVE mode with no ALERT_WEBHOOK_URL — if a breaker trips overnight nothing ' +
          'will tell you. Set it to any endpoint that accepts a JSON POST.',
      );
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  start();
}