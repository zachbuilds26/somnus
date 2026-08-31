import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, log, warn } from '../config';
import { loadAgentConfig, saveAgentConfig } from '../agent-config';
import { consecutiveLossStreak, realizedSince, utcDayKey, utcDayStart } from './pnl';
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
}

function emptyState(): RiskStateDoc {
  return { executionFailures: 0, failureDay: utcDayKey() };
}

function readState(): RiskStateDoc {
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<RiskStateDoc>;
    const failures = Number(raw.executionFailures);
    const state: RiskStateDoc = {
      executionFailures: Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : 0,
      failureDay: typeof raw.failureDay === 'string' ? raw.failureDay : utcDayKey(),
      lastFailureReason:
        typeof raw.lastFailureReason === 'string' ? raw.lastFailureReason.slice(0, 300) : undefined,
      lastFailureTs: Number.isFinite(Number(raw.lastFailureTs)) ? Number(raw.lastFailureTs) : undefined,
    };
    // Roll the counter over on a day boundary rather than at read time, so a
    // yesterday count can't keep an agent paused through a fresh session.
    if (state.failureDay !== utcDayKey()) return { ...emptyState(), lastFailureReason: state.lastFailureReason, lastFailureTs: state.lastFailureTs };
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
  lastFailureReason?: string;
  lastFailureTs?: number;
  limits: RiskLimits;
}

export function riskStatus(rules: AgentConfigDoc = loadAgentConfig()): RiskStatus {
  const state = readState();
  const realizedToday = realizedSince(utcDayStart());
  const lossToday = realizedToday < 0 ? Math.abs(realizedToday) : 0;
  const streak = consecutiveLossStreak();
  const blocked: string[] = [];

  if (rules.tradingPaused) {
    blocked.push(`trading paused: ${rules.pauseReason ?? 'no reason recorded'}`);
  }
  if (rules.maxDailyLoss > 0 && lossToday >= rules.maxDailyLoss) {
    blocked.push(`daily loss ${lossToday.toFixed(2)} >= limit ${rules.maxDailyLoss}`);
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
    lastFailureReason: state.lastFailureReason,
    lastFailureTs: state.lastFailureTs,
    limits: {
      maxTradeSize: rules.maxTradeSize,
      maxOpenPositions: rules.maxOpenPositions,
      maxPerMarket: rules.maxPerMarket,
      maxDailyLoss: rules.maxDailyLoss,
      maxConsecutiveLosses: rules.maxConsecutiveLosses,
      maxExecutionFailures: rules.maxExecutionFailures,
      maxDataAgeMs: rules.maxDataAgeMs,
      minEdge: rules.minEdge,
    },
  };
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
  return riskStatus(next);
}

/** Clear the kill switch. Deliberately does NOT clear the execution-failure
 *  counter or reinterpret the ledger: if the underlying condition still holds,
 *  `riskStatus` blocks again on the next order and the operator learns that the
 *  cause was never addressed. Use `clearExecutionFailures` explicitly for a venue
 *  problem that has been fixed. */
export function resumeTrading(): RiskStatus {
  const rules = loadAgentConfig();
  const next: AgentConfigDoc = { ...rules, tradingPaused: false };
  delete next.pauseReason;
  delete next.pausedAt;
  saveAgentConfig(next);
  log('trading resumed by operator');
  return riskStatus(next);
}

/** Count one live attempt that produced no position, and pause if that crosses
 *  the limit. Returns the new count. */
export function recordExecutionFailure(reason: string): number {
  const state = readState();
  const next: RiskStateDoc = {
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

/** A position was actually opened, so the venue and our crossing logic both work.
 *  Reset the failure counter — otherwise isolated failures accumulate across a
 *  healthy week and eventually pause an agent that is trading fine. */
export function clearExecutionFailures(): void {
  const state = readState();
  if (state.executionFailures === 0) return;
  writeState({ executionFailures: 0, failureDay: utcDayKey() });
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
