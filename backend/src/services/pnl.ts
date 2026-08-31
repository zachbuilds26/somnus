import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config';
import type { FillStrategyMeta } from '../types';

/** Running P&L ledger — the one thing the agent was missing for a judge to see
 *  whether it actually makes money.
 *
 *  Cost basis is recorded the moment a fill is accepted (price x size), keyed by
 *  market + outcome so it can be matched to the settlement. When a position is
 *  later redeemed (winner) or found settled-and-lost, the difference is realised
 *  P&L. Losers that we never actually traded are ignored, so the ledger only ever
 *  reflects positions Somnus took.                                                  */

const LEDGER = join(DATA_DIR, 'pnl-ledger.jsonl');

interface FillRow {
  t: 'fill';
  marketId: string;
  outcomeIdx: 0 | 1;
  size: number;
  cost: number;
  ts: number;
  userId?: number;
  symbol?: string;
  /** Decision + execution context, present on fills recorded after strategy
   *  attribution shipped. Absent on older rows — those still count toward P&L
   *  but are reported as unattributable rather than reconstructed by guesswork. */
  strategy?: FillStrategyMeta;
}
interface SettleRow {
  t: 'settle';
  marketId: string;
  outcomeIdx: 0 | 1;
  payout: number;
  won: boolean;
  ts: number;
}
type Row = FillRow | SettleRow;

function keyOf(marketId: string, outcomeIdx: 0 | 1): string {
  return `${marketId}:${outcomeIdx}`;
}

function append(row: Row): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LEDGER, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // storage failure must not take down the agent loop
  }
}

function readAll(): Row[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l) as Row;
      } catch {
        return null;
      }
    })
    .filter((r): r is Row => r !== null);
}

/** Record the cost of an accepted fill. `cost` is collateral spent (price x size),
 *  identical whether the Up or Down outcome was bought. */
export function recordFill(
  marketId: string,
  outcomeIdx: 0 | 1,
  size: number,
  cost: number,
  meta?: { userId?: number; symbol?: string; strategy?: FillStrategyMeta },
): void {
  if (!(cost > 0)) return;
  append({ t: 'fill', marketId, outcomeIdx, size, cost, ts: Date.now(), ...meta });
}

/** Record a settled position. Idempotent (a market+outcome is only ever settled
 *  once) and a no-op if we never traded that side, so re-running a claim scan can
 *  never double-count or invent losses. */
export function recordSettlement(marketId: string, outcomeIdx: 0 | 1, payout: number, won: boolean): void {
  const key = keyOf(marketId, outcomeIdx);
  const all = readAll();
  if (!all.some((r) => r.t === 'fill' && keyOf(r.marketId, r.outcomeIdx) === key)) return;
  if (all.some((r) => r.t === 'settle' && keyOf(r.marketId, r.outcomeIdx) === key)) return;
  append({ t: 'settle', marketId, outcomeIdx, payout, won, ts: Date.now() });
}

export interface PnlSummary {
  totalFills: number;
  totalFillCost: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  openCost: number;
  claimedPayout: number;
}

export function pnlSummary(): PnlSummary {
  const rows = readAll();
  let totalFills = 0;
  let totalFillCost = 0;
  const costByKey = new Map<string, number>();
  const settleKeys = new Set<string>();
  let claimedPayout = 0;
  let wins = 0;
  let losses = 0;

  for (const r of rows) {
    if (r.t === 'fill') {
      totalFills++;
      totalFillCost += r.cost;
      const k = keyOf(r.marketId, r.outcomeIdx);
      costByKey.set(k, (costByKey.get(k) ?? 0) + r.cost);
    } else {
      const k = keyOf(r.marketId, r.outcomeIdx);
      settleKeys.add(k);
      if (r.won) {
        claimedPayout += r.payout;
        wins++;
      } else {
        losses++;
      }
    }
  }

  let settledCost = 0;
  for (const k of settleKeys) settledCost += costByKey.get(k) ?? 0;
  const openCost = totalFillCost - settledCost;
  const realizedPnl = claimedPayout - settledCost;
  const closed = settleKeys.size;

  return {
    totalFills,
    totalFillCost: round2(totalFillCost),
    closedTrades: closed,
    wins,
    losses,
    winRate: closed > 0 ? wins / closed : 0,
    realizedPnl: round2(realizedPnl),
    openCost: round2(Math.max(0, openCost)),
    claimedPayout: round2(claimedPayout),
  };
}

export function pnlRecent(n = 25): Row[] {
  return readAll().slice(-n).reverse();
}

/** One position that has been both filled and settled — the unit every risk
 *  breaker and every performance report is computed from.
 *
 *  Joined on `marketId + outcomeIdx` rather than on symbol or timestamp: pools are
 *  recycled between windows and symbol wording has changed upstream before, so the
 *  id pair is the only key that cannot silently match the wrong trade. */
export interface SettledTrade {
  marketId: string;
  outcomeIdx: 0 | 1;
  size: number;
  /** Collateral actually spent. */
  cost: number;
  /** Collateral returned (0 on a loser). */
  payout: number;
  won: boolean;
  /** payout - cost. Negative = loss. */
  pnl: number;
  fillTs: number;
  settleTs: number;
  symbol?: string;
  strategy?: FillStrategyMeta;
}

/** Every settled position, oldest settlement first.
 *
 *  A market+outcome can hold several fills (different cycles, `maxPerMarket` > 1),
 *  so costs are summed and the earliest fill timestamp is kept — otherwise a
 *  second fill would look like a second trade sharing one settlement and the
 *  win/loss count would drift above the number of positions actually held. */
export function settledTrades(): SettledTrade[] {
  const rows = readAll();
  const fills = new Map<
    string,
    { cost: number; size: number; firstTs: number; symbol?: string; strategy?: FillStrategyMeta }
  >();
  for (const r of rows) {
    if (r.t !== 'fill') continue;
    const k = keyOf(r.marketId, r.outcomeIdx);
    const prev = fills.get(k);
    fills.set(k, {
      cost: (prev?.cost ?? 0) + r.cost,
      size: (prev?.size ?? 0) + r.size,
      firstTs: prev ? Math.min(prev.firstTs, r.ts) : r.ts,
      symbol: prev?.symbol ?? r.symbol,
      // Keep the FIRST decision's context: it is the one the position was opened on.
      strategy: prev?.strategy ?? r.strategy,
    });
  }

  const out: SettledTrade[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.t !== 'settle') continue;
    const k = keyOf(r.marketId, r.outcomeIdx);
    if (seen.has(k)) continue; // recordSettlement is idempotent, but never trust it twice
    const f = fills.get(k);
    if (!f) continue; // settled something we never traded — not ours to count
    seen.add(k);
    out.push({
      marketId: r.marketId,
      outcomeIdx: r.outcomeIdx,
      size: f.size,
      cost: round2(f.cost),
      payout: round2(r.payout),
      won: r.won,
      pnl: round2(r.payout - f.cost),
      fillTs: f.firstTs,
      settleTs: r.ts,
      symbol: f.symbol,
      strategy: f.strategy,
    });
  }
  return out.sort((a, b) => a.settleTs - b.settleTs);
}

/** Realised P&L for positions that settled at or after `sinceMs`. Negative = loss.
 *  Attributed to SETTLEMENT time, not fill time: a loss is only real once the
 *  window resolves, and a daily limit has to bound the losses the day actually
 *  produced. */
export function realizedSince(sinceMs: number): number {
  const total = settledTrades()
    .filter((t) => t.settleTs >= sinceMs)
    .reduce((a, t) => a + t.pnl, 0);
  return round2(total);
}

/** How many of the most recently settled positions were losses, counting back
 *  from the newest until a winner appears. */
export function consecutiveLossStreak(): number {
  const trades = settledTrades();
  let streak = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i]!.won) break;
    streak++;
  }
  return streak;
}

/** Start of the current UTC day, in ms. The loss limit is day-scoped so it resets
 *  on a fixed, auditable boundary rather than drifting with process restarts. */
export function utcDayStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** `YYYY-MM-DD` for the UTC day containing `now`. */
export function utcDayKey(now = Date.now()): string {
  return new Date(utcDayStart(now)).toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
