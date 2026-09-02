export interface NormalizedMarket {
  symbol: string;
  kind: 'spot' | 'event';
  base: string;
  quote: string;
  contract: string;
  lotSize: string;
  tickSize: string;
  minQuantity: string;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface BookTicker {
  symbol: string;
  ts: number;
  bid?: number;
  ask?: number;
  mid?: number;
  raw?: unknown;
}

export type DecisionAction = 'BUY_YES' | 'BUY_NO' | 'PASS' | 'CLAIM';

/** How old the inputs behind a decision were, in milliseconds.
 *
 *  Recorded because "the model said 63%" means nothing without knowing whether
 *  the spot price it compared against was two seconds or two minutes old. A
 *  five-minute contract priced off a stale oracle is a guess wearing a
 *  probability, and the broker refuses it rather than trading blind. */
export interface DataFreshness {
  spotAgeMs?: number;
  candleAgeMs?: number;
  bookAgeMs?: number;
}

export interface Decision {
  id: string;
  ts: number;
  symbol: string;
  fair: number;
  mid: number;
  ask: number;
  bid: number;
  edge: number;
  action: DecisionAction;
  size: number;
  /** Window class this decision was taken in, e.g. `15m`, `4h`. */
  horizon?: string;
  /** Whether the model's calibration is measured at this horizon. `provisional`
   *  trades were placed at a raised edge bar and reduced stake — recorded so a
   *  later study can split performance by regime rather than pooling them. */
  horizonTier?: 'validated' | 'provisional';
  /** The edge bar this decision actually had to clear (operator `minEdge` scaled
   *  by the horizon tier). Recorded so a later study can bucket trades by the
   *  rule that admitted them instead of guessing which threshold was live. */
  requiredEdge?: number;
  /** Age of the market data this decision was computed from. */
  freshness?: DataFreshness;
  pricedNote?: string;
  reason: string;
  dryRun: boolean;
}

export type OrderSide = 'buy' | 'sell';
export type OrderTimeInForce = 'IOC' | 'GTC' | 'FOK';

export interface OrderLog {
  id: string;
  ts: number;
  decisionId: string;
  symbol: string;
  /** bytes32 market id of the window traded. Recorded so an auditor (or a
   *  scoring script) can tie an order to its settlement without parsing the
   *  symbol string, which encodes asset/strike/expiry in a format that has
   *  changed before. */
  marketId?: string;
  side: OrderSide;
  price: number;
  size: number;
  timeInForce: OrderTimeInForce;
  dryRun: boolean;
  txHash?: string;
  status: 'simulated' | 'submitted' | 'rejected';
  reason?: string;
  /** Quantity the venue actually filled, human units. Present on live orders.
   *  An IOC that exhausts the depth at its limit fills partially, so this — not
   *  `size` — is what the position is worth. */
  filledSize?: number;
  /** SDK lifecycle state for a live order: `closed` = fully filled,
   *  `canceled` = IOC remainder that could not rest. */
  fillStatus?: string;
  /** Gas paid for this order, in the chain's native token. */
  gasNative?: number;
  /** Edge left AFTER crossing the touch — fair value for the outcome bought minus
   *  the price actually sent. This, not the decision's edge, is what the trade was
   *  really taken on: crossing spends part of the edge to buy a fill. */
  retainedEdge?: number;
  /** The edge bar this order had to clear. */
  requiredEdge?: number;
  /** Age of the market data behind the decision, in ms. */
  freshness?: DataFreshness;
  /** Which agent produced this order. */
  strategyVersion?: string;
}

/** Everything a settled trade needs to be graded later, captured at fill time.
 *
 *  Stored on the P&L ledger row rather than recomputed afterwards: the book, the
 *  oracle and the window are all gone by the time a contract settles, so a number
 *  not written down now cannot be recovered honestly. Rows without it (anything
 *  filled before this shipped) are reported as unavailable for attribution rather
 *  than reconstructed from the symbol string. */
export interface FillStrategyMeta {
  asset?: string;
  /** Which outcome was actually bought. Up buys YES, Down buys NO. */
  outcome: 'YES' | 'NO';
  horizon?: string;
  horizonTier?: 'validated' | 'provisional';
  /** Model fair probability expressed for the outcome bought (NO = 1 - fair). */
  fairForSide: number;
  /** Best visible price for that outcome when the decision was taken. */
  quoted: number;
  /** Price actually sent — the IOC crossing price. */
  entryPrice: number;
  /** fairForSide - quoted: the edge the decision was based on. */
  rawEdge: number;
  /** fairForSide - entryPrice: the edge that survived execution. */
  retainedEdge: number;
  requiredEdge?: number;
  decisionTs: number;
  freshness?: DataFreshness;
  strategyVersion: string;
  modelVersion: string;
  /** Window expiry (unix seconds). Stored so a later study — and the correlation
   *  caps — can bucket positions by the moment they all settle on, without parsing
   *  the symbol string. */
  expiry?: number;
}

export interface ProofEntry {
  id: string;
  ts: number;
  prevHash: string;
  payloadHash: string;
  signature?: string;
  kind: 'decision' | 'order' | 'claim' | 'config';
  payload: Record<string, unknown>;
}

export type EdgePreset = 'very-sure' | 'middle' | 'a-bit-sure';

export interface AgentConfigDoc {
  symbols: string[];
  maxTradeSize: number;
  maxOpenPositions: number;
  minEdge: number;
  edgePreset?: EdgePreset;
  intervalMs: number;
  mode: 'dry-run' | 'live' | 'view';
  claimEnabled: boolean;
  /** Hard cap on orders per distinct window (marketId) while it is open.
   *  Bounds the "re-buy the same collapsing window" pattern observed live
   *  2026-08-25/26: three consecutive cycles averaged into one dying 5m window.
   *  0 = unlimited (not recommended). */
  maxPerMarket: number;
  /** Hard cap on orders accepted in a single cycle. 0 = no per-cycle cap.
   *  `maxOpenPositions` bounds concurrent EXPOSURE, which is a different thing:
   *  positions settling mid-cycle free slots, so exposure limits alone cannot
   *  express "place at most N orders". */
  maxOrdersPerCycle: number;
  /** Total remaining trades the agent is authorised to place. null = unlimited.
   *  Decremented on every accepted order and persisted, so "do exactly 3 trades"
   *  survives restarts and settlement timing. At 0 the agent stops trading. */
  tradeQuota: number | null;
  /** Realised loss (tUSDC) tolerated within one UTC day before the agent pauses
   *  itself. 0 = no limit. Per-trade size bounds ONE bad decision; this bounds a
   *  bad session, which is the failure that actually empties an account. */
  maxDailyLoss: number;
  /** Total collateral (tUSDC) allowed to sit in positions that have not settled
   *  yet. 0 = no limit.
   *
   *  This is the gap `maxDailyLoss` cannot close. A daily loss limit bounds
   *  REALISED loss, and a binary only realises when its window settles — so a
   *  batch of orders placed inside one interval is entirely unbounded by it.
   *  Observed 2026-08-30: four ~$1000 orders went out between 18:41 and 18:46
   *  and all four settled together at 19:17, putting $4000 at risk under a $1000
   *  daily-loss limit that had nothing to fire on until every one of them had
   *  already resolved. `maxOpenPositions` did not help either — it counts
   *  positions, not dollars. */
  maxOpenNotional: number;
  /** Realised loss from the equity PEAK tolerated before the agent pauses itself,
   *  in tUSDC. 0 = no limit (the default, so this can never halt an agent on
   *  history it did not consent to).
   *
   *  `maxDailyLoss` resets at UTC midnight, so an agent bleeding just under the
   *  limit every day never trips it and never stops. Drawdown is the limit that
   *  bounds a losing WEEK, measured peak-to-trough over the whole settled ledger
   *  rather than inside an arbitrary calendar boundary. */
  maxDrawdown: number;
  /** Per-trade cap as a fraction of equity (collateral + open cost), e.g. 0.02 for
   *  2%. 0 = off, and `maxTradeSize` alone applies.
   *
   *  An absolute cap does not scale: $5 a trade is 1% of a $500 account and 10% of
   *  the same account after it has lost 90%. Sizing on a fraction shrinks exposure
   *  automatically as the account shrinks, which is the behaviour that keeps a bad
   *  run from compounding. Whichever of the two is SMALLER binds. */
  maxTradeSizePctEquity: number;
  /** Concurrent positions allowed to share one expiry timestamp. 0 = no limit.
   *
   *  `maxOpenPositions` counts positions and cannot see that BTC-UP-1230 and
   *  ETH-UP-1230 settle on the same tick against correlated assets — ten "separate"
   *  positions can be ten expressions of one macro view, and they win or lose
   *  together. This caps how much of the book rides on a single moment. */
  maxPerExpiryBucket: number;
  /** Concurrent positions allowed on the same side (all YES, or all NO). 0 = no
   *  limit. A model with a directional bias fills the book with one direction and
   *  calls it diversification. */
  maxSameDirection: number;
  /** Oldest a settlement sweep may be before the agent refuses to add risk, in ms.
   *  0 = no limit.
   *
   *  The loss breakers read the P&L ledger, and the ledger only learns about a
   *  settled position when a sweep runs. If sweeps stop — indexer down, no gas,
   *  redeem reverting — `maxDailyLoss` and `maxConsecutiveLosses` silently read
   *  stale data while real money is lost. Refusing to open new risk on unverifiable
   *  losses is the only honest response. Only enforced while positions are open. */
  maxSettlementAgeMs: number;
  /** Newly-settled losses in a row tolerated before the agent pauses itself.
   *  0 = no limit. A streak is the cheapest available signal that the model and
   *  the current regime disagree. */
  maxConsecutiveLosses: number;
  /** Live order attempts that produce no position (revert, no-fill, locked
   *  window, insufficient gas) tolerated before the agent pauses itself.
   *  0 = no limit. Each one costs gas, so a venue or crossing problem should stop
   *  the agent rather than being retried on a timer. */
  maxExecutionFailures: number;
  /** Oldest market data a decision may be acted on, in ms. 0 = no limit.
   *  A five-minute contract priced off a minute-old oracle is not a forecast. */
  maxDataAgeMs: number;
  /** Kill switch. While true the broker refuses every order, in dry-run and live
   *  alike. Set by the operator or by a tripped circuit breaker; only an explicit
   *  operator action clears it. Existing positions are untouched and still settle
   *  and claim normally — this stops NEW risk, it does not liquidate. */
  tradingPaused: boolean;
  /** Why trading is paused, and when it happened. Kept only while paused. */
  pauseReason?: string;
  pausedAt?: number;
}

export interface SignalInput {
  symbol: string;
  mid: number;
  bid: number;
  ask: number;
}

export interface SignalResult {
  fair: number;
  note?: string;
}