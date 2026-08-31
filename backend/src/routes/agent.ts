import { Router } from 'express';
import { config } from '../config';
import { effectiveDryRun, loadAgentConfig, sanitize, saveAgentConfig } from '../agent-config';
import { runCycle, type RunOpts } from '../services/agent';
import { calibrationSummary } from '../services/horizon';
import { loopStatus, startLoop, stopLoop } from '../services/loop';
import { claimAll, findClaimable } from '../services/settlement';
import { appendEntry, currentAnchor, read } from '../services/store';
import { pnlSummary, pnlRecent } from '../services/pnl';
import { buildPerformanceReport } from '../services/report';
import { getPending, listPending, popPending } from '../services/pending';
import { executeDecision } from '../services/broker';
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
  const next = sanitize({ ...loadAgentConfig(), ...body } as AgentConfigDoc);

  // Rule changes are themselves part of the audit trail — you can prove what
  // the limits were at the moment any order was placed.
  await appendEntry({ kind: 'config', payload: { config: next } as Record<string, unknown> });
  saveAgentConfig(next);
  res.json({ ok: true, config: next, effectiveDryRun: effectiveDryRun(next) });
});

agentRouter.get('/agent/logs', (_req, res) => {
  const limit = clamp(_req.query.limit, 100);
  const entries = read(limit).reverse();
  res.json({
    ok: true,
    dryRun: effectiveDryRun(),
    anchor: currentAnchor(),
    entries,
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
    const hasEdge = Number.isFinite(Number(b.minEdge)) && Number(b.minEdge) > 0;
    // Mode optional: if not specified, treat as manual one-shot scan (loop stays off).
    const hasModeChoice = typeof b.autoTrade === 'boolean' || b.mode === 'manual' || b.mode === 'autotrade';

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

    // Manual — don't auto-execute, create pending for Yes/No with push
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
    const order = await executeDecision(p.decision);
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

function clamp(n: unknown, max: number): number {
  if (Array.isArray(n)) n = n[0];
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 1), max) : max;
}