import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { createUserSession, getUserSession, revokeUserSession } from '../services/sessions';
import { runCycle } from '../services/agent';
import { pnlSummary, pnlRecent } from '../services/pnl';

export const userRouter = Router();
userRouter.use(requireAuth);
// Per-visitor ceiling on all authed calls.
userRouter.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    key: (r) => r.user?.address ?? r.ip ?? 'anon',
    message: 'rate limit reached for this wallet',
  }),
);

/** Create a per-visitor session key. Returns the address they must fund with
 *  tUSDC (+ STT for gas) before trading. Non-custodial of their main wallet. */
userRouter.post('/user/session/create', (req, res) => {
  const s = createUserSession(req.user!.address);
  res.json({ ok: true, address: s.address });
});

userRouter.get('/user/session', (req, res) => {
  const s = getUserSession(req.user!.address);
  if (!s) {
    res.json({ ok: true, hasSession: false });
    return;
  }
  res.json({ ok: true, hasSession: true, address: s.address, createdAt: s.createdAt });
});

userRouter.post('/user/session/revoke', (req, res) => {
  const ok = revokeUserSession(req.user!.address);
  res.json({ ok, revoked: ok });
});

/** Run one trade cycle through the visitor's funded session account. They MUST
 *  specify how many trades and how much tUSDC each — these override the operator
 *  config for this run only. */
userRouter.post(
  '/user/run',
  rateLimit({
    windowMs: 60_000,
    max: 6,
    key: (r) => r.user?.address ?? r.ip ?? 'anon',
    message: 'slow down — at most 6 runs per minute per wallet',
  }),
  async (req, res) => {
  try {
    const uid = req.user!.address;
    const s = getUserSession(uid);
    if (!s) {
      res.status(400).json({ ok: false, error: 'no session — call /user/session/create and fund the address first' });
      return;
    }
    const { trades, sizePerTrade, symbols, minEdge } = req.body ?? {};
    if (typeof trades !== 'number' || typeof sizePerTrade !== 'number') {
      res.status(400).json({ ok: false, error: 'trades (int) and sizePerTrade (number) are required' });
      return;
    }
    const out = await runCycle({
      maxTrades: trades,
      maxTradeSize: sizePerTrade,
      ...(Array.isArray(symbols) ? { symbols } : {}),
      ...(typeof minEdge === 'number' ? { minEdge } : {}),
      sessionSeed: s.seed as `0x${string}`,
    });
    res.json({ ok: true, session: s.address, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message ?? String(e) });
  }
});

userRouter.get('/user/pnl', async (req, res) => {
  try {
    const summary = await pnlSummary();
    const recent = await pnlRecent(10);
    res.json({ ok: true, summary, recent });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message ?? String(e) });
  }
});
