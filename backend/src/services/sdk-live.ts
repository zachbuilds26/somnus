import type { SomniaMarkets } from '@somnia-chain/markets-sdk';
import { getTradingExchangeReady, withRetry } from './sdk';

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
  const exchange = await getTradingExchangeReady(false);
  return placeLiveOrderOn(exchange, p);
}

/** Place one event-contract order on a SPECIFIC exchange instance (e.g. a
 *  per-user Agent Studio wallet). Same recovery semantics as {@link placeLiveOrder}
 *  but the caller owns the signing client, so the operator's trade key and a
 *  user's key can both route through the same logic. */
export async function placeLiveOrderOn(
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

  if (receipt?.status === 'reverted') {
    throw new Error(`order reverted on-chain${txHash ? ` (${txHash})` : ''}`);
  }
  if (!txHash) {
    return { reason: `${status} on ${p.symbol} @ ${p.price}` };
  }
  return { txHash, reason: `${status} on ${p.symbol} @ ${p.price} in ${txHash}` };
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
