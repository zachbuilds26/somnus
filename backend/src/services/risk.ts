import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, log, warn } from '../config';
import { loadAgentConfig, saveAgentConfig } from '../agent-config';
import { consecutiveLossStreak, drawdownState, openNotional, realizedSince, utcDayKey, utcDayStart } from './pnl';
import { clockState } from './clock';
import { feedSourceAgeMs } from './sdk';
import { raiseAlert } from './alerts';
import type { AgentConfigDoc, DataFreshness } from '../types';

/** Circuit breakers — the layer between "the limits allow this trade" and "it is
 *  still sane to be trading at all".
 *
 *  The broker's existing gates bound ONE order: its size, its edge, its window,
 *  the open exposure it adds. None of them bound a bad session. A model that has
 *  gone wrong in the current regime passes every per-order check while losing
 *  every trade, and an unattended loop will keep paying for that until the
 *  collateral runs out. These breakers bound the damage a *sequence* can do:
 *
 *    - realised loss inside one UTC day               (maxDailyLoss)
 *    - newly settled losses in a row                  (maxConsecutiveLosses)
 *    - live attempts that produce no position         (maxExecutionFailures)
 *    - decisions taken on stale market data           (maxDataAgeMs)
 *    - an explicit operator stop                      (tradingPaused)
 *
 *  Tripping a breaker sets the persistent `tradingPaused` switch, so the pause
 *  survives a restart and cannot be lost by the process dying. Only an explicit
 *  operator action clears it: an agent that un-pauses itself after a loss streak
 *  has no brake at all. Pausing stops NEW risk — it never liquidates, and settled
 *  winners still claim normally through the usual settlement route. */

const STATE_FILE = join(DATA_DIR, 'risk-state.json');

/** How long the order-book feed may be dead before the agent refuses to trade.
 *  Generous enough to ride out an indexer blip, short enough that a real outage is
 *  caught within one settlement window rather than overnight. 0 disables. */
const BOOK_STALE_BLOCK_MS = Number(process.env.AGENT_BOOK_STALE_BLOCK_MS ?? 600_000);
const PROCESS_STARTED_AT = Date.now();

/** Operational counters that are not derivable from the P&L ledger.
 *
 *  Execution failures leave no ledger row by design (nothing filled), so they
 *  need their own durable home — otherwise a restart resets the counter and the
 *  breaker can never trip on a venue that fails every attempt. */
interface RiskStateDoc {
  executionFailures: number;
  /** UTC day the counter belongs to; a new day starts it over. */
  failureDay: string;
  lastFailureReason?: string;
  lastFailureTs?: number;
  /** When a settlement sweep last COMPLETED successfully. The loss breakers read
   *  the P&L ledger, and only a sweep writes settled outcomes into it — so without
   *  this timestamp there is no way to tell a genuinely flat day from a day whose
   *  losses were never recorded. */
  lastSweepOkTs?: number;
  lastSweepTs?: number;
  lastSweepError?: string;
}

function emptyState(): RiskStateDoc {
  return { executionFailures: 0, failureDay: utcDayKey() };
}

function readState(): RiskStateDoc {
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<RiskStateDoc>;
    const failures = Number(raw.executionFailures);
    const num = (v: unknown): number | undefined =>
      Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined;
    const state: RiskStateDoc = {
      executionFailures: Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : 0,
      failureDay: typeof raw.failureDay === 'string' ? raw.failureDay : utcDayKey(),
      lastFailureReason:
        typeof raw.lastFailureReason === 'string' ? raw.lastFailureReason.slice(0, 300) : undefined,
      lastFailureTs: Number.isFinite(Number(raw.lastFailureTs)) ? Number(raw.lastFailureTs) : undefined,
      lastSweepOkTs: num(raw.lastSweepOkTs),
      lastSweepTs: num(raw.lastSweepTs),
      lastSweepError:
        typeof raw.lastSweepError === 'string' ? raw.lastSweepError.slice(0, 300) : undefined,
    };
    // Roll the counter over on a day boundary rather than at read time, so a
    // yesterday count can't keep an agent paused through a fresh session. Sweep
    // state is NOT day-scoped — a sweep that last succeeded yesterday is stale
    // today, and forgetting that is how the gauge goes blind again.
    if (state.failureDay !== utcDayKey()) {
      return {
        ...emptyState(),
        lastFailureReason: state.lastFailureReason,
        lastFailureTs: state.lastFailureTs,
        lastSweepOkTs: state.lastSweepOkTs,
        lastSweepTs: state.lastSweepTs,
        lastSweepError: state.lastSweepError,
      };
    }
    return state;
  } catch {
    // A corrupt counter must not be readable as "zero failures" without saying so.
    warn('risk: state file unreadable — starting the failure counter from zero');
    return emptyState();
  }
}

function writeState(state: RiskStateDoc): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    // Never take the agent down over a counter write, but do not pretend it
    // persisted either.
    warn('risk: could not persist state:', (err as Error).message);
  }
}

export interface RiskLimits {
  maxTradeSize: number;
  maxOpenPositions: number;
  maxPerMarket: number;
  maxDailyLoss: number;
  maxOpenNotional: number;
  maxDrawdown: number;
  maxPerExpiryBucket: number;
  maxSameDirection: number;
  maxSettlementAgeMs: number;
  maxConsecutiveLosses: number;
  maxExecutionFailures: number;
  maxDataAgeMs: number;
  minEdge: number;
}

export interface RiskStatus {
  /** True when a new order is currently permitted by the breakers. */
  ok: boolean;
  paused: boolean;
  pauseReason?: string;
  pausedAt?: number;
  /** Human-readable reasons trading is blocked. Empty when ok. */
  blocked: string[];
  dayUtc: string;
  /** Realised P&L for the current UTC day. Negative = loss. */
  realizedToday: number;
  /** Magnitude of today's realised loss (0 when up on the day). */
  lossToday: number;
  consecutiveLosses: number;
  executionFailures: number;
  /** Collateral sitting in positions that have not settled yet. Reported rather
   *  than blocked on here: the broker enforces it per order, because the honest
   *  response to a nearly-full budget is a smaller trade, not a halt. */
  openNotional: number;
  /** Current realised distance below the equity peak. */
  drawdown: number;
  /** Age of the last SUCCESSFUL settlement sweep, ms. undefined = never ran, which
   *  counts as stale, not as fine. */
  settlementAgeMs?: number;
  lastSweepError?: string;
  /** Host-vs-chain clock skew in seconds, when measured. */
  clockSkewSec?: number;
  /** Age of the last successful order-book read, ms. undefined = never succeeded,
   *  which is blindness rather than freshness. */
  bookAgeMs?: number;
  lastFailureReason?: string;
  lastFailureTs?: number;
  limits: RiskLimits;
}

export function riskStatus(rules: AgentConfigDoc = loadAgentConfig()): RiskStatus {
  const state = readState();
  const realizedToday = realizedSince(utcDayStart());
  const lossToday = realizedToday < 0 ? Math.abs(realizedToday) : 0;
  const streak = consecutiveLossStreak();
  const open = openNotional();
  const dd = drawdownState();
  const clock = clockState();
  const settlementAgeMs =
    state.lastSweepOkTs === undefined ? undefined : Math.max(0, Date.now() - state.lastSweepOkTs);
  const blocked: string[] = [];

  if (rules.tradingPaused) {
    blocked.push(`trading paused: ${rules.pauseReason ?? 'no reason recorded'}`);
  }
  if (rules.maxDailyLoss > 0 && lossToday >= rules.maxDailyLoss) {
    blocked.push(`daily loss ${lossToday.toFixed(2)} >= limit ${rules.maxDailyLoss}`);
  }
  if (rules.maxDrawdown > 0 && dd.drawdown >= rules.maxDrawdown) {
    blocked.push(`drawdown ${dd.drawdown.toFixed(2)} from peak ${dd.peak.toFixed(2)} >= limit ${rules.maxDrawdown}`);
  }
  if (rules.maxConsecutiveLosses > 0 && streak >= rules.maxConsecutiveLosses) {
    blocked.push(`${streak} settled losses in a row >= limit ${rules.maxConsecutiveLosses}`);
  }
  if (rules.maxExecutionFailures > 0 && state.executionFailures >= rules.maxExecutionFailures) {
    blocked.push(
      `${state.executionFailures} execution failures today >= limit ${rules.maxExecutionFailures}` +
        (state.lastFailureReason ? ` (last: ${state.lastFailureReason})` : ''),
    );
  }

  // Unverifiable losses. Every loss limit above reads the P&L ledger, and only a
  // settlement sweep writes settled outcomes into it — so a stale sweep means those
  // limits are reading a number that stopped moving, not a number that is flat.
  // Only enforced while something is actually open: with no exposure there is
  // nothing to realise and a stale sweep is harmless.
  if (rules.maxSettlementAgeMs > 0 && open > 0) {
    if (settlementAgeMs === undefined) {
      blocked.push(
        'no settlement sweep has succeeded yet, so open positions cannot be graded — ' +
          'refusing to add risk on unverifiable P&L',
      );
    } else if (settlementAgeMs > rules.maxSettlementAgeMs) {
      blocked.push(
        `last settlement sweep ${Math.round(settlementAgeMs / 60_000)}m ago > limit ` +
          `${Math.round(rules.maxSettlementAgeMs / 60_000)}m — loss breakers are reading stale P&L` +
          (state.lastSweepError ? ` (last error: ${state.lastSweepError})` : ''),
      );
    }
  }

  // Expiry arithmetic is only as good as the clock behind it.
  if (clock.blocking && clock.skewSec !== undefined) {
    blocked.push(
      `host clock is ${clock.skewSec}s off chain time — window expiry decisions are unsafe`,
    );
  }

  // An agent that cannot read an order book cannot trade, full stop. Everything
  // downstream of the book — the edge, the size, the crossing price — is derived
  // from it, so a dead book feed is not a degraded agent, it is a stopped one.
  //
  // This existed as feed HEALTH but never as a blocking condition, and the alert only
  // fired when EVERY source failed. On 2 Sep the order books failed for twenty hours
  // while spot and candles stayed fine, so 4 of 5 sources were green and the service
  // reported `tradingAllowed: true, errors: 0` while placing nothing at all. Looking
  // healthy while being useless is the worst state an unattended process can be in.
  const bookAge = feedSourceAgeMs('book');
  if (BOOK_STALE_BLOCK_MS > 0) {
    if (bookAge === undefined) {
      // Never succeeded. At boot that is simply "not yet", so only block once the
      // process has been up long enough to have tried.
      if (Date.now() - PROCESS_STARTED_AT > BOOK_STALE_BLOCK_MS) {
        blocked.push('no order book has ever been read successfully — the agent is blind');
      }
    } else if (bookAge > BOOK_STALE_BLOCK_MS) {
      blocked.push(
        `no order book read in ${Math.round(bookAge / 60_000)}m — the agent is blind ` +
          '(every decision is derived from the book, so nothing can be priced)',
      );
    }
  }

  return {
    ok: blocked.length === 0,
    paused: rules.tradingPaused,
    pauseReason: rules.pauseReason,
    pausedAt: rules.pausedAt,
    blocked,
    dayUtc: utcDayKey(),
    realizedToday,
    lossToday,
    consecutiveLosses: streak,
    executionFailures: state.executionFailures,
    openNotional: open,
    drawdown: dd.drawdown,
    settlementAgeMs,
    lastSweepError: state.lastSweepError,
    clockSkewSec: clock.skewSec,
    bookAgeMs: bookAge,
    lastFailureReason: state.lastFailureReason,
    lastFailureTs: state.lastFailureTs,
    limits: {
      maxTradeSize: rules.maxTradeSize,
      maxOpenPositions: rules.maxOpenPositions,
      maxPerMarket: rules.maxPerMarket,
      maxDailyLoss: rules.maxDailyLoss,
      maxOpenNotional: rules.maxOpenNotional,
      maxDrawdown: rules.maxDrawdown,
      maxPerExpiryBucket: rules.maxPerExpiryBucket,
      maxSameDirection: rules.maxSameDirection,
      maxSettlementAgeMs: rules.maxSettlementAgeMs,
      maxConsecutiveLosses: rules.maxConsecutiveLosses,
      maxExecutionFailures: rules.maxExecutionFailures,
      maxDataAgeMs: rules.maxDataAgeMs,
      minEdge: rules.minEdge,
    },
  };
}

/** Persist the outcome of a settlement sweep, success or failure.
 *
 *  `lastSweepOkTs` only advances on success: a sweep that ran and threw has not
 *  refreshed the ledger, and recording the attempt as if it had is precisely how a
 *  blind breaker looks healthy. */
export function recordSweep(result: { ts: number; error?: string }): void {
  const state = readState();
  writeState({
    ...state,
    lastSweepTs: result.ts,
    ...(result.error ? { lastSweepError: result.error.slice(0, 300) } : { lastSweepOkTs: result.ts, lastSweepError: undefined }),
  });
}

/** Persist the kill switch. Idempotent: a breaker that trips twice does not
 *  overwrite the original reason, because the FIRST cause is the one worth
 *  keeping — later ones are usually consequences of it. */
export function pauseTrading(reason: string): RiskStatus {
  const rules = loadAgentConfig();
  if (rules.tradingPaused) return riskStatus(rules);
  const next: AgentConfigDoc = {
    ...rules,
    tradingPaused: true,
    pauseReason: reason,
    pausedAt: Date.now(),
  };
  saveAgentConfig(next);
  warn(`TRADING PAUSED — ${reason}`);
  // A halt nobody hears about is a halt you discover in the morning. This is the
  // single most important alert this process can send.
  raiseAlert({
    level: 'critical',
    key: 'trading-paused',
    title: `trading PAUSED — ${reason}`,
    detail: { reason, pausedAt: next.pausedAt },
  });
  return riskStatus(next);
}

/** Clear the kill switch.
 *
 *  By default this does NOT clear the execution-failure counter or reinterpret the
 *  ledger: if the underlying condition still holds, `riskStatus` blocks again on the
 *  next order and the operator learns that the cause was never addressed.
 *
 *  But it has to be POSSIBLE to clear it, and for a long time it was not — this
 *  function had no caller at all, and neither did `clearExecutionFailures`, so an
 *  execution-failure pause could only be undone by hand-editing
 *  data/risk-state.json. `clearFailures` exists for the case the counter is
 *  measuring a venue problem that has since been fixed, and it is deliberately an
 *  explicit, separate decision rather than a side effect of resuming.            */
export function resumeTrading(opts: { clearFailures?: boolean } = {}): RiskStatus {
  const rules = loadAgentConfig();
  const next: AgentConfigDoc = { ...rules, tradingPaused: false };
  delete next.pauseReason;
  delete next.pausedAt;
  saveAgentConfig(next);
  if (opts.clearFailures) clearExecutionFailures(true);
  log(`trading resumed by operator${opts.clearFailures ? ' (execution-failure counter reset)' : ''}`);
  raiseAlert({
    level: 'info',
    key: 'trading-resumed',
    title: 'trading resumed by operator',
    detail: { clearedFailures: Boolean(opts.clearFailures) },
  });
  return riskStatus(next);
}

/** Count one live attempt that produced no position, and pause if that crosses
 *  the limit. Returns the new count. */
export function recordExecutionFailure(reason: string): number {
  const state = readState();
  const next: RiskStateDoc = {
    ...state,
    executionFailures: state.executionFailures + 1,
    failureDay: utcDayKey(),
    lastFailureReason: reason.slice(0, 300),
    lastFailureTs: Date.now(),
  };
  writeState(next);
  const rules = loadAgentConfig();
  if (rules.maxExecutionFailures > 0 && next.executionFailures >= rules.maxExecutionFailures) {
    pauseTrading(
      `${next.executionFailures} live attempts produced no position today (last: ${next.lastFailureReason})`,
    );
  }
  return next.executionFailures;
}

/** Reset the failure counter.
 *
 *  Called automatically when a position actually opens — the venue and our crossing
 *  logic both demonstrably work, and isolated failures should not accumulate across
 *  a healthy week until they pause an agent that is trading fine. Also callable
 *  explicitly by an operator resuming from a venue problem they have fixed. */
export function clearExecutionFailures(force = false): void {
  const state = readState();
  if (state.executionFailures === 0 && !force) return;
  writeState({
    ...state,
    executionFailures: 0,
    failureDay: utcDayKey(),
    lastFailureReason: undefined,
    lastFailureTs: undefined,
  });
}

/** Trip the loss breakers if the freshly-settled ledger now crosses a limit.
 *  Called after settlement, so a bad session stops the agent at the moment the
 *  loss becomes real rather than on the next cycle's first order. */
export function reviewAfterSettlement(): RiskStatus {
  const rules = loadAgentConfig();
  const status = riskStatus(rules);
  if (status.ok || status.paused) return status;
  return pauseTrading(status.blocked.join('; '));
}

/** Is the market data behind a decision fresh enough to act on?
 *
 *  Missing ages count as STALE, not fine. An unknown timestamp is exactly the
 *  case where we cannot show the data was current, and a five-minute contract is
 *  the wrong place to give the benefit of the doubt. */
export function dataFresh(
  freshness: DataFreshness | undefined,
  maxDataAgeMs: number,
): { ok: boolean; reason?: string } {
  if (maxDataAgeMs <= 0) return { ok: true };
  if (!freshness) return { ok: false, reason: 'no data-freshness information on the decision' };

  const checks: Array<[string, number | undefined]> = [
    ['spot', freshness.spotAgeMs],
    ['candles', freshness.candleAgeMs],
    ['book', freshness.bookAgeMs],
  ];
  for (const [name, age] of checks) {
    if (age === undefined) return { ok: false, reason: `${name} age unknown` };
    if (age > maxDataAgeMs) {
      return { ok: false, reason: `${name} data ${Math.round(age / 1000)}s old > limit ${Math.round(maxDataAgeMs / 1000)}s` };
    }
  }
  return { ok: true };
}

/** Test-only: drop the persisted counter so cases start from a known state. */
export function __resetRiskStateForTests(): void {
  writeState(emptyState());
}
