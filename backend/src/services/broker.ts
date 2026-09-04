import { randomUUID } from 'node:crypto';
import { MODEL_VERSION, STRATEGY_VERSION, debug, warn } from '../config';
import { consumeTradeQuota, effectiveDryRun, loadAgentConfig } from '../agent-config';
import type { AgentConfigDoc } from '../types';
import { findEventMarket } from './sdk';
import { appendEntry } from './store';
import { openNotional, openPositions, recordFill, recordGas } from './pnl';
import { canAfford, equity, gasCostFromReceipt, noteCommitted, walletSnapshot } from './wallet';
import {
  clearExecutionFailures,
  dataFresh,
  recordExecutionFailure,
  riskStatus,
} from './risk';
import type { LiveOrderResult } from './sdk-live';
import type { Decision, FillStrategyMeta, OrderLog } from '../types';

/** What will actually hit the book. A Down leg buys the NO outcome rather than
 *  selling YES (a naked short the pool refuses), so the symbol and price differ
 *  from the decision's window. Resolved before logging so the proof chain
 *  records the real trade in dry-run and live alike — an audit trail that says
 *  "sell YES" while the chain shows "buy NO" is worse than no audit trail.   */
interface ExecutionTarget {
  symbol: string;
  price: number;
  side: 'buy';
  size: number;
  /** bytes32 market id, for the pre-submit on-chain status check. */
  marketId?: string;
  /** Best visible price for the outcome being bought, before crossing. */
  quoted: number;
  /** Our own fair value for that same outcome. */
  fairForSide: number;
  /** Window expiry, unix seconds. Drives the per-expiry correlation cap: positions
   *  that settle on the same tick are one bet wearing several tickets. */
  expiry?: number;
  /** Which outcome is being bought, for the same-direction cap. */
  outcome: 'YES' | 'NO';
}

/** How far past the touch to place an IOC, in probability points.
 *
 *  Submitting at exactly the best offer is fragile: the book moves between the
 *  read and the send, the order finds nothing, and the pool reverts
 *  `ImmediateOrCancelNoFill()` — gas spent for no position.
 *
 *  A FIXED 1pp buffer turned out to be too thin. The live 5m books are maker
 *  ladders quoting in 1pp steps across a ~3pp spread with 200+ contracts a level,
 *  so depth is never the issue — the ladder simply re-quotes around new spot
 *  before the order lands, and a 1pp cross misses. Two real $20 orders died that
 *  way while holding 5.4pp and 8.6pp of edge: 1pp spent on certainty, the rest
 *  left on the table and then lost anyway.
 *
 *  So scale the cross with the edge available. Spend at most half of it buying a
 *  fill and keep the other half as expected profit — a trade that fills at half
 *  edge beats a trade that reverts at full edge. Still hard-capped below fair, so
 *  the cross can never turn a positive-edge trade negative.                    */
const CROSS_BUFFER_MIN = Number(process.env.AGENT_CROSS_MIN ?? 0.01);
const CROSS_EDGE_FRACTION = Number(process.env.AGENT_CROSS_EDGE_FRACTION ?? 0.5);

/** The crossing price for an IOC, given the touch and our own fair value.
 *
 *  Exported so the trade-off it encodes is pinned by tests rather than
 *  rediscovered on-chain: two real orders reverted `ImmediateOrCancelNoFill`
 *  crossing a fixed 1pp while holding 5.4pp and 8.6pp of edge. Returns
 *  `undefined` when there is no room to cross without paying through fair. */
export function crossingPrice(quoted: number, fairForSide: number): number | undefined {
  if (!Number.isFinite(quoted) || !Number.isFinite(fairForSide)) return undefined;
  const edge = Math.max(0, fairForSide - quoted);
  const buffer = Math.max(CROSS_BUFFER_MIN, edge * CROSS_EDGE_FRACTION);
  const ceiling = Math.min(quoted + buffer, fairForSide - 0.001, 0.999);
  // If the fair cap sits at or below the touch there is no room at all. Clamping
  // back UP to `quoted` here — as this did originally — silently defeats the cap
  // and can submit at or through fair.
  if (ceiling < quoted) return undefined;
  const price = round4(ceiling);
  if (!(price > 0) || !(price < 1) || price < quoted) return undefined;
  return price;
}

async function resolveExecution(
  decision: Decision,
  maxTradeSize: number,
): Promise<ExecutionTarget> {
  const isUp = decision.action === 'BUY_YES';
  const quoted = isUp ? decision.ask : 1 - decision.bid;
  // Our own fair value for the side being bought.
  const fairForSide = isUp ? decision.fair : 1 - decision.fair;

  let symbol = decision.symbol;
  let marketId: string | undefined;
  const market = await findEventMarket(decision.symbol);
  marketId = market?.marketId;
  if (!isUp) {
    const noSymbol = market?.noSymbol;
    if (!noSymbol) throw new Error(`no NO outcome resolved for ${decision.symbol}`);
    symbol = noSymbol;
  }

  // Cross, but never past fair — paying more than the outcome is worth turns a
  // positive-edge trade into a negative one. The buffer scales with the edge we
  // hold: a wide edge can afford a deeper cross and still profit, a thin one
  // cannot.
  const price = crossingPrice(quoted, fairForSide);
  if (price === undefined) {
    throw new Error(`no room to cross: quoted ${round4(quoted)} vs fair ${round4(fairForSide)}`);
  }

  // Re-size at the price we will actually pay so the notional gate still holds.
  const size = Math.min(decision.size, Math.floor(maxTradeSize / price));
  if (size < 1) throw new Error(`size rounds to 0 at crossing price ${price}`);

  return {
    symbol,
    price,
    side: 'buy',
    size,
    marketId,
    quoted: round4(quoted),
    fairForSide: round4(fairForSide),
    expiry: market?.expiry,
    outcome: isUp ? 'YES' : 'NO',
  };
}

/** What a live order actually cost, read off what the venue reported rather than
 *  off what we asked for.
 *
 *  Pure + exported so the rule is pinned by tests instead of rediscovered in the
 *  ledger months later. Three things can differ between request and reality, and
 *  all three move the cost basis:
 *   - the quantity is floored onto the venue's lot grid before placing,
 *   - the limit price is snapped onto the tick grid (DOWN for a buy),
 *   - an IOC that exhausts the depth at its limit fills PARTIALLY and cancels
 *     the remainder, reporting `status: 'canceled'`.
 *
 *  REGRESSION (2026-08-30): 1976 contracts requested at 0.506, 990 filled. The
 *  ledger booked 1976 x 0.506 = $999.86 against a position that cost ~$501 and
 *  paid out $990 — a ~$489 winner recorded as a $10 loser, which then dragged
 *  every downstream number: win rate, realised P&L, the daily-loss breaker, and
 *  `npm run score`.
 *
 *  `filled: undefined` means the venue did not tell us and we cannot infer it —
 *  the caller must treat that as "no position", never as a full fill.          */
export function resolveFill(
  result: { filled?: number; placedPrice?: number; status?: string },
  requested: { size: number; price: number },
): { filled: number | undefined; paidPrice: number; cost: number | undefined } {
  // Only `status: 'closed'` licenses assuming the whole request traded — the SDK
  // sets it precisely when `remaining <= 0`.
  const filled =
    result.filled !== undefined && Number.isFinite(result.filled) && result.filled >= 0
      ? result.filled
      : result.status === 'closed'
        ? requested.size
        : undefined;
  const paidPrice =
    result.placedPrice !== undefined && result.placedPrice > 0 && result.placedPrice < 1
      ? result.placedPrice
      : requested.price;
  // Priced at the placed limit rather than at each maker's fill price, which the
  // unified result does not expose per-fill. A buy never pays MORE than its
  // limit, so this can only overstate the cost — and overstating cost understates
  // P&L, which is the safe direction to be wrong in.
  const cost = filled !== undefined && filled > 0 ? round4(paidPrice * filled) : undefined;
  return { filled, paidPrice, cost };
}

/** Collateral one order may put at risk: the per-trade cap, or whatever is left of
 *  the open-exposure ceiling, whichever binds first.
 *
 *  Returns a BUDGET rather than a yes/no verdict on purpose. Every other limit in
 *  this file sizes a trade down instead of discarding it, because the decision was
 *  sized against the rules as they stood when the cycle began; refusing outright
 *  would throw away a good trade over an arithmetic detail the operator never saw.
 *
 *  `maxOpenNotional <= 0` switches the ceiling off, so this collapses to the
 *  per-trade cap. */
export function tradeBudget(maxTradeSize: number, maxOpenNotional: number, openNotional: number): number {
  const remaining =
    maxOpenNotional > 0 ? Math.max(0, maxOpenNotional - openNotional) : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(maxTradeSize, remaining));
}

/** The hard gate between "the agent wants to trade" and the chain.
 *  - Every order passes config limits even if the decision doesn't.
 *  - dryRun (default) → simulated order logged + proof-linked, no tx.
 *  - live needs TRADE_KEY/PRIVATE_KEY and MODE=live.                                */
export async function executeDecision(decision: Decision): Promise<OrderLog> {
  // Re-read the saved rules on every order: these are the limits the operator
  // actually wrote, not the process-start env snapshot. A per-run override
  // (e.g. "do 3 trades of $4 each") layers on top for this cycle only.
  const rules: AgentConfigDoc = { ...loadAgentConfig(), ...cycleRulesOverride };
  const dryRun = effectiveDryRun(rules);

  const reject = async (reason: string, routed?: ExecutionTarget): Promise<OrderLog> => {
    const logEntry = buildOrder(decision, 'rejected', reason, dryRun, routed);
    await appendEntry({ kind: 'order', payload: { ...logEntry } });
    return logEntry;
  };

  // ── gates ──────────────────────────────────────────────────────────────────
  // Both of these go through reject() rather than returning bare: a rejection
  // that never reaches the proof chain looks identical to a decision the agent
  // acted on, which is exactly the gap an audit trail exists to close.
  if (decision.action !== 'BUY_YES' && decision.action !== 'BUY_NO') {
    return reject('action not executable', undefined);
  }
  if (decision.size < 1) return reject('size rounds to 0 contracts');

  // Circuit breakers first: these answer "should this agent be trading at all",
  // which outranks every per-order question below. Enforced in dry-run too — a
  // paused agent that keeps writing simulated orders reads as still running, and
  // a rehearsal on stale data teaches us nothing true.
  const risk = riskStatus(rules);
  if (!risk.ok) return reject(`blocked by risk controls: ${risk.blocked.join('; ')}`);

  const fresh = dataFresh(decision.freshness, rules.maxDataAgeMs);
  if (!fresh.ok) return reject(`stale market data: ${fresh.reason}`);

  // The decision quotes the window in YES terms: the ask for an Up buy, the bid
  // for a Down buy.
  const quoted = decision.action === 'BUY_YES' ? decision.ask : decision.bid;
  if (!(quoted > 0) || !(quoted < 1)) return reject(`implausible price ${quoted}`);

  // Cash at risk per contract is NOT the quoted price for a Down leg — buying
  // Down costs (1 - bid). Sizing already assumes that basis, so the gate has to
  // agree or every Down decision is rejected on a phantom notional.
  const costPerContract = decision.action === 'BUY_YES' ? quoted : 1 - quoted;

  // How much collateral this order is allowed to put at risk. Three limits bind:
  // the per-trade cap, whatever is left of the open-exposure budget, and — when
  // enabled — a fraction of equity so the stake shrinks as the account does.
  // See `tradeBudget` for why this is a budget rather than a verdict.
  let perTradeCap = rules.maxTradeSize;
  if (rules.maxTradeSizePctEquity > 0) {
    const eq = await equity(openNotionalTotal());
    if (eq !== undefined) {
      const pctCap = eq * rules.maxTradeSizePctEquity;
      if (pctCap < perTradeCap) perTradeCap = pctCap;
    }
    // Unreadable equity leaves the absolute cap in force. Refusing to trade because
    // one RPC read failed is a worse failure than sizing off the operator's own
    // explicit dollar limit.
  }
  const budget = tradeBudget(perTradeCap, rules.maxOpenNotional, openNotionalTotal());
  if (!(budget > 0)) {
    return reject(
      `open exposure ${openNotionalTotal().toFixed(2)} >= maxOpenNotional ${rules.maxOpenNotional} ` +
        '— waiting for positions to settle',
    );
  }

  // Clamp rather than reject. The decision was sized against the rules as they
  // were when the cycle started; if the operator tightened the limit mid-cycle
  // the honest response is to trade smaller, not to throw the trade away with a
  // confusing "notional 5.00 > maxTradeSize 2". The limit still binds — it is
  // just enforced by sizing down instead of refusing.
  const affordable = Math.floor(budget / costPerContract);
  const sized = Math.min(decision.size, affordable);
  if (sized < 1) {
    return reject(
      `budget ${budget.toFixed(2)} buys no whole contract at ${costPerContract.toFixed(4)} ` +
        `(maxTradeSize ${rules.maxTradeSize}, open exposure ${openNotionalTotal().toFixed(2)}/${rules.maxOpenNotional})`,
    );
  }

  if (decision.edge < rules.minEdge) {
    return reject(`edge ${decision.edge} < minEdge ${rules.minEdge}`);
  }

  // "Do exactly N trades" is its own constraint, not a consequence of exposure
  // limits: positions settling mid-cycle free up `maxOpenPositions` slots, so
  // that gate alone cannot bound how many orders get placed.
  // A per-run trade cap overrides the stored budget; when absent we still enforce
  // the persisted quota.
  const quotaExhausted = rules.tradeQuota !== null && rules.tradeQuota <= 0;
  if (quotaExhausted && cycleRequestedTrades === undefined) {
    return reject('trade quota exhausted — no trades remaining (set tradeQuota or pass trades)');
  }
  const perCycleCap = cycleRequestedTrades ?? rules.maxOrdersPerCycle;
  if (perCycleCap > 0 && openedThisCycle >= perCycleCap) {
    return reject(`orders this cycle ${openedThisCycle} >= cap ${perCycleCap}`);
  }

  const open = openPositionCount();
  if (open >= rules.maxOpenPositions) {
    return reject(`open positions ${open} >= max ${rules.maxOpenPositions}`);
  }

  let target: ExecutionTarget;
  try {
    target = await resolveExecution({ ...decision, size: sized }, budget);
  } catch (err) {
    return reject(`cannot route order: ${(err as Error).message ?? String(err)}`);
  }

  // Per-window cap: one position per market unless the operator raises it.
  // Bounds the observed failure of averaging into a single window across
  // consecutive cycles while the book moves against the position.
  if (rules.maxPerMarket > 0 && target.marketId) {
    const held = openByMarket.get(target.marketId) ?? 0;
    if (held >= rules.maxPerMarket) {
      return reject(
        `per-market exposure: already holding ${held} position(s) on this window (maxPerMarket ${rules.maxPerMarket})`,
        target,
      );
    }
  }

  // Correlation caps. `maxOpenPositions` counts tickets and cannot see that
  // BTC-UP-1230 and ETH-UP-1230 resolve on the same tick against assets that move
  // together — ten "independent" positions can be ten expressions of one macro
  // view, and they all win or all lose. These bound how much of the book rides on
  // a single moment, and on a single direction.
  if (rules.maxPerExpiryBucket > 0 && target.expiry !== undefined) {
    const held = openByExpiry.get(target.expiry) ?? 0;
    if (held >= rules.maxPerExpiryBucket) {
      return reject(
        `correlated exposure: already holding ${held} position(s) settling at ` +
          `${new Date(target.expiry * 1000).toISOString()} (maxPerExpiryBucket ${rules.maxPerExpiryBucket})`,
        target,
      );
    }
  }
  if (rules.maxSameDirection > 0) {
    const held = openByDirection.get(target.outcome) ?? 0;
    if (held >= rules.maxSameDirection) {
      return reject(
        `directional exposure: already holding ${held} ${target.outcome} position(s) ` +
          `(maxSameDirection ${rules.maxSameDirection})`,
        target,
      );
    }
  }

  const base: OrderLog = buildOrder(
    decision,
    'simulated',
    'DRY_RUN (default safe mode)',
    dryRun,
    target,
  );
  if (dryRun) {
    countAccepted(target, target.price * target.size);
    // A simulated trade still spends the quota: "do 3 trades" means 3, whether
    // or not they are sent, so dry-run rehearsals behave like the real thing.
    // A per-run override (trades=N) does NOT persist, so it must not drain the
    // saved budget.
    if (cycleRequestedTrades === undefined) consumeTradeQuota();
    await appendEntry({ kind: 'order', payload: { ...base } });
    return base;
  }

  // ── live path ──────────────────────────────────────────────────────────────
  try {
    // The indexer lags the chain, so confirm the window still accepts orders
    // before spending gas on one that already locked (`TradingNotActive`).
    const { isMarketTrading } = await import('./sdk');
    // Two assets, both required, neither interchangeable: contracts are bought with
    // tUSDC collateral and every transaction pays gas in the native token. Only gas
    // was ever checked, so a drained wallet placed orders that reverted at transfer
    // — one gas payment each — five times, until `maxExecutionFailures` worked out
    // that there was no money. Asking first is cheaper than finding out.
    const afford = await canAfford(target.price * target.size);
    if (!afford.ok) {
      recordExecutionFailure(afford.reason ?? 'wallet cannot cover this order');
      return reject(afford.reason ?? 'wallet cannot cover this order', target);
    }
    if (target.marketId && !(await isMarketTrading(target.marketId))) {
      recordExecutionFailure('window already locked on-chain');
      return reject('window already locked on-chain (indexer was stale)', target);
    }
    const { placeLiveOrder } = await import('./sdk-live');
    const result: LiveOrderResult = await placeLiveOrder({
      symbol: target.symbol,
      price: target.price,
      // target.size, not decision.size: the size was recomputed at the crossing
      // price so the notional gate still holds at what we actually pay.
      size: target.size,
    });

    // What the venue actually did. The SDK floors the quantity onto the lot grid
    // and the price onto the tick grid before placing, then reports the quantity
    // it filled — an IOC that exhausts the depth at its limit fills partially and
    // cancels the rest. All three can be below what we asked for, so the audit
    // entry and the cost basis have to come from the venue's numbers, not ours.
    const { filled, paidPrice, cost } = resolveFill(result, {
      size: target.size,
      price: target.price,
    });
    const gasNative = gasCostFromReceipt(result.receipt);
    const live: OrderLog = {
      ...base,
      status: 'submitted',
      txHash: result.txHash || undefined,
      reason: result.reason,
      price: paidPrice,
      filledSize: filled,
      fillStatus: result.status,
      gasNative,
      // The edge that survived execution, at the price actually placed. A buy
      // snaps DOWN onto the tick grid, so this can only be better than planned.
      retainedEdge: round4(target.fairForSide - paidPrice),
    };
    countAccepted(target, paidPrice * (filled ?? target.size));
    // Quota is spent on ANY accepted live attempt (a submitted order, or an IOC
    // that found no fill) — not only when a txHash is captured. A gas-less or
    // no-fill attempt still consumed a cycle of the operator's authorised budget,
    // so counting it is what makes "do exactly N trades" hold across restarts.
    // A per-run override (trades=N) does NOT persist, so it must not drain the
    // saved budget.
    if (cycleRequestedTrades === undefined) consumeTradeQuota();
    await appendEntry({ kind: 'order', payload: { ...live } });
    // Record cost basis for P&L (only real fills, never dry-run simulations),
    // together with everything a later study needs to grade the trade. The book,
    // the oracle reading and the window are all gone by settlement time, so a
    // number not captured here cannot be recovered honestly afterwards.
    if (!live.dryRun && target.marketId) {
      // An order that filled NOTHING is not a position, and writing a cost basis
      // for it invents a loss the wallet never took. A zero-fill IOC normally
      // reverts `ImmediateOrCancelNoFill` and never reaches here, so this is the
      // belt to that braces — but "no ledger row" is the only safe reading of a
      // fill quantity that is zero or unknown.
      if (filled !== undefined && filled > 0 && cost !== undefined) {
        const idx: 0 | 1 = decision.action === 'BUY_YES' ? 0 : 1;
        const strategy: FillStrategyMeta = {
          asset: decision.symbol.split('-')[0],
          outcome: idx === 0 ? 'YES' : 'NO',
          horizon: decision.horizon,
          horizonTier: decision.horizonTier,
          fairForSide: target.fairForSide,
          quoted: target.quoted,
          entryPrice: paidPrice,
          rawEdge: round4(target.fairForSide - target.quoted),
          retainedEdge: round4(target.fairForSide - paidPrice),
          requiredEdge: decision.requiredEdge,
          decisionTs: decision.ts,
          freshness: decision.freshness,
          strategyVersion: STRATEGY_VERSION,
          modelVersion: MODEL_VERSION,
          expiry: target.expiry,
        };
        // `filled`, not the requested size: the cost basis is what the position
        // actually cost. See `resolveFill` for why it is priced at the placed
        // limit and why that errs conservatively.
        recordFill(target.marketId, idx, filled, cost, {
          symbol: live.symbol,
          gasNative,
          strategy,
        });
        // A position actually opened, so the venue and our crossing logic both
        // work — isolated earlier failures should not accumulate toward a pause.
        if (live.txHash) clearExecutionFailures();
      } else {
        // Gas spent, no position. That is the definition of an execution failure,
        // and a run of them should stop the agent rather than be retried on a timer.
        // The gas still has to be booked somewhere or the cost of running the agent
        // quietly excludes every attempt that failed.
        if (gasNative !== undefined) recordGas(gasNative, 'order produced no position', live.txHash);
        recordExecutionFailure(`order filled ${filled ?? 'an unknown quantity'} of ${target.size}`);
      }
    }
    return live;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // An IOC that finds nothing reverts `ImmediateOrCancelNoFill()`. That is the
    // book moving between our read and our send — normal taker behaviour, not a
    // malfunction. Label it plainly so the audit trail doesn't read as breakage.
    // It still counts as an execution failure: it costs gas and produced no
    // position, and a run of them means our crossing price is mispriced or the
    // venue is unhealthy — either way, stopping beats retrying on a timer.
    if (/ImmediateOrCancelNoFill/i.test(msg)) {
      recordExecutionFailure('IOC found no fill');
      return reject(`no fill — book moved before the order landed (IOC)`, target);
    }
    warn('live order rejected:', msg);
    recordExecutionFailure(`live submit failed: ${msg}`);
    // Keep the routed symbol/price on the entry — a failed attempt on the NO
    // outcome should not be recorded against the YES window.
    return reject(`live submit failed: ${msg}`, target);
  }
}

/** Open-position accounting for the `maxOpenPositions` gate.
 *
 *  Baseline comes from real on-chain exposure once per cycle; orders accepted
 *  during the cycle are added on top, so the limit binds within a single cycle
 *  too. In DRY_RUN the baseline is 0 (there is no real exposure) but the
 *  in-cycle counter still applies — otherwise the gate never fires in dry-run
 *  and a $25/3-position config visibly places six orders, which reads as
 *  "the limits don't work".                                                   */
let openBaseline = 0;
let openedThisCycle = 0;
/** Collateral this cycle has already committed, in tUSDC.
 *
 *  Separate from `openBaseline` because it has to bind WITHIN one cycle: the
 *  ledger-derived baseline is read once at cycle start, so without an in-cycle
 *  accumulator a single cycle could place a dozen orders that each individually
 *  fit the exposure budget and jointly blow through it. That is exactly what
 *  happened on 2026-08-30 — four ~$1000 orders inside five minutes. */
let openedNotionalThisCycle = 0;
/** Collateral already at risk in positions that have not settled, read once per
 *  cycle from the P&L ledger. */
let openNotionalBaseline = 0;
/** Per-run trade count requested by the caller. When set it overrides both the
 *  stored `tradeQuota` budget and `maxOrdersPerCycle`, and is not persisted. */
let cycleRequestedTrades: number | undefined;
/** Per-run rule overrides (size/edge/symbols) layered on top of the saved config
 *  for this cycle only — never written back to disk. */
let cycleRulesOverride: Partial<AgentConfigDoc> | undefined;
/** Open exposure per marketId at cycle start; accepted orders increment their
 *  entry so `maxPerMarket` binds within a single cycle too. */
let openByMarket = new Map<string, number>();
/** Open positions per expiry timestamp, and per outcome side. Both feed the
 *  correlation caps, and both need the same in-cycle-plus-baseline treatment as
 *  every other exposure limit: the whole point is to catch a BATCH, and a batch
 *  lands inside one cycle. */
let openByExpiry = new Map<number, number>();
let openByDirection = new Map<'YES' | 'NO', number>();

/** Book one accepted order against every in-cycle exposure counter.
 *
 *  One function rather than six increments at three call sites: the dry-run path,
 *  the live path and any future path must all count identically, and the last time
 *  these were updated by hand one of them was missed. */
function countAccepted(target: ExecutionTarget, notional: number): void {
  openedThisCycle++;
  openedNotionalThisCycle += notional;
  // The wallet balance is cached, so tell it what we just spent — otherwise the next
  // order in this cycle compares its cost against a balance that predates this one.
  noteCommitted(notional);
  if (target.marketId) openByMarket.set(target.marketId, (openByMarket.get(target.marketId) ?? 0) + 1);
  if (target.expiry !== undefined) openByExpiry.set(target.expiry, (openByExpiry.get(target.expiry) ?? 0) + 1);
  openByDirection.set(target.outcome, (openByDirection.get(target.outcome) ?? 0) + 1);
}

export async function beginCycle(
  dryRun: boolean,
  opts?: {
    maxTrades?: number;
    maxTradeSize?: number;
    minEdge?: number;
    symbols?: string[];
  },
): Promise<void> {
  cycleRequestedTrades = opts?.maxTrades;
  const o: Partial<AgentConfigDoc> = {};
  if (opts?.maxTradeSize !== undefined) o.maxTradeSize = opts.maxTradeSize;
  if (opts?.minEdge !== undefined) o.minEdge = opts.minEdge;
  if (opts?.symbols !== undefined) o.symbols = opts.symbols;
  cycleRulesOverride = Object.keys(o).length > 0 ? o : undefined;
  openedThisCycle = 0;
  openedNotionalThisCycle = 0;
  openByExpiry = new Map();
  openByDirection = new Map();
  if (dryRun) {
    openBaseline = 0;
    openNotionalBaseline = 0;
    openByMarket = new Map();
    return;
  }
  openNotionalBaseline = openNotional();
  // Correlation baselines come from the ledger, which is the only record of which
  // expiry and which side each open position is on — the chain knows balances, not
  // intent. Positions filled before `expiry` was captured contribute nothing here;
  // that under-counts rather than over-counts, and the in-cycle counter still binds.
  for (const p of openPositions()) {
    if (p.expiry !== undefined) openByExpiry.set(p.expiry, (openByExpiry.get(p.expiry) ?? 0) + 1);
    const side: 'YES' | 'NO' = p.outcomeIdx === 0 ? 'YES' : 'NO';
    openByDirection.set(side, (openByDirection.get(side) ?? 0) + 1);
  }
  try {
    const { countOpenByMarket } = await import('./settlement');
    openByMarket = await countOpenByMarket();
    let n = 0;
    for (const c of openByMarket.values()) n += c;
    openBaseline = n;
  } catch (err) {
    // Fail closed-ish: an unknown baseline shouldn't silently widen the mandate,
    // but it also shouldn't stop the agent. Assume the limit is already met.
    warn('could not read open positions, treating limit as reached:', (err as Error).message);
    openBaseline = Number.MAX_SAFE_INTEGER;
    openByMarket = new Map();
  }

  // Pay for the balance read HERE, before the caller reads spot.
  //
  // This is a latency fix, not a correctness one, and it is worth spelling out because
  // the symptom looked nothing like the cause. `canAfford` walks every currency the
  // venue lists plus every outcome token held — measured at ~20s cold on this wallet.
  // It used to run lazily, inside the FIRST `executeDecision`, which is after the cycle
  // has already built its signal context. So the first order paid 20s and every decision
  // behind it inherited a spot reading 20s+ old, which `dataFresh` then rejected against
  // `maxDataAgeMs` (15s). Orders 2..N were refused as stale no matter how much edge they
  // had, and `maxOrdersPerCycle: 5` could never mean more than 1.
  //
  // Reversed, the ordering matches how fast each input actually moves: balances change
  // slowly and are read once up front; spot changes fast and is read last, right before
  // it is judged. Forced, so a cycle never opens on a cached balance from the last one.
  //
  // Skipped in dry-run: nothing is spent, so there is nothing to afford, and a rehearsal
  // should not spend 20s on a number it will not use.
  try {
    await walletSnapshot(true);
  } catch (err) {
    // Non-fatal by design. `canAfford` fails OPEN on an unreadable balance, so a failed
    // warm-up leaves the agent exactly as it was before this line existed — slower, not
    // broken.
    debug('beginCycle: wallet warm-up failed, canAfford will read lazily:', (err as Error).message);
  }
}

function openPositionCount(): number {
  return openBaseline + openedThisCycle;
}

/** Place one order OUTSIDE a decision cycle — the manual-approval path.
 *
 *  Every exposure counter in this file is per-cycle module state established by
 *  `beginCycle`, and `beginCycle` is only called from `runCycle`. So a caller that
 *  reached `executeDecision` directly — `POST /agent/confirm` did, in a separate
 *  HTTP request minutes later — ran against whatever the last cycle happened to
 *  leave behind. Worse: a cycle that only produced PENDING trades never executes
 *  anything, so it leaves `openedThisCycle` at zero. Confirming ten pending trades
 *  sailed straight through maxOpenPositions, maxOpenNotional, maxPerMarket and both
 *  correlation caps, because as far as the broker knew nothing had been placed.
 *
 *  Two things fix it, and both are needed:
 *   - re-establish the baselines from real chain and ledger state before the order,
 *     so the limits are measured against reality rather than a stale snapshot;
 *   - serialise, because two confirms arriving together would each read the same
 *     baseline and each believe it had room. That is the same failure the cycle
 *     guard already prevents for the automatic path.                            */
let standaloneGate: Promise<unknown> = Promise.resolve();

export function executeStandaloneDecision(decision: Decision): Promise<OrderLog> {
  const run = standaloneGate.then(async () => {
    const rules = loadAgentConfig();
    await beginCycle(effectiveDryRun(rules));
    return executeDecision(decision);
  });
  // Keep the queue alive even if one order rejects.
  standaloneGate = run.catch(() => undefined);
  return run;
}

/** Collateral at risk right now: positions carried into this cycle plus whatever
 *  this cycle has already committed. */
function openNotionalTotal(): number {
  return openNotionalBaseline + openedNotionalThisCycle;
}

interface OrderExecution extends OrderLog {
  id: string;
}

function buildOrder(
  d: Decision,
  status: OrderLog['status'],
  reason: string | undefined,
  dryRun: boolean,
  target?: ExecutionTarget,
): OrderExecution {
  return {
    id: randomUUID().slice(0, 8),
    ts: Date.now(),
    decisionId: d.id,
    // The symbol/price actually routed once known; before routing (rejections)
    // fall back to the decision's window so the entry is still attributable.
    symbol: target?.symbol ?? d.symbol,
    marketId: target?.marketId,
    side: target?.side ?? 'buy',
    price: target?.price ?? (d.action === 'BUY_YES' ? d.ask : d.bid),
    size: target?.size ?? d.size,
    timeInForce: 'IOC',
    dryRun,
    status,
    reason,
    // What the trade was really taken on, once routing is known: crossing the
    // touch spends part of the decision's edge, so the decision's number alone
    // overstates what we actually bought.
    retainedEdge: target ? round4(target.fairForSide - target.price) : undefined,
    requiredEdge: d.requiredEdge,
    freshness: d.freshness,
    strategyVersion: STRATEGY_VERSION,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}