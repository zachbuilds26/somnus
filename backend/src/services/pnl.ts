import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config';
import { readAllFromDisk } from './store';
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
  /** Gas paid for this transaction, in the chain's NATIVE token — never tUSDC.
   *  Kept on the row rather than folded into `cost` because adding two different
   *  assets needs an exchange rate this backend does not have, and inventing one
   *  to produce a single tidy number would be worse than reporting two true ones. */
  gasNative?: number;
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
  /** True when the outcome was recorded from a settlement sweep rather than from a
   *  redemption — the P&L is real either way, the collateral just is not back yet. */
  unclaimed?: boolean;
}
/** Gas spent on something that is not a fill — a claim, mostly. Fills carry their
 *  own `gasNative`, so this exists to stop redemption gas vanishing from the total. */
interface GasRow {
  t: 'gas';
  ts: number;
  gasNative: number;
  reason: string;
  txHash?: string;
}
type Row = FillRow | SettleRow | GasRow;

function keyOf(marketId: string, outcomeIdx: 0 | 1): string {
  return `${marketId}:${outcomeIdx}`;
}

function append(row: Row): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LEDGER, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // storage failure must not take down the agent loop
  } finally {
    // Whether or not the write landed, the cache can no longer be trusted.
    rowCache = undefined;
  }
}

/** Parsed-ledger cache.
 *
 *  `riskStatus()` alone called `readAll()` FOUR times — once each via realizedSince,
 *  consecutiveLossStreak, openNotional and drawdownState — and it runs on every
 *  order, every loop tick and every /health poll. At 62 rows that is invisible; it
 *  grows linearly with trade count and /health is the most-polled route on the
 *  service.
 *
 *  Validated on mtime AND size rather than a timer, so a value is never served after
 *  the file changed. Our own appends invalidate directly. An external editor moves
 *  either mtime or size, and if it somehow moved neither, the row count is identical
 *  and the content check would be the only tell — which is what
 *  `verifyLedgerAgainstChain` is for. */
let rowCache: { rows: Row[]; mtimeMs: number; size: number } | undefined;

function ledgerStat(): { mtimeMs: number; size: number } | undefined {
  try {
    const s = statSync(LEDGER);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

function readAll(): Row[] {
  if (!existsSync(LEDGER)) return [];
  const stat = ledgerStat();
  if (rowCache && stat && rowCache.mtimeMs === stat.mtimeMs && rowCache.size === stat.size) {
    return rowCache.rows;
  }
  const rows = readFileSync(LEDGER, 'utf8')
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
  if (stat) rowCache = { rows, mtimeMs: stat.mtimeMs, size: stat.size };
  return rows;
}

/** Drop the parsed-ledger cache. For tests. */
export function __resetLedgerCacheForTests(): void {
  rowCache = undefined;
}

/** Record the cost of an accepted fill. `cost` is collateral spent (price x size),
 *  identical whether the Up or Down outcome was bought. */
export function recordFill(
  marketId: string,
  outcomeIdx: 0 | 1,
  size: number,
  cost: number,
  meta?: { userId?: number; symbol?: string; gasNative?: number; strategy?: FillStrategyMeta },
): void {
  if (!(cost > 0)) return;
  append({ t: 'fill', marketId, outcomeIdx, size, cost, ts: Date.now(), ...meta });
}

/** Record gas spent on something that produced no fill row of its own — a claim, a
 *  reverted attempt. Without this, redemption gas simply disappears from the cost of
 *  running the agent. */
export function recordGas(gasNative: number, reason: string, txHash?: string): void {
  if (!(gasNative > 0)) return;
  append({ t: 'gas', ts: Date.now(), gasNative, reason, txHash });
}

/** Record a settled position. Idempotent (a market+outcome is only ever settled
 *  once) and a no-op if we never traded that side, so re-running a claim scan can
 *  never double-count or invent losses.
 *
 *  `unclaimed` marks an outcome learned from a settlement sweep rather than from a
 *  redemption. The P&L is equally real — the window has resolved and the payout is
 *  1:1 with a zero settlement fee — the collateral simply is not back in the wallet
 *  yet. Recording it at settlement instead of at redemption is what stops the loss
 *  breakers going blind when claiming breaks. */
export function recordSettlement(
  marketId: string,
  outcomeIdx: 0 | 1,
  payout: number,
  won: boolean,
  unclaimed = false,
): void {
  const key = keyOf(marketId, outcomeIdx);
  const all = readAll();
  if (!all.some((r) => r.t === 'fill' && keyOf(r.marketId, r.outcomeIdx) === key)) return;
  if (all.some((r) => r.t === 'settle' && keyOf(r.marketId, r.outcomeIdx) === key)) return;
  append({ t: 'settle', marketId, outcomeIdx, payout, won, ts: Date.now(), ...(unclaimed ? { unclaimed } : {}) });
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
  /** Gas spent across every recorded transaction, in the chain's NATIVE token.
   *  Reported beside `realizedPnl` rather than inside it — they are different
   *  assets. A strategy that looks break-even in tUSDC can still be losing money
   *  once gas is counted, and that is exactly what this exists to expose. */
  gasSpentNative: number;
  /** Realised loss from the equity peak, over the settled ledger. Positive number
   *  = currently that far below the best point reached. */
  drawdown: number;
  /** The best cumulative realised P&L reached. */
  peakEquity: number;
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
  let gasSpentNative = 0;

  for (const r of rows) {
    if (r.t === 'gas') {
      gasSpentNative += r.gasNative;
      continue;
    }
    if (r.t === 'fill') {
      totalFills++;
      totalFillCost += r.cost;
      gasSpentNative += r.gasNative ?? 0;
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
  const dd = drawdownState();

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
    gasSpentNative: Math.round(gasSpentNative * 1e6) / 1e6,
    drawdown: dd.drawdown,
    peakEquity: dd.peak,
  };
}

/** Peak-to-trough realised loss over the settled ledger.
 *
 *  Walks cumulative realised P&L in settlement order, tracks the high-water mark,
 *  and reports how far below it we currently sit. This is the number `maxDailyLoss`
 *  cannot see: a UTC-midnight reset means an agent losing just under the daily limit
 *  every single day never trips a breaker, while the account drains steadily.
 *
 *  Exported separately from `pnlSummary` so the risk gate can read it without
 *  building the whole summary on every order. */
export function drawdownState(): { drawdown: number; peak: number; cumulative: number } {
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const t of settledTrades()) {
    cumulative += t.pnl;
    if (cumulative > peak) peak = cumulative;
    const gap = peak - cumulative;
    if (gap > worst) worst = gap;
  }
  return {
    // The CURRENT distance below the peak, not the worst ever seen — a breaker
    // should release when the account recovers, otherwise one bad week bans the
    // agent forever with no way back.
    drawdown: round2(Math.max(0, peak - cumulative)),
    peak: round2(peak),
    cumulative: round2(cumulative),
  };
}

/** Collateral currently sitting in positions we have not seen settle, in tUSDC.
 *
 *  This is what `maxOpenNotional` gates on. Derived from the ledger rather than
 *  from a portfolio read because the ledger is the only place that knows what a
 *  position COST — the chain knows how many outcome tokens are held, not what was
 *  paid for them, and the book that priced them is gone by settlement time.
 *
 *  Biased conservative on purpose. A settled position only leaves this total once a
 *  sweep has recorded its outcome, so between settlement and the next sweep its cost
 *  is still counted as open. That over-restricts the gate slightly, which is the
 *  correct direction to be wrong in for a limit whose job is bounding simultaneous
 *  risk. */
export function openNotional(): number {
  const rows = readAll();
  const costByKey = new Map<string, number>();
  const settled = new Set<string>();
  for (const r of rows) {
    if (r.t === 'gas') continue;
    const k = keyOf(r.marketId, r.outcomeIdx);
    if (r.t === 'fill') costByKey.set(k, (costByKey.get(k) ?? 0) + r.cost);
    else settled.add(k);
  }
  let open = 0;
  for (const [k, cost] of costByKey) if (!settled.has(k)) open += cost;
  return round2(Math.max(0, open));
}

/** Open positions keyed `marketId:outcomeIdx`, with the cost basis and the context
 *  captured at fill time. Feeds reconciliation and the correlation caps, both of
 *  which need to know WHICH positions are open, not just how much they cost. */
export function openPositions(): Array<{
  key: string;
  marketId: string;
  outcomeIdx: 0 | 1;
  cost: number;
  size: number;
  ts: number;
  symbol?: string;
  expiry?: number;
}> {
  const rows = readAll();
  const open = new Map<
    string,
    { marketId: string; outcomeIdx: 0 | 1; cost: number; size: number; ts: number; symbol?: string; expiry?: number }
  >();
  const settled = new Set<string>();
  for (const r of rows) {
    if (r.t === 'gas') continue;
    const k = keyOf(r.marketId, r.outcomeIdx);
    if (r.t === 'settle') {
      settled.add(k);
      continue;
    }
    const prev = open.get(k);
    open.set(k, {
      marketId: r.marketId,
      outcomeIdx: r.outcomeIdx,
      cost: (prev?.cost ?? 0) + r.cost,
      size: (prev?.size ?? 0) + r.size,
      ts: prev ? Math.min(prev.ts, r.ts) : r.ts,
      symbol: prev?.symbol ?? r.symbol,
      expiry: prev?.expiry ?? r.strategy?.expiry,
    });
  }
  return [...open.entries()]
    .filter(([k]) => !settled.has(k))
    .map(([key, v]) => ({ key, ...v, cost: round2(v.cost) }));
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

export interface LedgerVerification {
  ok: boolean;
  /** Fill rows on the ledger, and how many are corroborated by a signed order
   *  entry in the proof chain. */
  ledgerFills: number;
  corroborated: number;
  /** Ledger fills with no matching signed order entry. Either the file was edited,
   *  or a fill was written by a code path that skipped the audit chain. */
  uncorroborated: Array<{ marketId: string; outcomeIdx: 0 | 1; cost: number; ts: number }>;
  /** Signed live orders that filled but have no ledger row — the lost-write case,
   *  from the ledger's side rather than the chain's. Only counts orders placed
   *  AFTER the ledger existed. */
  missingFromLedger: Array<{ marketId: string; outcomeIdx: 0 | 1; size?: number; price: number; ts: number }>;
  /** Signed live orders that predate the first ledger row. Informational: cost-basis
   *  recording shipped mid-flight, so these were never going to have one. Excluded
   *  from `ok` because an alarm that can never be cleared is an alarm that gets
   *  ignored, and then it is worth less than no alarm at all. */
  preLedgerOrders: number;
  /** Timestamp of the first ledger fill — the point comparison becomes meaningful. */
  ledgerStartTs?: number;
  note: string;
}

/** Cross-check the P&L ledger against the signed audit chain.
 *
 *  The asymmetry this closes: proof-chain.jsonl is hash-linked, secp256k1-signed and
 *  periodically anchored on-chain, while pnl-ledger.jsonl — the file every risk limit
 *  reads to decide whether to keep trading — is plain appendable JSONL that anything
 *  with write access can edit. The file with authority over the brakes had the weaker
 *  guarantee.
 *
 *  Rather than bolt a second hash chain onto the ledger, reconstruct what it should
 *  contain from the signed order entries and diff. Every live fill goes through
 *  `appendEntry({kind:'order'})` immediately before `recordFill`, so a fill with no
 *  signed order behind it did not come from the trading path.
 *
 *  Two things this has to get right or it is noise:
 *   - key on marketId AND outcome. A window where both YES and NO were bought is two
 *     positions with two cost bases, and collapsing them to the market id silently
 *     matched the wrong one;
 *   - ignore orders older than the ledger itself. Cost-basis recording shipped on
 *     27 August against a chain that starts on the 24th, so 29 legitimate orders will
 *     never have a row and were holding `ok` at false permanently. */
export function verifyLedgerAgainstChain(): LedgerVerification {
  const rows = readAll();
  const fills = rows.filter((r): r is FillRow => r.t === 'fill');
  const ledgerStartTs = fills.length > 0 ? Math.min(...fills.map((f) => f.ts)) : undefined;
  // A small grace window: the order entry is appended moments BEFORE its fill row, so
  // an exact boundary would flag the very first order as pre-ledger.
  const boundary = ledgerStartTs === undefined ? undefined : ledgerStartTs - 60_000;

  // Signed, submitted, non-dry-run orders that actually put on a position.
  const chainOrders = new Map<string, { size?: number; price: number; ts: number; outcomeIdx: 0 | 1 }>();
  let preLedgerOrders = 0;
  for (const entry of readAllFromDisk()) {
    if (entry.kind !== 'order') continue;
    const p = entry.payload as Record<string, unknown>;
    if (p.status !== 'submitted' || p.dryRun === true) continue;
    const marketId = typeof p.marketId === 'string' ? p.marketId : undefined;
    if (!marketId) continue;
    // The routed symbol names the outcome that was actually bought: a Down leg buys
    // the NO token, so the suffix is authoritative where the decision action is not
    // present on the entry.
    const symbol = typeof p.symbol === 'string' ? p.symbol : '';
    const outcomeIdx: 0 | 1 = /#NO$/i.test(symbol) ? 1 : 0;
    if (boundary !== undefined && Number(entry.ts) < boundary) {
      preLedgerOrders++;
      continue;
    }
    chainOrders.set(keyOf(marketId, outcomeIdx), {
      size: typeof p.filledSize === 'number' ? p.filledSize : (p.size as number | undefined),
      price: Number(p.price),
      ts: Number(entry.ts),
      outcomeIdx,
    });
  }

  const uncorroborated: LedgerVerification['uncorroborated'] = [];
  const seen = new Set<string>();
  let corroborated = 0;
  for (const f of fills) {
    const key = keyOf(f.marketId, f.outcomeIdx);
    seen.add(key);
    if (chainOrders.has(key)) corroborated++;
    else uncorroborated.push({ marketId: f.marketId, outcomeIdx: f.outcomeIdx, cost: f.cost, ts: f.ts });
  }

  const missingFromLedger: LedgerVerification['missingFromLedger'] = [];
  for (const [key, o] of chainOrders) {
    if (seen.has(key)) continue;
    const marketId = key.slice(0, key.lastIndexOf(':'));
    missingFromLedger.push({ marketId, outcomeIdx: o.outcomeIdx, size: o.size, price: o.price, ts: o.ts });
  }

  const ok = uncorroborated.length === 0 && missingFromLedger.length === 0;
  const preNote =
    preLedgerOrders > 0
      ? ` (${preLedgerOrders} older order(s) predate the ledger and are not counted)`
      : '';
  return {
    ok,
    ledgerFills: fills.length,
    corroborated,
    uncorroborated,
    missingFromLedger,
    preLedgerOrders,
    ledgerStartTs,
    note: ok
      ? `all ${fills.length} ledger fill(s) are backed by a signed order entry${preNote}`
      : [
          uncorroborated.length > 0
            ? `${uncorroborated.length} ledger fill(s) have NO signed order behind them ` +
              '(edited file, or a fill written outside the trading path)'
            : '',
          missingFromLedger.length > 0
            ? `${missingFromLedger.length} signed live order(s) have no ledger row ` +
              '(lost write — see GET /api/agent/reconcile)'
            : '',
        ]
          .filter(Boolean)
          .join('; ') + preNote,
  };
}
