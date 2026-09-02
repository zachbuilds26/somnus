import { Router } from 'express';
import { config } from '../config';
import { loadAgentConfig } from '../agent-config';
import { calibrationSummary } from '../services/horizon';
import { loopStatus } from '../services/loop';
import { pnlSummary } from '../services/pnl';
import { riskStatus } from '../services/risk';
import { feedHealthReport } from '../services/sdk';
import { clockState } from '../services/clock';
import { count } from '../services/store';
import { subscriberCount } from '../services/events';

export const metricsRouter: Router = Router();

/** Prometheus scrape endpoint.
 *
 *  /health answers "is it up" for a human or a load balancer. It cannot answer "was
 *  the win rate falling for six hours before it halted", because nothing was
 *  recording it — the only history this process kept was log files nobody graphs.
 *  Everything here is state the process already holds; the value is in it being
 *  sampled over time rather than at the moment someone happens to look.
 *
 *  Read-only, no key required: these are the same numbers /health serves, and a
 *  scraper that needs credentials on every target usually just gets skipped.     */
metricsRouter.get('/metrics', (_req, res) => {
  const rules = loadAgentConfig();
  const risk = riskStatus(rules);
  const pnl = pnlSummary();
  const loop = loopStatus();
  const feeds = feedHealthReport();
  const clock = clockState();
  const cal = calibrationSummary();

  const out: string[] = [];
  const metric = (
    name: string,
    help: string,
    type: 'gauge' | 'counter',
    value: number | undefined,
    labels?: Record<string, string>,
  ): void => {
    if (value === undefined || !Number.isFinite(value)) return;
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    const label = labels
      ? `{${Object.entries(labels)
          .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
          .join(',')}}`
      : '';
    out.push(`${name}${label} ${value}`);
  };
  const series = (
    name: string,
    help: string,
    type: 'gauge' | 'counter',
    rows: Array<{ labels: Record<string, string>; value: number }>,
  ): void => {
    if (rows.length === 0) return;
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    for (const r of rows) {
      const label = `{${Object.entries(r.labels)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
        .join(',')}}`;
      out.push(`${name}${label} ${r.value}`);
    }
  };

  metric('somnus_up', 'Always 1 while the process serves requests.', 'gauge', 1, {
    network: config.network,
    mode: rules.mode,
  });
  metric('somnus_dry_run', '1 when no order can reach the chain.', 'gauge', config.dryRun || rules.mode !== 'live' ? 1 : 0);

  // Risk posture — the series worth alerting on.
  metric('somnus_trading_allowed', '1 when the breakers currently permit a new order.', 'gauge', risk.ok ? 1 : 0);
  metric('somnus_trading_paused', '1 while the kill switch is set.', 'gauge', risk.paused ? 1 : 0);
  metric('somnus_blocked_reasons', 'How many distinct conditions are blocking trading.', 'gauge', risk.blocked.length);
  metric('somnus_loss_today', 'Realised loss so far this UTC day, tUSDC.', 'gauge', risk.lossToday);
  metric('somnus_drawdown', 'Realised distance below the equity peak, tUSDC.', 'gauge', risk.drawdown);
  metric('somnus_consecutive_losses', 'Settled losses in a row.', 'gauge', risk.consecutiveLosses);
  metric('somnus_execution_failures', 'Live attempts today that produced no position.', 'gauge', risk.executionFailures);
  metric('somnus_open_notional', 'Collateral in positions that have not settled, tUSDC.', 'gauge', risk.openNotional);
  metric('somnus_settlement_age_seconds', 'Age of the last successful settlement sweep.', 'gauge',
    risk.settlementAgeMs === undefined ? undefined : Math.round(risk.settlementAgeMs / 1000));
  metric('somnus_book_age_seconds', 'Age of the last order book read successfully. Blind above the block threshold.', 'gauge',
    risk.bookAgeMs === undefined ? undefined : Math.round(risk.bookAgeMs / 1000));

  // Limits, so a dashboard can draw the ceiling next to the value.
  metric('somnus_limit_max_daily_loss', 'Configured daily loss ceiling.', 'gauge', rules.maxDailyLoss);
  metric('somnus_limit_max_open_notional', 'Configured open exposure ceiling.', 'gauge', rules.maxOpenNotional);
  metric('somnus_limit_max_drawdown', 'Configured drawdown ceiling (0 = off).', 'gauge', rules.maxDrawdown);
  metric('somnus_limit_max_trade_size', 'Configured per-trade ceiling.', 'gauge', rules.maxTradeSize);
  metric('somnus_limit_min_edge', 'Configured minimum edge.', 'gauge', rules.minEdge);

  // Performance.
  metric('somnus_pnl_realized', 'Realised P&L over the settled ledger, tUSDC.', 'gauge', pnl.realizedPnl);
  metric('somnus_pnl_open_cost', 'Cost basis of open positions, tUSDC.', 'gauge', pnl.openCost);
  metric('somnus_gas_spent_native', 'Gas spent across all recorded transactions, native token.', 'counter', pnl.gasSpentNative);
  metric('somnus_trades_closed', 'Positions that have both filled and settled.', 'counter', pnl.closedTrades);
  metric('somnus_trades_won', 'Settled positions that won.', 'counter', pnl.wins);
  metric('somnus_trades_lost', 'Settled positions that lost.', 'counter', pnl.losses);
  metric('somnus_win_rate', 'Wins over closed trades.', 'gauge', pnl.winRate);
  metric('somnus_fills_total', 'Fills recorded on the ledger.', 'counter', pnl.totalFills);

  // Runtime.
  metric('somnus_loop_running', '1 while the autonomous loop is armed.', 'gauge', loop.running ? 1 : 0);
  metric('somnus_loop_busy', '1 while a cycle is in flight.', 'gauge', loop.busy ? 1 : 0);
  metric('somnus_loop_cycles', 'Cycles completed since start.', 'counter', loop.cycles);
  metric('somnus_loop_errors', 'Cycles that threw since start.', 'counter', loop.errors);
  metric('somnus_loop_interval_ms', 'Configured cycle interval.', 'gauge', loop.intervalMs);
  metric('somnus_last_cycle_age_seconds', 'Time since the last cycle finished.', 'gauge',
    loop.lastRunAt === undefined ? undefined : Math.round((Date.now() - loop.lastRunAt) / 1000));

  metric('somnus_proof_entries', 'Entries in the audit chain.', 'counter', count());
  metric('somnus_event_subscribers', 'Clients attached to the SSE stream.', 'gauge', subscriberCount());
  metric('somnus_clock_skew_seconds', 'Host clock minus chain time.', 'gauge', clock.skewSec);

  // Per-feed health: this is the series that answers "which input went quiet".
  series(
    'somnus_feed_ok',
    '1 when a market-data source last read successfully.',
    'gauge',
    feeds.sources.map((s) => ({ labels: { source: s.source }, value: s.ok ? 1 : 0 })),
  );
  series(
    'somnus_feed_age_seconds',
    'Age of the last successful read per source.',
    'gauge',
    feeds.sources
      .filter((s) => s.ageMs !== undefined)
      .map((s) => ({ labels: { source: s.source }, value: Math.round((s.ageMs as number) / 1000) })),
  );
  series(
    'somnus_horizon_tier',
    'Per-window-class verdict: 2 validated, 1 provisional, 0 blocked.',
    'gauge',
    cal.classes.map((c) => ({
      labels: { class: c.class, source: cal.source },
      value: c.tier === 'validated' ? 2 : c.tier === 'provisional' ? 1 : 0,
    })),
  );
  series(
    'somnus_horizon_samples',
    'Settled windows scored per class.',
    'gauge',
    cal.classes.map((c) => ({ labels: { class: c.class }, value: c.n })),
  );

  res.set('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(`${out.join('\n')}\n`);
});
