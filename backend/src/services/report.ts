import { loadAgentConfig } from '../agent-config';
import { calibrationSummary } from './horizon';
import { pnlSummary, settledTrades } from './pnl';
import { riskStatus } from './risk';
import { feedHealthReport } from './sdk';
import { loopStatus } from './loop';

/**
 * Performance report — what the agent has actually done, and what it should do next.
 *
 * P&L alone says "up or down". A useful report splits that number so an operator
 * can tell luck from edge, and regime from noise:
 *  - realised vs open, win rate vs expected wins (price-implied)
 *  - by horizon tier (validated vs provisional), by asset, by cheap-tail vs core
 *  - whether the circuit breakers are close to tripping
 *  - whether the data inputs behind the decisions were fresh
 *
 * The recommendation is deliberately conservative: it prefers "pause and look" over
 * "keep trading and hope", because the cost of a wrong recommendation is real money.
 */

export type RecommendationLevel = 'halt' | 'caution' | 'observe' | 'continue';

export interface PerformanceReport {
  generatedAt: number;
  config: ReturnType<typeof loadAgentConfig>;
  pnl: ReturnType<typeof pnlSummary>;
  risk: ReturnType<typeof riskStatus>;
  feeds: ReturnType<typeof feedHealthReport>;
  loop: ReturnType<typeof loopStatus>;
  calibration: ReturnType<typeof calibrationSummary>;
  breakdown: {
    byHorizon: Array<{
      horizon: string;
      tier: string;
      trades: number;
      wins: number;
      losses: number;
      winRate: number;
      pnl: number;
      avgCost: number;
      avgPayout: number;
    }>;
    byAsset: Array<{
      asset: string;
      trades: number;
      wins: number;
      losses: number;
      winRate: number;
      pnl: number;
    }>;
    byTier: Array<{
      tier: string;
      trades: number;
      wins: number;
      losses: number;
      winRate: number;
      pnl: number;
    }>;
  };
  samples: {
    settled: ReturnType<typeof settledTrades>;
    recent: ReturnType<typeof settledTrades>;
  };
  recommendation: {
    level: RecommendationLevel;
    action: string;
    reasons: string[];
    suggestedConfig?: Partial<Record<string, number | string>>;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildPerformanceReport(): PerformanceReport {
  const config = loadAgentConfig();
  const pnl = pnlSummary();
  const risk = riskStatus(config);
  const feeds = feedHealthReport();
  const loop = loopStatus();
  const calibration = calibrationSummary();
  const settled = settledTrades();

  // Group settled trades. Strategy attribution exists only on fills recorded after
  // the attribution shipped — older rows count toward totals but cannot be sliced.
  const byHorizon = new Map<string, { tier: string; wins: number; losses: number; pnl: number; cost: number; payout: number }>();
  const byAsset = new Map<string, { wins: number; losses: number; pnl: number }>();
  const byTier = new Map<string, { wins: number; losses: number; pnl: number }>();

  for (const t of settled) {
    const h = t.strategy?.horizon ?? 'unknown';
    const tier = t.strategy?.horizonTier ?? 'unattributed';
    const asset = t.strategy?.asset ?? (t.symbol?.split('-')[0] ?? 'unknown').toUpperCase();

    const hk = `${h}|${tier}`;
    const hEntry = byHorizon.get(hk) ?? { tier, wins: 0, losses: 0, pnl: 0, cost: 0, payout: 0 };
    if (t.won) hEntry.wins++;
    else hEntry.losses++;
    hEntry.pnl += t.pnl;
    hEntry.cost += t.cost;
    hEntry.payout += t.payout;
    byHorizon.set(hk, hEntry);

    const aEntry = byAsset.get(asset) ?? { wins: 0, losses: 0, pnl: 0 };
    if (t.won) aEntry.wins++;
    else aEntry.losses++;
    aEntry.pnl += t.pnl;
    byAsset.set(asset, aEntry);

    const tk = tier;
    const tEntry = byTier.get(tk) ?? { wins: 0, losses: 0, pnl: 0 };
    if (t.won) tEntry.wins++;
    else tEntry.losses++;
    tEntry.pnl += t.pnl;
    byTier.set(tk, tEntry);
  }

  const byHorizonRows = [...byHorizon.entries()]
    .map(([key, v]) => {
      const [horizon] = key.split('|');
      const trades = v.wins + v.losses;
      return {
        horizon: horizon!,
        tier: v.tier,
        trades,
        wins: v.wins,
        losses: v.losses,
        winRate: trades > 0 ? round2(v.wins / trades) : 0,
        pnl: round2(v.pnl),
        avgCost: trades > 0 ? round2(v.cost / trades) : 0,
        avgPayout: trades > 0 ? round2(v.payout / trades) : 0,
      };
    })
    .sort((a, b) => b.trades - a.trades);

  const byAssetRows = [...byAsset.entries()]
    .map(([asset, v]) => {
      const trades = v.wins + v.losses;
      return { asset, trades, wins: v.wins, losses: v.losses, winRate: trades > 0 ? round2(v.wins / trades) : 0, pnl: round2(v.pnl) };
    })
    .sort((a, b) => b.trades - a.trades);

  const byTierRows = [...byTier.entries()]
    .map(([tier, v]) => {
      const trades = v.wins + v.losses;
      return { tier, trades, wins: v.wins, losses: v.losses, winRate: trades > 0 ? round2(v.wins / trades) : 0, pnl: round2(v.pnl) };
    })
    .sort((a, b) => b.trades - a.trades);

  // Recommendation — conservative, evidence-first.
  const reasons: string[] = [];
  let level: RecommendationLevel = 'continue';
  let action = 'Continue trading under current limits.';
  let suggestedConfig: PerformanceReport['recommendation']['suggestedConfig'] | undefined;

  const blocked = risk.blocked;
  const failingFeeds = feeds.failing;
  const hasSettled = settled.length > 0;

  // 1. Hard stops outrank everything — the agent is already refusing orders.
  if (blocked.length > 0) {
    level = 'halt';
    action = `Trading is blocked — ${blocked.join('; ')}. Resolve the cause before resuming.`;
    reasons.push(...blocked.map((b) => `blocked: ${b}`));
    if (risk.paused && risk.pauseReason) reasons.push(`kill switch: ${risk.pauseReason}`);
  } else if (risk.lossToday > 0 && config.maxDailyLoss > 0) {
    const remaining = config.maxDailyLoss - risk.lossToday;
    const pct = risk.lossToday / config.maxDailyLoss;
    if (pct >= 0.8) {
      level = 'caution';
      action = `Daily loss ${risk.lossToday.toFixed(2)} is at ${Math.round(pct * 100)}% of the ${config.maxDailyLoss} limit — consider tightening maxTradeSize or widening minEdge.`;
      reasons.push(`daily loss ${risk.lossToday.toFixed(2)} / ${config.maxDailyLoss}`);
    } else if (pct >= 0.5) {
      reasons.push(`daily loss ${risk.lossToday.toFixed(2)} / ${config.maxDailyLoss} — still inside the limit but worth watching`);
    }
  }

  // 2. Feed health — a blind agent that still trades is worse than a paused one.
  if (level !== 'halt' && failingFeeds > 0) {
    const worst = feeds.sources.filter((s) => !s.ok).map((s) => `${s.source} (${s.error ?? 'failing'})`);
    if (level === 'continue') level = 'caution';
    reasons.push(`feed degraded: ${worst.join(', ')}`);
    // If every source is stale the loop's tickFeedHealth will rebuild, but until
    // then the broker's stale-data gate will reject every execution — which reads as
    // silent inaction unless called out here.
    if (feeds.sources.every((s) => !s.ok)) {
      level = 'halt';
      action = 'All market-data feeds are failing — trading is blind. Check INDEXER_URL / oracle connectivity.';
    } else if (action.startsWith('Continue')) {
      action = 'Feeds are degraded — the freshness gate will reject stale executions until they recover.';
    }
  }

  // 3. Consecutive losses — cheapest regime-disagreement signal.
  if (level !== 'halt' && config.maxConsecutiveLosses > 0 && risk.consecutiveLosses > 0) {
    if (risk.consecutiveLosses >= config.maxConsecutiveLosses - 1) {
      if (level === 'continue') level = 'caution';
      reasons.push(`${risk.consecutiveLosses} settled losses in a row — one more triggers the breaker`);
      suggestedConfig = { maxTradeSize: Math.max(1, Math.floor(config.maxTradeSize * 0.5)), minEdge: round2(config.minEdge * 1.5) };
    } else if (risk.consecutiveLosses >= 2) {
      reasons.push(`${risk.consecutiveLosses} losses in a row — still inside the limit but the streak is growing`);
    }
  }

  // 4. Execution failures — venue or crossing problem, not a model problem.
  if (level !== 'halt' && config.maxExecutionFailures > 0 && risk.executionFailures > 0) {
    if (risk.executionFailures >= config.maxExecutionFailures - 1) {
      if (level === 'continue') level = 'caution';
      reasons.push(`${risk.executionFailures} live attempts produced no position today — crossing or venue issue likely`);
      if (risk.lastFailureReason) reasons.push(`last failure: ${risk.lastFailureReason}`);
    } else {
      reasons.push(`${risk.executionFailures} execution failures today`);
    }
  }

  // 5. P&L-based guidance — only when we have settled samples to judge.
  if (level !== 'halt' && hasSettled) {
    const expectedNote = (() => {
      // Price-implied expected wins is not stored here (needs order prices from the
      // proof chain), so we approximate with win rate vs 0.5 and realised P&L sign.
      // Full luck-vs-bias is `npm run score` / `npm run luck` — this is the live hint.
      if (pnl.realizedPnl < 0 && pnl.winRate < 0.4 && pnl.closedTrades >= 20) {
        return 'negative_bias';
      }
      if (pnl.realizedPnl > 0 && pnl.winRate > 0.55 && pnl.closedTrades >= 20) {
        return 'positive_edge';
      }
      return 'inconclusive';
    })();

    if (pnl.closedTrades < 10) {
      if (level === 'continue') level = 'observe';
      reasons.push(`only ${pnl.closedTrades} settled trades — too few to judge edge; provisional sizing is still appropriate`);
      if (action.startsWith('Continue')) action = 'Collecting baseline — provisional tiers trade at reduced stake until n ≥ 40 per class.';
    } else if (expectedNote === 'negative_bias') {
      if (level === 'continue') level = 'caution';
      reasons.push(`realised P&L ${pnl.realizedPnl} over ${pnl.closedTrades} settled trades, win rate ${(pnl.winRate * 100).toFixed(1)}% — paying for outcomes that happen less often than price implies`);
      suggestedConfig = suggestedConfig ?? { minEdge: round2(Math.min(0.08, config.minEdge * 1.5)), maxTradeSize: Math.max(1, Math.floor(config.maxTradeSize * 0.7)) };
      action = 'Edge not surviving execution — raise minEdge and reduce stake, then re-run horizon-study before promoting provisional classes.';
    } else if (expectedNote === 'positive_edge') {
      reasons.push(`realised P&L +${pnl.realizedPnl} over ${pnl.closedTrades} trades, win rate ${(pnl.winRate * 100).toFixed(1)}% — beating the market on this sample`);
    } else if (pnl.realizedPnl < 0 && pnl.closedTrades >= 20) {
      reasons.push(`realised P&L ${pnl.realizedPnl} — still inside noise on this sample size; keep provisional limits until n ≥ 40`);
    }

    // Per-asset or per-tier loss concentration — hint at where the damage is.
    const worstTier = byTierRows.find((r) => r.pnl < 0 && r.trades >= 5);
    if (worstTier) {
      reasons.push(`${worstTier.tier} tier is underwater (${worstTier.pnl} over ${worstTier.trades} trades) — consider disabling or reducing that regime`);
    }
    const worstAsset = byAssetRows.find((r) => r.pnl < -5 && r.trades >= 5);
    if (worstAsset) {
      reasons.push(`${worstAsset.asset} sleeve is ${worstAsset.pnl} over ${worstAsset.trades} trades`);
    }
  }

  // 6. Loop health — agent thought to be running but actually wedged.
  if (loop.running && loop.busy && loop.lastRunAt !== undefined && Date.now() - loop.lastRunAt > 600_000) {
    if (level === 'continue') level = 'caution';
    reasons.push(`loop reports busy but last cycle finished ${Math.round((Date.now() - loop.lastRunAt) / 60000)}m ago — possible wedged cycle`);
  }

  if (reasons.length === 0) {
    if (pnl.closedTrades === 0) {
      level = 'observe';
      action = 'No settled trades yet — agent is observing. Provisional tiers trade small until calibration accumulates.';
      reasons.push('no settled trades to grade');
    } else {
      reasons.push(`win rate ${(pnl.winRate * 100).toFixed(1)}%, realised ${pnl.realizedPnl >= 0 ? '+' : ''}${pnl.realizedPnl} over ${pnl.closedTrades} settled trades — within limits`);
    }
    if (feeds.failing === 0) reasons.push('all feeds fresh');
    if (blocked.length === 0) reasons.push('no circuit breaker tripped');
  }

  return {
    generatedAt: Date.now(),
    config,
    pnl,
    risk,
    feeds,
    loop,
    calibration,
    breakdown: { byHorizon: byHorizonRows, byAsset: byAssetRows, byTier: byTierRows },
    samples: { settled, recent: settled.slice(-20).reverse() },
    recommendation: { level, action, reasons, suggestedConfig },
  };
}
