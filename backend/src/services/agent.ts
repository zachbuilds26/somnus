import { randomUUID } from 'node:crypto';
import { debug, warn } from '../config';
import { effectiveDryRun, loadAgentConfig } from '../agent-config';
import type { AgentConfigDoc } from '../types';
import { eventBook, listEventMarketRows } from './sdk';
import { buildSignalContext, estimateFair } from './signal';
import { decideFromFair, momentumBreak } from './pricing';
import { horizonPolicy, PROVISIONAL_SLOTS, type TradeablePolicy } from './horizon';
import { beginCycle, crossingPrice, executeDecision } from './broker';
import { appendEntry } from './store';
import { addPending } from './pending';
import type { BookTicker, Decision, OrderLog, SignalInput, SignalResult } from '../types';
import type { PendingTrade } from './pending';

/** Momentum breaker knobs: how far the book may move AGAINST an intended side,
 *  over how long, before the trade is skipped as suspect. */
const MOM_BREAK_PP = Number(process.env.AGENT_MOM_BREAK_PP ?? 0.08);
const MOM_WINDOW_MS = Number(process.env.AGENT_MOM_WIN_MS ?? 600_000);

/** Last-seen mids per symbol — cross-cycle memory so the breaker sees books
 *  collapse ACROSS cycles, which is exactly how the 2026-08-26 loss happened
 *  (three consecutive cycles re-rating a stampeding window as a bargain). */
const midHistory = new Map<string, Array<{ ts: number; mid: number }>>();

/** How many markets one cycle will price. Bounded because each costs a book read
 *  and a cycle has to finish inside the loop interval. */
const MARKETS_PER_CYCLE = 12;

/** Kept for callers that want the old consensus behaviour explicitly. */
export function defaultSignal(input: SignalInput): SignalResult {
  return { fair: input.mid, note: 'consensus' };
}

export interface CycleResult {
  decisions: Decision[];
  orders: OrderLog[];
  books: BookTicker[];
  errors: string[];
  pending: PendingTrade[];
}

/** Only ever one cycle at a time.
 *
 *  The open-position counter is per-cycle module state, and `beginCycle` resets
 *  it — so two overlapping cycles clobber each other's count and can jointly
 *  exceed `maxOpenPositions`. The loop has its own busy guard, but POST
 *  /agent/run bypasses it, and the two can collide. A concurrent caller joins
 *  the in-flight cycle and gets its result rather than starting a second one.  */
let cycleInFlight: Promise<CycleResult> | undefined;

export interface RunOpts {
  /** Cap on orders placed this run (overrides the saved tradeQuota budget). */
  maxTrades?: number;
  /** Amount per trade in tUSDC for this run (overrides config.maxTradeSize). */
  maxTradeSize?: number;
  /** Markets to trade this run, e.g. ["BTC","ETH"] (overrides config.symbols). */
  symbols?: string[];
  /** Minimum edge required to trade this run (overrides config.minEdge). */
  minEdge?: number;
  /** Per-user session seed: when set, orders are placed through the visitor's
   *  funded session account instead of the operator's trade key. */
  sessionSeed?: `0x${string}`;
  /** When true, found trades become pending asks instead of auto-executing. */
  requireConfirm?: boolean;
  edgePreset?: 'very-sure' | 'middle' | 'a-bit-sure';
}

export function runCycle(opts?: RunOpts): Promise<CycleResult> {
  if (cycleInFlight) {
    debug('runCycle: joining in-flight cycle instead of starting a second');
    return cycleInFlight;
  }
  cycleInFlight = executeCycle(opts).finally(() => {
    cycleInFlight = undefined;
  });
  return cycleInFlight;
}

async function executeCycle(opts?: RunOpts): Promise<CycleResult> {
  const decisions: Decision[] = [];
  const orders: OrderLog[] = [];
  const books: BookTicker[] = [];
  const errors: string[] = [];
  const pending: PendingTrade[] = [];

  // The operator's saved rules govern this cycle — same document the broker
  // gates on and the UI edits. A per-run override (from the coding-agent tool or
  // the HTTP request) layers on top WITHOUT mutating the saved config.
  const rules: AgentConfigDoc = { ...loadAgentConfig() };
  if (opts?.edgePreset) {
    const map: Record<string, number> = { 'very-sure': 0.07, middle: 0.05, 'a-bit-sure': 0.03 };
    const v = map[opts.edgePreset];
    if (v !== undefined) rules.minEdge = v;
    (rules as any).edgePreset = opts.edgePreset;
  }
  if (opts?.maxTradeSize !== undefined) rules.maxTradeSize = opts.maxTradeSize;
  if (opts?.minEdge !== undefined) rules.minEdge = opts.minEdge;
  if (opts?.symbols !== undefined) rules.symbols = opts.symbols;
  const dryRun = effectiveDryRun(rules);

  // Establish this cycle's open-position baseline from real on-chain exposure
  // before any order is considered. A per-run trade count (if requested) caps
  // this cycle and overrides the persisted budget.
  await beginCycle(dryRun, opts);

  let markets;
  try {
    markets = await listEventMarketRows();
  } catch (err) {
    warn('runCycle: markets unavailable', err);
    return { decisions, orders, books, errors: [String((err as Error).message ?? err)], pending };
  }
  if (markets.length === 0) {
    errors.push('no live Event Contract markets found (check VENUE_ID / network)');
    return { decisions, orders, books, errors, pending };
  }

  const wanted = rules.symbols;
  // Match on the market's typed asset field, not the symbol text. Question and
  // symbol wording has been revised repeatedly upstream; `asset` is stable.
  const byAsset =
    wanted.length > 0 ? markets.filter((m) => wanted.includes(m.asset.toUpperCase())) : markets;

  // Classify every candidate window by horizon tier. Windows about to close are
  // dropped: a cycle takes tens of seconds, so a window with seconds left locks
  // between the book read and the order, the pool reverts TradingNotActive, and
  // the gas is wasted. Classes measured to have no edge (1m) are dropped too.
  //
  // What survives is split by tier. `validated` classes trade on the operator's
  // own rules; `provisional` (unmeasured, i.e. 1h/4h/24h) classes trade at a
  // higher edge bar and a smaller stake. See services/horizon.ts.
  const nowSec = Math.floor(Date.now() / 1000);
  const scored: Array<{ market: (typeof byAsset)[number]; policy: TradeablePolicy }> = [];
  const blockedBy = new Map<string, number>();
  for (const m of byAsset) {
    const left = m.expiry === undefined ? Number.NaN : m.expiry - nowSec;
    const policy = horizonPolicy(m.intervalSec, left);
    if (policy.tier === 'blocked') {
      blockedBy.set(policy.note, (blockedBy.get(policy.note) ?? 0) + 1);
      continue;
    }
    scored.push({ market: m, policy: { ...policy, tier: policy.tier } });
  }
  if (blockedBy.size > 0) {
    debug(
      `skipped ${byAsset.length - scored.length} window(s): ` +
        [...blockedBy.entries()].map(([note, n]) => `${n}x ${note}`).join('; '),
    );
  }

  // Reserve slots for provisional classes. Left to sort order the agent would fill
  // every slot with 15m windows — there are always hundreds live — and never place
  // a 1h/4h/24h trade, so those classes could never accumulate the settled samples
  // needed to graduate to validated. Longest first, since those are least sampled.
  const validated = scored.filter((s) => s.policy.tier === 'validated');
  const provisional = scored
    .filter((s) => s.policy.tier === 'provisional')
    .sort((a, b) => b.policy.classSec - a.policy.classSec);
  const provisionalTake = provisional.slice(0, Math.max(0, Math.min(PROVISIONAL_SLOTS, MARKETS_PER_CYCLE)));
  const subset = [...validated.slice(0, MARKETS_PER_CYCLE - provisionalTake.length), ...provisionalTake];
  debug(
    `cycle universe: ${subset.length} window(s) — ${subset.length - provisionalTake.length} validated, ` +
      `${provisionalTake.length} provisional (${provisionalTake.map((s) => s.policy.label).join(',') || 'none'})`,
  );

  // One spot + volatility read per asset for the whole cycle, not per market.
  let ctx;
  try {
    ctx = await buildSignalContext(subset.map((s) => s.market.asset));
  } catch (err) {
    warn('runCycle: signal context failed', err);
    ctx = {
      spot: new Map<string, number>(),
      closes: new Map<string, number[]>(),
      spotTs: new Map<string, number>(),
      candleTs: new Map<string, number>(),
    };
  }
  if (ctx.spot.size === 0) {
    errors.push('price feed returned no spot — falling back to consensus (agent will not trade)');
  }

  for (const { market: mk, policy } of subset) {
    try {
      const book = await eventBook(mk.symbol, 5);
      books.push(book);
      if (book.bid === undefined && book.ask === undefined) continue;

      // Momentum breaker input: the earliest mid recorded inside the window,
      // BEFORE recording this reading.
      const hist = (midHistory.get(mk.symbol) ?? []).filter((h) => Date.now() - h.ts <= MOM_WINDOW_MS);
      const prevMid = hist.length > 0 ? hist[0]!.mid : undefined;
      if (book.mid !== undefined) {
        hist.push({ ts: Date.now(), mid: book.mid });
        midHistory.set(mk.symbol, hist.slice(-8));
      }

      // Real model only — no demo override. Either we have an independent estimate or we admit we are just echoing the book.
      const modelled = estimateFair(mk, ctx);
      const fairRes: SignalResult = modelled
        ? { fair: modelled.fair, note: modelled.note }
        : { fair: book.mid ?? 0, note: 'consensus (no model input)' };

      // Tier scales what the agent demands and what it stakes. On a validated
      // horizon both multipliers are 1 and this is exactly the operator's rules.
      const r = decideFromFair(fairRes.fair, book, {
        minEdge: rules.minEdge * policy.edgeMultiplier,
        maxSize: rules.maxTradeSize * policy.sizeMultiplier,
      });

      // Order-flow circuit breaker: a hard move against the intended side is
      // more likely "the market knows something" than "everyone is wrong at
      // once". Skip and record why.
      if (
        (r.action === 'BUY_YES' || r.action === 'BUY_NO') &&
        momentumBreak(prevMid, book.mid ?? r.mid, r.action, { moveThreshold: MOM_BREAK_PP })
      ) {
        const side = r.action;
        const movedPp = prevMid !== undefined ? ((book.mid ?? r.mid) - prevMid) * 100 : 0;
        r.action = 'PASS';
        r.size = 0;
        r.edge = 0;
        r.pricedNote = `momentum breaker: mid moved ${movedPp.toFixed(1)}pp against ${side === 'BUY_YES' ? 'Up' : 'Down'} within ${Math.round(MOM_WINDOW_MS / 1000)}s`;
        r.reason = `${r.reason} — skipped: order flow moving hard against the side`;
      }

      const decision: Decision = {
        id: randomUUID().slice(0, 8),
        ts: Date.now(),
        symbol: mk.symbol,
        fair: round4(fairRes.fair),
        mid: r.mid,
        ask: r.ask,
        bid: r.bid,
        edge: r.edge,
        action: r.action,
        size: r.size,
        horizon: policy.label,
        horizonTier: policy.tier,
        requiredEdge: round4(rules.minEdge * policy.edgeMultiplier),
        // How old every input behind this decision was. The broker refuses to act
        // on anything past `maxDataAgeMs`; recording the ages means a later study
        // can also tell a good call from a lucky one made on stale data.
        freshness: {
          spotAgeMs: ageFrom(ctx.spotTs.get(mk.asset.toUpperCase())),
          candleAgeMs: ageFrom(ctx.candleTs.get(mk.asset.toUpperCase())),
          bookAgeMs: ageFrom(book.ts),
        },
        pricedNote: r.pricedNote,
        reason: `${r.reason} — ${fairRes.note} — ${policy.note}`,
        dryRun,
      };
      await appendEntry({ kind: 'decision', payload: { ...decision } });
      decisions.push(decision);

      if (decision.action === 'BUY_YES' || decision.action === 'BUY_NO') {
        if (rules.mode === 'view') continue;
        // Detailed ask mode — don't auto-execute, create a pending that the
        // API returns as a question: "Place $5 on BTC 5m? Yes/No"
        if (opts?.requireConfirm) {
          const isUp = decision.action === 'BUY_YES';
          const quoted = isUp ? decision.ask : 1 - decision.bid;
          const fairForSide = isUp ? decision.fair : 1 - decision.fair;
          const price = crossingPrice(quoted, fairForSide) ?? (isUp ? decision.ask : decision.bid);
          const size = decision.size;
          const cost = Math.round(price * size * 100) / 100;
          const payoutIfWin = size; // 1 tUSDC per contract if you win
          const p: PendingTrade = {
            id: decision.id,
            decision,
            cost,
            payoutIfWin,
            price,
            size,
            symbol: decision.symbol,
            fair: decision.fair,
            mid: decision.mid,
            ask: decision.ask,
            bid: decision.bid,
            edge: decision.edge,
            requiredEdge: decision.requiredEdge ?? rules.minEdge,
            horizon: decision.horizon,
            createdAt: Date.now(),
            preset: (rules as any).edgePreset,
          };
          addPending(p);
          pending.push(p);
          continue;
        }
        const order = await executeDecision(decision);
        orders.push(order);
      }
    } catch (err) {
      debug('cycle err', mk.symbol, err);
      errors.push(`${mk.symbol}: ${(err as Error).message ?? String(err)}`);
    }
  }

  return { decisions, orders, books, errors, pending };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Age of a timestamp in ms, or undefined when the input never arrived.
 *  Undefined propagates as "unknown", which the freshness gate treats as stale —
 *  a missing timestamp is precisely the case where we cannot show the data was
 *  current. */
function ageFrom(ts: number | undefined): number | undefined {
  if (ts === undefined || !Number.isFinite(ts)) return undefined;
  return Math.max(0, Date.now() - ts);
}