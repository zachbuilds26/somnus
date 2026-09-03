import { getTradingExchangeReady, withRetry } from './sdk';
import type { SomniaMarkets } from '@somnia-chain/markets-sdk';

export interface LiveOrderParams {
  /** The outcome symbol to trade — already resolved by the broker (YES for an
   *  Up leg, NO for a Down leg). */
  symbol: string;
  /** Crossing limit price in that symbol's own terms, strictly inside (0,1). */
  price: number;
  size: number;
}

export interface LiveOrderResult {
  txHash?: string;
  reason: string;
  /** Quantity ACTUALLY filled, human units — the SDK sums it from the pool's
   *  `OrderFilled` events, so it is what the position is really worth.
   *
   *  This is not the size we asked for. An IOC that exhausts the depth at its
   *  limit fills partially and cancels the remainder (`status: 'canceled'`), and
   *  a cost basis recorded against the REQUESTED size then overstates the spend
   *  by whatever never traded. That happened on 2026-08-30: 1976 contracts
   *  requested at 0.506, 990 filled, and the ledger booked $999.86 against a
   *  position that cost ~$501 and paid out $990 — a $489 winner recorded as a
   *  $10 loser. */
  filled?: number;
  /** Quantity actually placed, after the venue floors it onto the lot grid.
   *  `createOrder` snaps this DOWN, so it can be below what we sent. */
  placedAmount?: number;
  /** Limit price actually placed, after the venue snaps it onto the tick grid.
   *  A buy snaps DOWN, so this is never worse than the price we sent. */
  placedPrice?: number;
  /** SDK lifecycle state: `closed` = fully filled, `canceled` = IOC remainder
   *  that could not rest, `open` = resting (never, for IOC). */
  status?: string;
  /** The raw transaction receipt, when one came back. Carries `gasUsed` and
   *  `effectiveGasPrice`, which is the only place the cost of running the agent is
   *  observable — gas is paid in the native token and never appears in tUSDC P&L. */
  receipt?: unknown;
}

/** Place one event-contract order for real (IOC so nothing rests unseen).
 *  Only reachable when the broker already verified limits + mode=live and
 *  resolved which outcome to buy. Uses the trade/session key — never the
 *  read-only client.
 *
 *  Always a BUY. Both directions are expressed as buying an outcome: Up buys
 *  YES, Down buys NO. Selling an outcome you don't hold is a naked short, which
 *  the pool refuses with `InsufficientBalance()`; buying is collateral-funded.
 *
 *  Order expiry is left to the SDK, which defaults `expireTimestampNs` to the
 *  market's own expiry — the pool rejects anything beyond it
 *  (`OrderExpiryBeyondMarket`) and `0` reverts `OrderAlreadyExpired`.        */
export async function placeLiveOrder(p: LiveOrderParams): Promise<LiveOrderResult> {
  return placeOrderOn(await getTradingExchangeReady(false), p);
}

/** The same submission, on a signer the caller supplies.
 *
 *  Exists for per-user wallets: the SDK binds one account per client at
 *  construction, so a derived user wallet signs through its own instance (see
 *  `getUserExchangeReady`). Everything downstream of the signature is identical
 *  and deliberately shared — the lot-grid refusal, the stale-symbol retry, the
 *  revert check and the read-what-actually-happened accounting are properties of
 *  the venue, not of whose key paid, and a second copy of them would drift.   */
export async function placeOrderOnExchange(
  exchange: SomniaMarkets,
  p: LiveOrderParams,
): Promise<LiveOrderResult> {
  return placeOrderOn(exchange, p);
}

async function placeOrderOn(
  exchange: SomniaMarkets,
  p: LiveOrderParams,
): Promise<LiveOrderResult> {
  let order: Record<string, any>;
  try {
    order = await submitOn(exchange, p, false);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    // Two recoverable staleness failures, both fixed by rebuilding the signing
    // client's symbol table and trying once more:
    //   "unknown symbol"        — window minted after the table hydrated;
    //   "Missing or invalid     — window KNOWN to the table but indexed before
    //    parameters"              its outcome tokenIds landed, so the order
    //                             is built with undefined fields. Fresh windows
    //            	                are exactly the ones worth trading, so this
    //                             fired within minutes of every new class batch
    //                             once volume moved to just-minted windows.
    // viem simulates before broadcasting, so neither path spends gas.
    if (!/unknown symbol/i.test(msg) && !/missing or invalid parameters/i.test(msg)) throw err;
    order = await submitOn(exchange, p, true);
  }

  // Unified verbs return a UnifiedOrder with NO `receipt` field — the raw
  // result is wrapped in `info`. Reading `order.receipt` is always undefined
  // and silently disables this check.
  const receipt = order?.info?.receipt;
  const txHash: string | undefined =
    typeof receipt?.transactionHash === 'string' ? receipt.transactionHash : undefined;
  const status: string = typeof order?.status === 'string' ? order.status : 'unknown';

  // What the venue actually did, as opposed to what we asked it to do. The SDK
  // aligns the quantity down to the lot grid and the price down to the tick grid
  // before placing, then reports the filled quantity summed from the pool's
  // OrderFilled events. All three can differ from our request, and the caller
  // needs the real numbers to record an honest cost basis.
  const filled = num(order?.filled);
  const placedAmount = num(order?.amount);
  const placedPrice = num(order?.price);

  if (receipt?.status === 'reverted') {
    throw new Error(`order reverted on-chain${txHash ? ` (${txHash})` : ''}`);
  }
  const fillNote =
    filled !== undefined && placedAmount !== undefined && filled < placedAmount
      ? ` (filled ${filled}/${placedAmount})`
      : '';
  if (!txHash) {
    return { reason: `${status} on ${p.symbol} @ ${p.price}`, filled, placedAmount, placedPrice, status, receipt };
  }
  return {
    txHash,
    reason: `${status} on ${p.symbol} @ ${placedPrice ?? p.price}${fillNote} in ${txHash}`,
    filled,
    placedAmount,
    placedPrice,
    status,
    receipt,
  };
}

/** A finite non-negative number, or undefined. Anything else is unusable as a
 *  cost basis and must read as "unknown" rather than as zero. */
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function submitOn(
  exchange: SomniaMarkets,
  p: LiveOrderParams,
  forceReload: boolean,
): Promise<Record<string, any>> {
  if (forceReload && typeof (exchange as Record<string, any>).loadMarkets === 'function') {
    await withRetry('trade loadMarkets', () =>
      (exchange as Record<string, any>).loadMarkets(true),
    );
  }
  // The venue trades whole lots on a fixed grid, and the SDK floors the
  // requested size onto it. A size below one lot floors to ZERO — and an order
  // for 0 is not an order, it is a revert plus gas. Read the snapped value
  // back and refuse here so the audit trail shows a clean rejection instead.
  const ex = exchange as Record<string, any>;
  if (typeof ex.amountToPrecision === 'function') {
    const snapped = Number(ex.amountToPrecision(p.symbol, p.size));
    if (!Number.isFinite(snapped) || snapped <= 0) {
      throw new Error(
        `size ${p.size} rounds to ${snapped} on ${p.symbol}'s lot grid — refusing to send`,
      );
    }
  }
  return (await exchange.createOrder(p.symbol, 'limit', 'buy', p.size, p.price, {
    timeInForce: 'IOC',
  })) as Record<string, any>;
}
