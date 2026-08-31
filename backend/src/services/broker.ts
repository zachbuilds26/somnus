import { randomUUID } from 'node:crypto';
import { MODEL_VERSION, STRATEGY_VERSION, warn } from '../config';
import { consumeTradeQuota, effectiveDryRun, loadAgentConfig } from '../agent-config';
import type { AgentConfigDoc } from '../types';
import { findEventMarket, sessionSignerAddress } from './sdk';
import { appendEntry } from './store';
import { recordFill } from './pnl';
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

  return { symbol, price, side: 'buy', size, marketId, quoted: round4(quoted), fairForSide: round4(fairForSide) };
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

  // Clamp rather than reject. The decision was sized against the rules as they
  // were when the cycle started; if the operator tightened the limit mid-cycle
  // the honest response is to trade smaller, not to throw the trade away with a
  // confusing "notional 5.00 > maxTradeSize 2". The limit still binds — it is
  // just enforced by sizing down instead of refusing.
  const affordable = Math.floor(rules.maxTradeSize / costPerContract);
  const sized = Math.min(decision.size, affordable);
  if (sized < 1) {
    return reject(
      `maxTradeSize ${rules.maxTradeSize} buys no whole contract at ${costPerContract.toFixed(4)}`,
    );
  }

  if (decision.edge < rules.minEdge) {
    return reject(`edge ${decision.edge} < minEdge ${rules.minEdge}`);
  }

  // "Do exactly N trades" is its own constraint, not a consequence of exposure
  // limits: positions settling mid-cycle free up `maxOpenPositions` slots, so
  // that gate alone cannot bound how many orders get placed.
  // A per-run `trades` request (e.g. from the coding-agent MCP tool) overrides
  // the stored budget entirely; when absent we still enforce the persisted quota.
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
    target = await resolveExecution({ ...decision, size: sized }, rules.maxTradeSize);
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

  const sessionOwnerAddr = cycleSessionSeed ? sessionSignerAddress(cycleSessionSeed) : undefined;
  const base: OrderLog = buildOrder(
    decision,
    'simulated',
    'DRY_RUN (default safe mode)',
    dryRun,
    target,
    sessionOwnerAddr,
  );
  if (dryRun) {
    openedThisCycle++;
    if (target.marketId) openByMarket.set(target.marketId, (openByMarket.get(target.marketId) ?? 0) + 1);
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
    const { isMarketTrading, nativeGasBalance, getSessionExchangeReady } = await import('./sdk');
    // Trades pay GAS in the native token even though collateral is tUSDC. A key
    // with collateral but no STT reverts at `approve` with a misleading error
    // and wastes gas — refuse early with a clear reason instead.
    const gas = await nativeGasBalance(sessionOwnerAddr);
    const MIN_GAS_STT = 0.02;
    if (gas !== undefined && Number(gas) / 1e18 < MIN_GAS_STT) {
      const why = `native gas too low (${(Number(gas) / 1e18).toFixed(4)} STT) — fund the trade key with STT before trading`;
      recordExecutionFailure(why);
      return reject(why, target);
    }
    if (target.marketId && !(await isMarketTrading(target.marketId))) {
      recordExecutionFailure('window already locked on-chain');
      return reject('window already locked on-chain (indexer was stale)', target);
    }
    const { placeLiveOrder, placeLiveOrderOn } = await import('./sdk-live');
    let result: LiveOrderResult;
    if (cycleSessionSeed) {
      // Trade AS the visitor's funded session account (non-custodial of their
      // main wallet). The operator key is never used for visitor orders.
      const ex = await getSessionExchangeReady(cycleSessionSeed);
      result = await placeLiveOrderOn(ex, {
        symbol: target.symbol,
        price: target.price,
        size: target.size,
      });
    } else {
      result = await placeLiveOrder({
        symbol: target.symbol,
        price: target.price,
        // target.size, not decision.size: the size was recomputed at the crossing
        // price so the notional gate still holds at what we actually pay.
        size: target.size,
      });
    }
    const live: OrderLog = {
      ...base,
      status: 'submitted',
      txHash: result.txHash || undefined,
      reason: result.reason,
      owner: sessionOwnerAddr,
    };
    openedThisCycle++;
    if (target.marketId) openByMarket.set(target.marketId, (openByMarket.get(target.marketId) ?? 0) + 1);
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
      const idx: 0 | 1 = decision.action === 'BUY_YES' ? 0 : 1;
      const strategy: FillStrategyMeta = {
        asset: decision.symbol.split('-')[0],
        outcome: idx === 0 ? 'YES' : 'NO',
        horizon: decision.horizon,
        horizonTier: decision.horizonTier,
        fairForSide: target.fairForSide,
        quoted: target.quoted,
        entryPrice: live.price,
        rawEdge: round4(target.fairForSide - target.quoted),
        retainedEdge: round4(target.fairForSide - live.price),
        requiredEdge: decision.requiredEdge,
        decisionTs: decision.ts,
        freshness: decision.freshness,
        strategyVersion: STRATEGY_VERSION,
        modelVersion: MODEL_VERSION,
      };
      recordFill(target.marketId, idx, live.size, live.price * live.size, {
        symbol: live.symbol,
        strategy,
      });
      // A position actually opened, so the venue and our crossing logic both
      // work — isolated earlier failures should not accumulate toward a pause.
      if (live.txHash) clearExecutionFailures();
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
/** Per-run trade count requested by the caller (e.g. an MCP `somnus_run` with
 *  `trades`). When set it overrides both the stored `tradeQuota` budget and
 *  `maxOrdersPerCycle`, and is NOT persisted — the agent chooses per run. */
let cycleRequestedTrades: number | undefined;
/** Per-run rule overrides (size/edge/symbols) layered on top of the saved config
 *  for this cycle only — never written back to disk. */
let cycleRulesOverride: Partial<AgentConfigDoc> | undefined;
/** Per-run session seed: when set, orders are placed through the visitor's
 *  funded session account instead of the operator's trade key. */
let cycleSessionSeed: `0x${string}` | undefined;
/** Open exposure per marketId at cycle start; accepted orders increment their
 *  entry so `maxPerMarket` binds within a single cycle too. */
let openByMarket = new Map<string, number>();

export async function beginCycle(
  dryRun: boolean,
  opts?: {
    maxTrades?: number;
    maxTradeSize?: number;
    minEdge?: number;
    symbols?: string[];
    sessionSeed?: `0x${string}`;
  },
): Promise<void> {
  cycleRequestedTrades = opts?.maxTrades;
  cycleSessionSeed = opts?.sessionSeed;
  const o: Partial<AgentConfigDoc> = {};
  if (opts?.maxTradeSize !== undefined) o.maxTradeSize = opts.maxTradeSize;
  if (opts?.minEdge !== undefined) o.minEdge = opts.minEdge;
  if (opts?.symbols !== undefined) o.symbols = opts.symbols;
  cycleRulesOverride = Object.keys(o).length > 0 ? o : undefined;
  openedThisCycle = 0;
  if (dryRun) {
    openBaseline = 0;
    openByMarket = new Map();
    return;
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
}

function openPositionCount(): number {
  return openBaseline + openedThisCycle;
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
  owner?: string,
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
    owner,
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