import { Router } from 'express';
import { effectiveDryRun, loadAgentConfig, sanitize, saveAgentConfig } from '../agent-config';
import { runCycle, type RunOpts } from '../services/agent';
import { calibrationSummary } from '../services/horizon';
import { loopStatus, startLoop, stopLoop } from '../services/loop';
import { claimAll, findClaimable, sweepSettlements } from '../services/settlement';
import { pauseTrading, resumeTrading, reviewAfterSettlement } from '../services/risk';
import { reconcile } from '../services/reconcile';
import { recentEvents, subscribe, subscriberCount } from '../services/events';
import { appendEntry, currentAnchor, readChainPage } from '../services/store';
import { pnlSummary, pnlRecent, verifyLedgerAgainstChain } from '../services/pnl';
import { buildPerformanceReport } from '../services/report';
import { listPending, popPending } from '../services/pending';
import { executeStandaloneDecision } from '../services/broker';
import type { AgentConfigDoc } from '../types';

export const agentRouter: Router = Router();

/** Which window classes the agent will trade, and on what evidence.
 *
 *  Exposed because "it trades every market" and "it trades every market equally"
 *  are different claims, and only one of them is true. An auditor should be able
 *  to see the tier table without reading the source or the proof chain.        */
agentRouter.get('/agent/horizons', (_req, res) => {
  res.json({ ok: true, ...calibrationSummary() });
});

agentRouter.get('/agent/config', (_req, res) => {
  const doc = loadAgentConfig();
  res.json({ ok: true, config: doc, effectiveDryRun: effectiveDryRun(doc), mode: doc.mode });
});

agentRouter.put('/agent/config', async (req, res) => {
  const body = (req.body ?? {}) as Partial<AgentConfigDoc>;

  // The kill switch is not an ordinary config field, and this was a second way to
  // clear it. `{tradingPaused:false}` here skipped `resumeTrading()` entirely: no
  // alert fired, the deliberate `clearExecutionFailures` decision was never made,
  // and the resume left no trace beyond a generic config entry. One door, which
  // logs, rather than two of which one is quiet.
  if ('tradingPaused' in body) {
    res.status(400).json({
      ok: false,
      error:
        'tradingPaused cannot be set through PUT /agent/config — it is the kill switch, not a ' +
        'setting. Use POST /agent/pause or POST /agent/resume so the change is alerted and audited.',
    });
    return;
  }

  const next = sanitize({ ...loadAgentConfig(), ...body } as AgentConfigDoc);

  // Rule changes are themselves part of the audit trail — you can prove what
  // the limits were at the moment any order was placed.
  await appendEntry({ kind: 'config', payload: { config: next } as Record<string, unknown> });
  saveAgentConfig(next);
  res.json({ ok: true, config: next, effectiveDryRun: effectiveDryRun(next) });
});

/** Recent audit entries.
 *
 *  Filterable because a UI should not have to pull the whole chain to render one
 *  panel. `kind` narrows to decisions or orders, `since`/`until` bound a time range,
 *  and `cursor` pages backwards through history — the chain is already at four
 *  figures and only grows, so "just fetch it and filter client-side" stops working
 *  well before anyone notices it stopped working. */
agentRouter.get('/agent/logs', (req, res) => {
  const page = readChainPage({
    limit: clamp(req.query.limit, 100),
    kind: req.query.kind,
    since: req.query.since,
    until: req.query.until,
    cursor: req.query.cursor,
  });
  res.json({
    ok: true,
    dryRun: effectiveDryRun(),
    anchor: currentAnchor(),
    entries: page.entries,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    matched: page.matched,
  });
});

/** Realised + open P&L. The one number that shows whether the agent actually makes
 *  money, derived from the append-only fill/settlement ledger. */
agentRouter.get('/agent/pnl', (_req, res) => {
  res.json({ ok: true, ...pnlSummary(), recent: pnlRecent(25) });
});

/** Full performance report for Agent Studio — P&L split by horizon/asset/tier,
 *  breaker proximity, feed health, calibration table, and a conservative
 *  recommendation. Offline: reads only the local ledgers and config, no RPC. */
agentRouter.get('/agent/report', (_req, res) => {
  res.json({ ok: true, report: buildPerformanceReport() });
});
agentRouter.get('/agent/performance', (_req, res) => {
  res.json({ ok: true, report: buildPerformanceReport() });
});

agentRouter.post('/agent/run', async (req, res) => {
  try {
    const b = req.body ?? {};

    // Simple: no preset ask — agent stays on until it finds edge. Defaults to saved minEdge.
    const hasPreset = typeof b.edgePreset === 'string' && ['very-sure', 'middle', 'a-bit-sure'].includes(String(b.edgePreset).toLowerCase());

    const opts: RunOpts = {};
    if (hasPreset) opts.edgePreset = String(b.edgePreset).toLowerCase() as RunOpts['edgePreset'];
    const maxTrades = Number(b.maxTrades);
    if (Number.isFinite(maxTrades) && maxTrades > 0) opts.maxTrades = Math.floor(maxTrades);
    const size = Number(b.maxTradeSize);
    if (Number.isFinite(size) && size > 0) opts.maxTradeSize = size;
    const edge = Number(b.minEdge);
    if (Number.isFinite(edge) && edge > 0) opts.minEdge = edge;
    if (Array.isArray(b.symbols) && b.symbols.length > 0) {
      opts.symbols = b.symbols.map((s: unknown) => String(s).toUpperCase());
    }

    // Autotrade vs Manual — if they picked autotrade, start the loop that
    // hunts by itself and auto-claims, no per-trade ask.
    const wantsAutotrade = b.autoTrade === true || String(b.mode).toLowerCase() === 'autotrade';
    if (wantsAutotrade) {
      // Persist the choice so loop uses it
      const next = sanitize({ ...loadAgentConfig(), ...(hasPreset ? { edgePreset: opts.edgePreset } : {}), ...(opts.maxTradeSize ? { maxTradeSize: opts.maxTradeSize } : {}), ...(opts.minEdge ? { minEdge: opts.minEdge } : {}), maxTradeSize: opts.maxTradeSize ?? loadAgentConfig().maxTradeSize } as AgentConfigDoc);
      // Ensure edgePreset is saved correctly
      if (hasPreset) (next as any).edgePreset = opts.edgePreset;
      await appendEntry({ kind: 'config', payload: { config: next } as Record<string, unknown> });
      saveAgentConfig(next);
      const loop = startLoop();
      res.json({
        ok: true,
        mode: 'autotrade',
        message: `Autotrade ON — hunting every ${next.intervalMs / 1000}s on 5m+15m, ${next.edgePreset} (${(next.minEdge * 100).toFixed(0)}% edge), $${next.maxTradeSize} per bet, auto-claiming wins. Say "stop" to halt.`,
        loop,
        config: next,
        dryRun: effectiveDryRun(next),
      });
      return;
    }

    // This route NEVER places an order. Proposals come back as pending and need an
    // explicit POST /agent/confirm, and that is deliberate rather than an oversight:
    // it is the doorway a dashboard button or a curl in a shell history reaches, so
    // the confirm step is what stands between a stray request and real collateral.
    //
    // It does mean the two doorways have different powers — the `somnus_scan` MCP tool
    // CAN auto-place with `confirm:true`, because there the caller is an operator who
    // supplied the gateway key and asked for exactly that. Documented in the README
    // endpoint table so the difference is stated rather than discovered. Do not
    // "restore parity" here by honouring a body flag without deciding that on purpose.
    opts.requireConfirm = true;

    const out = await runCycle(Object.keys(opts).length > 0 ? opts : undefined);

    if (out.pending.length > 0) {
      const asks = out.pending.map((p) => ({
        id: p.id,
        message: `Found: ${p.symbol} expires ${p.horizon} — book ${p.mid.toFixed(3)} (bid ${p.bid.toFixed(3)} ask ${p.ask.toFixed(3)}), my fair ${p.fair.toFixed(3)}, edge ${(p.edge * 100).toFixed(1)}% (needs ${(p.requiredEdge * 100).toFixed(1)}%). Cost $${p.cost.toFixed(2)} for ${p.size} contracts — payout $${p.payoutIfWin} if win (profit $${(p.payoutIfWin - p.cost).toFixed(2)}). Place $${p.cost.toFixed(2)} on ${p.symbol.split('/')[0]} ${p.decision.action === 'BUY_YES' ? 'UP' : 'DOWN'}?`,
        detail: p,
        confirmUrl: '/api/agent/confirm',
        cancelUrl: '/api/agent/cancel',
      }));
      res.json({
        ok: true,
        ask: { type: 'trade', message: `Found ${asks.length} good bet(s) — confirm each?`, asks },
        decisions: out.decisions,
        pending: out.pending,
        books: out.books,
        errors: out.errors,
        anchor: currentAnchor(),
        ts: Date.now(),
      });
      return;
    }

    res.json({
      ok: true,
      dryRun: effectiveDryRun(),
      // Stated rather than implied: this route cannot place an order, so an empty
      // `orders` here means "nothing was executed by design", not "nothing qualified".
      autoExecute: false,
      decisions: out.decisions,
      orders: out.orders,
      books: out.books,
      errors: out.errors,
      anchor: currentAnchor(),
      ts: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? String(err) });
  }
});

// Confirm a pending trade — detailed Yes
agentRouter.post('/agent/confirm', async (req, res) => {
  try {
    const id = String(req.body?.id ?? req.body?.pendingId ?? '');
    if (!id) return res.status(400).json({ ok: false, error: 'provide {id} of pending trade' });
    const p = popPending(id);
    if (!p) return res.status(404).json({ ok: false, error: 'pending not found or expired (90s)' });
    // Standalone, not `executeDecision`: this request is not inside a decision
    // cycle, so the exposure baselines have to be re-established from real chain
    // and ledger state first. Calling executeDecision directly bypassed every
    // exposure limit — see the comment on executeStandaloneDecision.
    const order = await executeStandaloneDecision(p.decision);
    res.json({ ok: true, order, pending: p, anchor: currentAnchor() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? String(err) });
  }
});
agentRouter.post('/agent/cancel', (req, res) => {
  const id = String(req.body?.id ?? '');
  if (id) popPending(id);
  else listPending().forEach((p) => popPending(p.id));
  res.json({ ok: true, cancelled: id || 'all', remaining: listPending().length });
});
agentRouter.get('/agent/pending', (_req, res) => {
  res.json({ ok: true, pending: listPending() });
});

/** Autonomous operation. The loop is what makes the agent run unattended;
 *  without it every cycle needs a human to POST /agent/run. */
agentRouter.get('/agent/loop', (_req, res) => {
  res.json({ ok: true, loop: loopStatus(), dryRun: effectiveDryRun() });
});

agentRouter.post('/agent/loop/start', (_req, res) => {
  const rules = loadAgentConfig();
  res.json({
    ok: true,
    loop: startLoop(),
    dryRun: effectiveDryRun(rules),
    warning: effectiveDryRun(rules)
      ? undefined
      : `LIVE: real orders will be placed every ${rules.intervalMs}ms`,
  });
});

agentRouter.post('/agent/loop/stop', (_req, res) => {
  res.json({ ok: true, loop: stopLoop() });
});

/** Settlement: what can be redeemed, and redeem it. */
agentRouter.get('/agent/claimable', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await findClaimable()) });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message ?? String(err) });
  }
});

agentRouter.post('/agent/claim', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await claimAll()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? String(err) });
  }
});

/** Realise settled outcomes without redeeming anything.
 *
 *  Separate from /agent/claim on purpose: settlement determines P&L, redemption only
 *  moves collateral. The loss breakers read the ledger, so this is the call that keeps
 *  them honest — and it works in dry-run and with claiming switched off. */
agentRouter.post('/agent/settle-sweep', async (_req, res) => {
  const result = await sweepSettlements();
  // A sweep can newly cross a loss limit, and the moment the loss becomes real is
  // the right moment to stop — not the next cycle's first order.
  const risk = reviewAfterSettlement();
  res.json({ ok: result.error === undefined, sweep: result, risk });
});

/** Emergency stop, and the way back.
 *
 *  These existed as functions with no callers for a long time, which meant an
 *  execution-failure pause could only be cleared by hand-editing
 *  data/risk-state.json. An emergency stop you cannot reach from the API is not an
 *  emergency stop. */
agentRouter.post('/agent/pause', async (req, res) => {
  const reason = String(req.body?.reason ?? '').trim() || 'paused by operator';
  const status = pauseTrading(reason);
  stopLoop();
  await appendEntry({ kind: 'config', payload: { action: 'pause', reason, blocked: status.blocked } });
  res.json({ ok: true, risk: status, loop: loopStatus() });
});

agentRouter.post('/agent/resume', async (req, res) => {
  // Clearing the failure counter is an explicit, separate decision. Resuming says
  // "I have looked at it"; clearing says "I fixed the venue problem the counter was
  // measuring". Folding them together would let a resume silently re-arm an agent
  // whose cause was never addressed.
  const clearFailures = req.body?.clearFailures === true;
  const status = resumeTrading({ clearFailures });
  await appendEntry({ kind: 'config', payload: { action: 'resume', clearFailures } });
  res.json({
    ok: true,
    risk: status,
    // Resuming does not restart the loop. Arming trading and arming the scheduler
    // are different acts and conflating them has surprised people before.
    note: status.ok
      ? 'trading permitted again — POST /api/agent/loop/start to resume the loop'
      : `still blocked: ${status.blocked.join('; ')}`,
  });
});

/** Does the chain agree with our ledger? Read-only. */
agentRouter.get('/agent/reconcile', async (_req, res) => {
  try {
    const report = await reconcile();
    res.status(report.error ? 503 : 200).json({ ok: report.ok, report });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? String(err) });
  }
});

/** Live event stream for a dashboard, so every panel does not have to poll.
 *
 *  The proof chain stays the durable record — this is a push channel for whoever is
 *  currently watching. A client that missed an event reads it from /proof. */
/** Concurrent SSE streams allowed at once.
 *
 *  Every connection adds a listener and a 15-second keepalive timer, neither of which had
 *  a ceiling — and `publish` walks every listener from the TRADING path, so an unbounded
 *  subscriber list is iterated between a decision and its order. Held-open connections
 *  cost a client nothing to create and never expire on their own.
 *
 *  50 is far above any real dashboard count and far below a level that costs anything. */
const MAX_STREAMS = Number(process.env.SOMNUS_MAX_STREAMS ?? 50);

agentRouter.get('/agent/stream', (req, res) => {
  if (subscriberCount() >= MAX_STREAMS) {
    // A plain JSON refusal rather than an SSE frame: the client has not been upgraded to a
    // stream yet, so it can still read a normal body and a status code.
    res.status(503).json({
      ok: false,
      error:
        `${subscriberCount()} event streams are already open (limit ${MAX_STREAMS}). Each one is ` +
        'iterated on the trading path, so the cap is a trading-safety limit rather than a ' +
        'bandwidth one. Close an existing stream, or poll GET /agent/logs instead.',
    });
    return;
  }
  res.set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and friends buffer streaming responses by default, which turns an SSE
    // feed into a single reply that arrives when the connection closes.
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event: { kind: string; ts: number; data: unknown }): void => {
    res.write(`event: ${event.kind}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay the recent buffer so a client that connects mid-cycle has context
  // instead of an empty pane until the next tick.
  for (const e of recentEvents(20)) send(e);
  const unsubscribe = subscribe(send);

  // Comment frames keep proxies and load balancers from reaping an idle stream —
  // a cycle interval can be minutes, which most infrastructure reads as dead.
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
    res.end();
  });
});

/** Is the ledger consistent with the signed audit chain?
 *
 *  The proof chain is hash-linked, signed and anchored on-chain. pnl-ledger.jsonl —
 *  the file every risk limit reads — is plain appendable JSONL with no integrity
 *  guarantee at all, which is exactly backwards. Rather than bolt a second chain
 *  onto it, rebuild what the ledger SHOULD contain from the signed order entries and
 *  report the difference. A row in the ledger with no corresponding signed order is
 *  either an edit or a bug, and both are worth knowing about. */
agentRouter.get('/agent/pnl/verify', (_req, res) => {
  const result = verifyLedgerAgainstChain();
  res.json({ ...result, ok: result.ok });
});

function clamp(n: unknown, max: number): number {
  if (Array.isArray(n)) n = n[0];
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 1), max) : max;
}