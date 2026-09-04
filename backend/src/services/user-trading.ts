import { randomUUID } from 'node:crypto';
import { config, debug, warn } from '../config';
import { loadAgentConfig } from '../agent-config';
import { crossingPrice, resolveFill } from './broker';
import { clockState } from './clock';
import { horizonPolicy, type TradeablePolicy } from './horizon';
import { decideFromFair } from './pricing';
import { dataFresh, riskStatus } from './risk';
import {
  eventBook,
  getUserExchange,
  getUserExchangeReady,
  isMarketTrading,
  listEventMarketRows,
  nativeGasBalance,
  type EventMarketRow,
} from './sdk';
import { placeOrderOnExchange } from './sdk-live';
import { buildSignalContext, estimateFair, type SignalContext } from './signal';
import { findClaimable, heldPositions, type ClaimableRow } from './settlement';
import { appendEntry } from './store';
import { gasCostFromReceipt, pickCollateral } from './wallet';
import type { UserIdentity } from '../mcp/identity';

/** Trading from a wallet derived for one caller, rather than from the agent's own.
 *
 *  The hosted endpoint could only ever be read-only while the only wallet in the
 *  process was the operator's. This is the way past that without handing anything
 *  over: a caller supplies a token, `mcp/identity.ts` derives a wallet from it, and
 *  the agent's own model — same probability estimate, same horizon tiers, same edge
 *  bar, same crossing rule — prices a trade that the CALLER's wallet signs and pays
 *  for. Their money, their limits, the agent's brain. The operator's wallet is not
 *  reachable from here at all.
 *
 *  Deliberately NOT routed through `broker.executeDecision`. That path enforces the
 *  operator's mandate and books cost basis into the agent's P&L ledger, which drives
 *  the agent's own loss breakers. Feeding somebody else's trades into it would make
 *  the operator's daily-loss limit fire on a stranger's losses and would corrupt the
 *  ledger every risk limit reads. What IS shared is everything that bounds a single
 *  order: the model, the tier policy, `crossingPrice`, `resolveFill`, and the
 *  on-chain window-status check.
 *
 *  What a caller's trade is bounded by here:
 *    - testnet only. The derivation is custodial by construction (see identity.ts),
 *      so this refuses outright on mainnet rather than trusting a config knob.
 *    - `SOMNUS_USER_TRADING=live`. Absent, everything is priced and recorded but
 *      nothing is sent. The operator's DRY_RUN governs the operator's wallet; this
 *      is a separate switch because it authorises a different wallet's spending.
 *    - the operator's kill switch. A paused deployment adds no new risk of any kind.
 *    - `confirm: true` on the call that spends, so a stray tool call cannot buy.
 *    - a hard per-trade cap and a per-token hourly rate limit.
 *    - the wallet's own balances: it can only spend what the caller funded.        */

/** live = orders reach the chain. Anything else prices and records without sending.
 *  Read per call so an operator can flip it without a restart. */
export type UserTradingMode = 'live' | 'simulate';

export function userTradingMode(): UserTradingMode {
  return (process.env.SOMNUS_USER_TRADING ?? '').trim().toLowerCase() === 'live' ? 'live' : 'simulate';
}

/** Hard ceiling on collateral one caller's trade may risk, in tUSDC.
 *
 *  The point is not the number, it is that no argument to any tool can raise it.
 *  These are faucet-funded testnet wallets whose keys this process can derive, so
 *  the blast radius of a bug or a bad actor with a token is capped in code rather
 *  than in a saved config a tool could rewrite.
 *
 *  1000 suits the faucet's 10,000 tUSDC drip: ten trades at full size before a
 *  caller has to draw again, which is enough to demo a real position rather than a
 *  rounding error. It is also why `confirm: true` exists — at this cap a stray tool
 *  call would be a large bet, so nothing is ever sent on a single unconfirmed call. */
export function maxUserStake(): number {
  const n = Number(process.env.SOMNUS_USER_MAX_TRADE ?? 1000);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/** Floor under the edge a caller's trade must hold, whatever they ask for.
 *
 *  A caller can demand MORE edge than this; they cannot demand less. Without a
 *  floor, `minEdge: 0` turns the model's opinion into a coin flip and the tool
 *  into a way to spray gas at the book. */
export function userMinEdgeFloor(): number {
  const n = Number(process.env.SOMNUS_USER_MIN_EDGE ?? 0.02);
  return Number.isFinite(n) && n > 0 ? n : 0.02;
}

/** Confirmed sends per token per hour. Bounds a runaway agent loop — the most
 *  likely way a caller loses their balance is their own client retrying. */
export function userTradesPerHour(): number {
  const n = Number(process.env.SOMNUS_USER_TRADES_PER_HOUR ?? 20);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

/** Windows priced per quote. Each one costs a book read on a request a caller is
 *  waiting on, so this is smaller than the agent's own per-cycle universe. */
const SCAN_WINDOWS = Math.max(1, Number(process.env.SOMNUS_USER_SCAN_WINDOWS ?? 8));

/** Native balance a derived wallet must hold before it can transact at all.
 *
 *  Much larger than `MIN_GAS_NATIVE` (0.02), and not because transactions are
 *  expensive — a real order burns about 0.004 STT. The venue builds them with a
 *  10,000,000 gas limit at 60 gwei, and the node checks the WORST case against the
 *  balance before it will accept the transaction:
 *
 *      10,000,000 gas x 60 gwei = 0.6 STT of headroom required, ~0.004 actually spent
 *
 *  A wallet funded to the old floor therefore passed every local check and then died
 *  at the node with `insufficient balance` wrapped in the SDK's generic "Missing or
 *  invalid parameters" — which is exactly the discovery-by-failure this codebase keeps
 *  trying to replace with a sentence up front. Measured 2026-09-03 against a freshly
 *  derived wallet; re-derive it from a rejected transaction's `gas` and `maxFeePerGas`
 *  if the venue's defaults change. */
export function minUserGas(): number {
  const n = Number(process.env.SOMNUS_USER_MIN_GAS ?? 0.7);
  return Number.isFinite(n) && n > 0 ? n : 0.7;
}

export interface StakeClamp {
  stake: number;
  cap: number;
  /** True when the request was reduced to the cap. Reported, never silent. */
  clamped: boolean;
}

/** Collateral this trade is allowed to risk. Clamps rather than refuses: a caller
 *  who asks for more than the cap wants to trade, and the honest answer is a
 *  smaller trade plus a sentence saying so. */
export function clampStake(requested?: number): StakeClamp {
  const cap = maxUserStake();
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return { stake: cap, cap, clamped: false };
  }
  return { stake: Math.min(requested, cap), cap, clamped: requested > cap };
}

/** The edge bar for this trade: whichever is stricter of the caller's request, the
 *  operator's saved `minEdge`, and the floor above. */
export function resolveUserMinEdge(requested?: number): number {
  const floor = Math.max(userMinEdgeFloor(), loadAgentConfig().minEdge);
  if (requested === undefined || !Number.isFinite(requested)) return floor;
  return Math.max(floor, requested);
}

export interface UserTradingAvailability {
  ok: boolean;
  mode: UserTradingMode;
  /** Why sends are refused, when they are. */
  reason?: string;
}

/** Can this deployment place a caller's order at all, before any market is read?
 *
 *  Network and kill switch only — the per-call gates (confirm, stake, rate, funds)
 *  belong with the call. Returns `mode` either way so a caller in simulate mode is
 *  told that plainly instead of wondering why nothing hit the chain. */
export function userTradingAvailable(): UserTradingAvailability {
  const mode = userTradingMode();
  if (config.network !== 'testnet') {
    return {
      ok: false,
      mode,
      reason:
        `per-user wallets are testnet-only and this deployment is on ${config.network}. The ` +
        'derivation is custodial by construction — this server can recompute any token\'s key ' +
        '— which is acceptable for faucet-funded testnet balances and not otherwise.',
    };
  }
  const risk = riskStatus();
  if (risk.paused) {
    return {
      ok: false,
      mode,
      reason:
        `the operator's kill switch is on${risk.pauseReason ? `: ${risk.pauseReason}` : ''}. ` +
        'A paused deployment adds no new risk of any kind, including yours. Open positions ' +
        'still settle and can still be claimed.',
    };
  }
  // Every window decision here is `secondsLeft` arithmetic against the host clock,
  // so a skewed clock misprices which windows are still tradable and how much time
  // remains in them. The agent's own loop already refuses on this; the per-user path
  // checked `paused` and not the clock, which meant a stranger's stake could be
  // committed on expiry maths the operator's own trades would have declined.
  const clock = clockState();
  if (clock.blocking) {
    return {
      ok: false,
      mode,
      reason:
        `this server's clock is ${clock.skewSec ?? '?'}s off chain time, so how long a window ` +
        'has left cannot be computed reliably — and that number decides both which windows are ' +
        'tradable and what they are worth. Refusing until the clock is corrected.',
    };
  }
  return { ok: true, mode };
}

/** Confirmed sends per handle, newest last. Keyed by HANDLE — the non-reversible
 *  label from identity.ts — never by token, so nothing here is worth stealing. */
const sendTimes = new Map<string, number[]>();
const RATE_WINDOW_MS = 3_600_000;
/** Distinct handles tracked. Bounded so a flood of one-shot tokens cannot grow this
 *  without limit; the oldest are dropped, which at worst forgives a rate limit. */
const MAX_TRACKED_HANDLES = 2_000;

export interface RateCheck {
  ok: boolean;
  used: number;
  limit: number;
  /** Seconds until the oldest send falls out of the window. */
  retryAfterSec?: number;
}

export function userRateCheck(handle: string, now = Date.now()): RateCheck {
  const limit = userTradesPerHour();
  const recent = (sendTimes.get(handle) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length === 0) sendTimes.delete(handle);
  else sendTimes.set(handle, recent);
  if (recent.length < limit) return { ok: true, used: recent.length, limit };
  const oldest = recent[0] ?? now;
  return {
    ok: false,
    used: recent.length,
    limit,
    retryAfterSec: Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000)),
  };
}

/** Record a send against the rate limit. Called only when an order was actually
 *  submitted — a refusal costs the caller nothing and should not spend their budget. */
export function noteUserTrade(handle: string, now = Date.now()): void {
  const recent = (sendTimes.get(handle) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  sendTimes.set(handle, recent);
  if (sendTimes.size > MAX_TRACKED_HANDLES) {
    const byOldest = [...sendTimes.entries()].sort(
      (a, b) => (a[1][a[1].length - 1] ?? 0) - (b[1][b[1].length - 1] ?? 0),
    );
    for (const [h] of byOldest) {
      if (sendTimes.size <= MAX_TRACKED_HANDLES) break;
      sendTimes.delete(h);
    }
  }
}

/** One send at a time per wallet.
 *
 *  Two confirms arriving together would each read the same balance and each believe
 *  it could afford the trade — the same double-spend the broker's standalone gate
 *  exists to prevent for the agent. Per handle rather than globally, so one caller's
 *  slow order does not queue behind another's. */
const sendGates = new Map<string, Promise<unknown>>();

function serialisedForUser<T>(handle: string, fn: () => Promise<T>): Promise<T> {
  const previous = sendGates.get(handle) ?? Promise.resolve();
  // `then(fn, fn)` so a failed predecessor still releases the queue.
  const run = previous.then(fn, fn);
  const tracked: Promise<void> = run.catch(() => undefined).then(() => {
    // Only clear if nobody queued behind us, or we would drop their gate.
    if (sendGates.get(handle) === tracked) sendGates.delete(handle);
  });
  sendGates.set(handle, tracked);
  return run;
}

export interface UserWallet {
  address: string;
  /** Non-reversible label for logs and audit entries. */
  handle: string;
  /** Native token balance — this is what pays gas. */
  gas?: number;
  gasCode?: string;
  /** Spendable collateral (tUSDC on testnet). */
  collateral?: number;
  collateralCode?: string;
  /** Why a balance is missing, when one is. A balance that could not be confirmed is
   *  reported as unknown, never as zero — and for a wallet nobody has funded yet, the
   *  two are genuinely indistinguishable from here, which this says out loud. */
  unconfirmed?: string;
  /** A hard failure reading the wallet, as opposed to an inconclusive balance. */
  error?: string;
}

/** Balances for a derived wallet.
 *
 *  Not cached, unlike the agent's own snapshot: the cache there exists because one
 *  cycle prices a dozen markets against a single wallet, whereas each call here is a
 *  different caller asking about a different wallet, and a stale answer about
 *  somebody's deposit is worse than an extra RPC round-trip.                     */
export async function userWalletSnapshot(identity: UserIdentity): Promise<UserWallet> {
  const out: UserWallet = { address: identity.address, handle: identity.handle };
  try {
    const wei = await nativeGasBalance(identity.address);
    if (wei !== undefined) out.gas = Number(wei) / 1e18;
    else out.unconfirmed = 'the gas balance could not be read from the RPC';
  } catch (err) {
    out.error = `gas: ${(err as Error).message}`;
  }
  try {
    const ex = getUserExchange(identity.privateKey, identity.address);
    const native = ex.client?.config?.chain?.nativeCurrency?.symbol;
    if (typeof native === 'string') out.gasCode = native;
    const balances = (await ex.fetchBalance()) as Record<
      string,
      { free?: number; total?: number } | undefined
    >;
    const picked = pickCollateral(balances, out.gasCode);
    if (picked.unreadable) {
      // Every currency read zero. For the agent's own wallet that means a failed read
      // (a live account always holds something); for a wallet that has never been
      // funded it is simply the truth. Both look identical from here, so say both
      // rather than guessing — and leave `collateral` unset, which makes the trade
      // path refuse instead of spending gas on a certain revert.
      out.unconfirmed = [
        out.unconfirmed,
        'no collateral could be confirmed: either this wallet has never been funded, or the ' +
          'balance read failed. Those are indistinguishable from here, so it is not reported as zero.',
      ]
        .filter(Boolean)
        .join('; ');
    } else {
      out.collateral = picked.collateral;
      out.collateralCode = picked.collateralCode;
    }
  } catch (err) {
    out.error = [out.error, `collateral: ${(err as Error).message}`].filter(Boolean).join('; ');
  }
  return out;
}

export interface UserFunding {
  address: string;
  funded: boolean;
  needsGas: boolean;
  collateralBefore?: number;
  collateralAfter?: number;
  collateralCode?: string;
  gas?: number;
  gasCode?: string;
  txHash?: string;
  message: string;
}

/** Draw trading collateral into a derived wallet from the SDK faucet.
 *
 *  Same chicken-and-egg as the local install (see mcp/setup.ts): the faucet mints
 *  COLLATERAL only, minting is itself a transaction, and a transaction needs gas in
 *  the native token — which no faucet in the SDK provides. So a brand-new derived
 *  wallet needs one manual drip of gas, and the honest thing is to say so with the
 *  address rather than let the caller discover it as a revert. */
export async function fundUserWallet(identity: UserIdentity): Promise<UserFunding> {
  if (config.network !== 'testnet') {
    return {
      address: identity.address,
      funded: false,
      needsGas: false,
      message: `the faucet is testnet-only and this deployment is on ${config.network}.`,
    };
  }

  const before = await userWalletSnapshot(identity);
  const gas = before.gas;
  if (gas === undefined) {
    return {
      address: identity.address,
      funded: false,
      needsGas: true,
      gasCode: before.gasCode,
      message:
        'could not read this wallet\'s gas balance, and minting collateral is itself a transaction ' +
        `that needs gas. Try again in a moment. ${before.error ?? before.unconfirmed ?? ''}`.trim(),
    };
  }
  if (!(gas >= minUserGas())) {
    return {
      address: identity.address,
      funded: false,
      needsGas: true,
      gas: before.gas,
      gasCode: before.gasCode,
      collateralBefore: before.collateral,
      collateralCode: before.collateralCode,
      message:
        `this wallet holds ${gas.toFixed(4)} ${before.gasCode ?? 'native token'} and needs about ` +
        `${minUserGas()} before it can transact. The SDK faucet mints collateral only, and minting ` +
        'is itself a transaction — and the venue reserves the worst-case fee (a 10M gas limit at ' +
        '60 gwei, about 0.6) against your balance before it will accept one, even though a trade ' +
        `actually burns about 0.004. Send ${minUserGas()} ${before.gasCode ?? 'STT'} to ` +
        `${identity.address} from Somnia's public testnet faucet (or any funded wallet), then call ` +
        'this again.',
    };
  }

  const ex = await getUserExchangeReady(identity.privateKey, identity.address);
  const tx = (await ex.trader.faucet()) as { hash?: string; receipt?: { status?: string } };
  const after = await userWalletSnapshot(identity);
  if (tx?.receipt?.status === 'reverted') {
    return {
      address: identity.address,
      funded: false,
      needsGas: false,
      gas: after.gas,
      gasCode: after.gasCode,
      collateralBefore: before.collateral,
      collateralAfter: after.collateral,
      collateralCode: after.collateralCode,
      txHash: tx.hash,
      message:
        'the faucet reverted. It is rate-limited per address, so this is the expected answer for a ' +
        `wallet that already drew from it — balance is ${after.collateral ?? '?'} ${after.collateralCode ?? ''}.`,
    };
  }
  return {
    address: identity.address,
    funded: true,
    needsGas: false,
    gas: after.gas,
    gasCode: after.gasCode,
    collateralBefore: before.collateral,
    collateralAfter: after.collateral,
    collateralCode: after.collateralCode,
    txHash: tx?.hash,
    message: `funded — collateral is now ${after.collateral ?? '?'} ${after.collateralCode ?? ''}.`,
  };
}

export interface UserQuote {
  /** The window, named by its YES symbol — the same id `somnus_markets` reports. */
  window: string;
  /** The outcome token actually bought: YES for an Up leg, NO for a Down leg.
   *  Selling an outcome you don't hold is a naked short the pool refuses, so both
   *  directions are expressed as a buy. */
  outcomeSymbol: string;
  marketId: string;
  asset: string;
  side: 'Up' | 'Down';
  horizon?: string;
  tier: 'validated' | 'provisional';
  expiry?: number;
  secondsLeft?: number;
  /** Model probability for the window's YES outcome. */
  fair: number;
  /** Model probability for the side being bought. */
  fairForSide: number;
  /** Best visible price for that side before crossing. */
  quoted: number;
  /** The IOC limit — crosses the touch but never reaches fair. */
  limitPrice: number;
  contracts: number;
  /** Collateral this costs, at the limit price. */
  cost: number;
  /** What the caller ASKED to risk on this trade, after the per-trade cap.
   *
   *  Reported next to `stakeUsed` because the two differ silently and that was
   *  genuinely confusing: ask for 10, get a 5.00 cost back, and nothing said why.
   *  The reduction is the horizon tier doing its job, but a number the caller did
   *  not choose has to be stated, not left to be inferred from `cost`. */
  stakeRequested: number;
  /** What was actually sized against: `stakeRequested x sizeMultiplier`. Equal to
   *  `stakeRequested` on a validated window, half of it on a provisional one. */
  stakeUsed: number;
  /** The tier's size multiplier — 1 for validated, 0.5 for provisional by default
   *  (`AGENT_PROVISIONAL_SIZE_MULT`). */
  sizeMultiplier: number;
  /** Plain-language account of how `stakeRequested` became `cost`, including the
   *  round-down to whole contracts. Written to be shown verbatim to whoever asked. */
  sizingNote: string;
  /** Each contract pays 1 tUSDC if the outcome wins. */
  payoutIfWin: number;
  edge: number;
  requiredEdge: number;
  /** How the fair value was arrived at — spot, reference level, time, volatility. */
  model: string;
  reason: string;
}

/** The measured reason a class sits in its tier, without the multipliers restated.
 *
 *  `policy.note` ends with "— demanding 2x edge at 0.5x size", which is written for
 *  the proof entry. Here the percentage has already been said in the caller's own
 *  numbers, so repeating it twice in one sentence reads like a machine wrote it. What
 *  is worth keeping is the evidence: the Brier score and sample count are the reason
 *  to believe the tier, not just the verdict. */
function evidence(policy: TradeablePolicy): string {
  return policy.note.replace(/\s*[—-]\s*demanding\s.*$/i, '').trim();
}

/** Say out loud how a requested stake became a cost.
 *
 *  Two things shrink it and neither was ever stated. The horizon tier halves the
 *  budget on a window class the model has not proven itself on, and contracts are
 *  whole numbers so the remainder after the last one is unspendable. A caller who
 *  asked for 10 and was charged 4.62 deserves both sentences, not a `reason` string
 *  ending in "0.5x size" that nobody reads. */
export function sizingNote(
  requested: number,
  used: number,
  cost: number,
  policy: TradeablePolicy,
): string {
  const parts: string[] = [];
  if (used < requested) {
    const pct = Math.round(policy.sizeMultiplier * 100);
    parts.push(
      `You asked to risk ${requested.toFixed(2)} and this was sized against ${used.toFixed(2)} ` +
        `(${pct}% of it) because the ${policy.label} window class is ${policy.tier}: ` +
        `${evidence(policy)}. Full stake goes to validated classes only.`,
    );
  } else {
    parts.push(`Sized against your full ${requested.toFixed(2)} — the ${policy.label} class is validated.`);
  }
  // Only worth a sentence when the rounding actually cost something visible.
  const dust = used - cost;
  if (dust >= 0.01) {
    parts.push(
      `Cost is ${cost.toFixed(2)}, not ${used.toFixed(2)}: contracts are whole units, so ` +
        `${dust.toFixed(2)} was left unspent rather than buying a fraction.`,
    );
  }
  return parts.join(' ');
}

/** Price one window for a caller, or say why it is not tradeable.
 *
 *  Every number here comes from the same functions the agent's own cycle uses, so a
 *  caller's trade cannot be taken on a looser rule than the agent applies to itself:
 *  `estimateFair` for the probability, the horizon tier for the edge bar and stake
 *  multiplier, `decideFromFair` for the side, `crossingPrice` for the limit, and
 *  `dataFresh` for whether any of it is current enough to act on. */
async function priceWindow(
  market: EventMarketRow,
  policy: TradeablePolicy,
  ctx: SignalContext,
  stake: number,
  minEdge: number,
): Promise<{ quote?: UserQuote; skipped?: string }> {
  const book = await eventBook(market.symbol, 5);
  if (book.bid === undefined && book.ask === undefined) return { skipped: 'no book on this window' };

  const est = estimateFair(market, ctx);
  if (est === undefined) {
    return {
      skipped:
        'no independent estimate available (spot, volatility or the settlement reference is ' +
        'missing) — the agent will not trade a window it can only echo',
    };
  }

  // The same freshness bar the broker applies to the agent's own orders. A feed that
  // keeps answering promptly with ten-minute-old candles is stale however healthy it
  // looks, and a five-minute contract priced off it is a guess wearing a probability.
  const asset = market.asset.toUpperCase();
  const fresh = dataFresh(
    {
      spotAgeMs: ageFrom(ctx.spotTs.get(asset)),
      candleAgeMs: ageFrom(ctx.candleTs.get(asset)),
      bookAgeMs: ageFrom(book.ts),
    },
    loadAgentConfig().maxDataAgeMs,
  );
  if (!fresh.ok) return { skipped: `stale market data: ${fresh.reason}` };

  // The tier scales both knobs, exactly as it does in the agent's cycle: an
  // unproven horizon demands more edge and stakes less.
  const budget = stake * policy.sizeMultiplier;
  const decided = decideFromFair(est.fair, book, {
    minEdge: minEdge * policy.edgeMultiplier,
    maxSize: budget,
  });
  if (decided.action !== 'BUY_YES' && decided.action !== 'BUY_NO') {
    return { skipped: `${decided.reason} (${decided.pricedNote})` };
  }

  const isUp = decided.action === 'BUY_YES';
  const outcomeSymbol = isUp ? market.yesSymbol : market.noSymbol;
  if (!outcomeSymbol) return { skipped: 'the paired NO outcome could not be resolved' };

  const quoted = isUp ? decided.ask : 1 - decided.bid;
  const fairForSide = isUp ? est.fair : 1 - est.fair;
  const limitPrice = crossingPrice(quoted, fairForSide);
  if (limitPrice === undefined) {
    return { skipped: `no room to cross: quoted ${round4(quoted)} against fair ${round4(fairForSide)}` };
  }

  const contracts = Math.floor(budget / limitPrice);
  if (contracts < 1) {
    // Say which number failed, and why it is not the one the caller named. "5.00 buys
    // no whole contract" is baffling when you asked to risk 10.
    return {
      skipped:
        `${budget.toFixed(2)} buys no whole contract at ${limitPrice}` +
        (budget < stake
          ? ` — that is ${Math.round(policy.sizeMultiplier * 100)}% of the ${stake.toFixed(2)} you asked ` +
            `to risk, because the ${policy.label} class is ${policy.tier}`
          : ''),
    };
  }

  const cost = round2(limitPrice * contracts);

  const nowSec = Math.floor(Date.now() / 1000);
  return {
    quote: {
      window: market.symbol,
      outcomeSymbol,
      marketId: market.marketId,
      asset: market.asset,
      side: isUp ? 'Up' : 'Down',
      horizon: policy.label,
      tier: policy.tier,
      expiry: market.expiry,
      secondsLeft: market.expiry === undefined ? undefined : market.expiry - nowSec,
      fair: round4(est.fair),
      fairForSide: round4(fairForSide),
      quoted: round4(quoted),
      limitPrice,
      contracts,
      cost,
      stakeRequested: round2(stake),
      stakeUsed: round2(budget),
      sizeMultiplier: policy.sizeMultiplier,
      sizingNote: sizingNote(stake, budget, cost, policy),
      payoutIfWin: contracts,
      edge: round4(fairForSide - quoted),
      requiredEdge: round4(minEdge * policy.edgeMultiplier),
      model: est.note,
      reason: `${decided.reason} — ${policy.note}`,
    },
  };
}

interface Candidate {
  market: EventMarketRow;
  policy: TradeablePolicy;
}

/** Live windows a caller's order could actually land on, soonest-settling first.
 *
 *  Same two filters the agent applies to itself: a window whose horizon tier is
 *  blocked is not traded at all, and a window too close to expiry locks between the
 *  book read and the order (`TradingNotActive`, gas gone). `horizonPolicy` decides
 *  both. Capped at SCAN_WINDOWS because each survivor costs a book read on a
 *  request somebody is waiting for. */
async function tradeableWindows(symbols?: string[]): Promise<Candidate[]> {
  const wanted = (symbols ?? loadAgentConfig().symbols).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const rows = await listEventMarketRows();
  const nowSec = Math.floor(Date.now() / 1000);
  const out: Candidate[] = [];
  for (const market of rows) {
    if (wanted.length > 0 && !wanted.includes(market.asset.toUpperCase())) continue;
    const left = market.expiry === undefined ? Number.NaN : market.expiry - nowSec;
    const policy = horizonPolicy(market.intervalSec, left);
    if (policy.tier === 'blocked') continue;
    out.push({ market, policy: { ...policy, tier: policy.tier } });
    if (out.length >= SCAN_WINDOWS) break;
  }
  return out;
}

/** Resolve one window by symbol, accepting either outcome's symbol.
 *
 *  A caller pastes back whatever a previous tool printed, which may be the window's
 *  YES symbol or the NO token it actually bought. Both name the same window. */
async function findWindow(symbol: string): Promise<EventMarketRow | undefined> {
  const wanted = symbol.trim();
  if (!wanted) return undefined;
  const rows = await listEventMarketRows();
  return rows.find(
    (r) => r.symbol === wanted || r.yesSymbol === wanted || r.noSymbol === wanted,
  );
}

export interface UserQuoteResult {
  mode: UserTradingMode;
  /** What the caller asked to risk per trade, after clamping to the cap.
   *
   *  NOT necessarily what any quote was sized against — the comment here used to say
   *  it was, and that was the whole confusion. A provisional horizon halves the
   *  budget, so a caller asking for 10 gets quotes costing about 5. Each quote now
   *  carries its own `stakeUsed` and a `sizingNote` that says so in words. */
  stake: number;
  cap: number;
  stakeClamped: boolean;
  minEdge: number;
  /** Windows actually priced (a book read each). */
  scanned: number;
  quotes: UserQuote[];
  /** Windows that priced cleanly but offered nothing worth paying for, with why. */
  passed: Array<{ window: string; reason: string }>;
  errors: string[];
  note: string;
}

export interface UserQuoteOpts {
  stake?: number;
  minEdge?: number;
  /** Assets to consider, e.g. ["BTC"]. Defaults to the operator's saved symbols. */
  symbols?: string[];
}

/** What the agent would trade for a caller right now, and at what price.
 *
 *  Keyless: pricing reads the book and the oracle, so a quote needs no wallet and
 *  cannot spend. Nothing is held between this call and a trade — `placeUserTrade`
 *  re-reads the book and re-prices from scratch, because a quote is a photograph of
 *  a book that moves and honouring a stale one buys at a price that no longer
 *  exists. */
export async function quoteUserTrades(opts: UserQuoteOpts = {}): Promise<UserQuoteResult> {
  const { stake, cap, clamped } = clampStake(opts.stake);
  const minEdge = resolveUserMinEdge(opts.minEdge);
  const mode = userTradingMode();
  const errors: string[] = [];
  const passed: Array<{ window: string; reason: string }> = [];
  const quotes: UserQuote[] = [];

  const candidates = await tradeableWindows(opts.symbols);
  if (candidates.length === 0) {
    return {
      mode,
      stake,
      cap,
      stakeClamped: clamped,
      minEdge,
      scanned: 0,
      quotes,
      passed,
      errors,
      note:
        'no tradeable windows right now — every live window is either blocked by its horizon ' +
        'tier or too close to expiry to place an order safely.',
    };
  }

  const ctx = await buildSignalContext([...new Set(candidates.map((c) => c.market.asset))]);
  for (const { market, policy } of candidates) {
    try {
      const { quote, skipped } = await priceWindow(market, policy, ctx, stake, minEdge);
      if (quote) quotes.push(quote);
      else passed.push({ window: market.symbol, reason: skipped ?? 'not tradeable' });
    } catch (err) {
      errors.push(`${market.symbol}: ${(err as Error).message ?? String(err)}`);
    }
  }
  quotes.sort((a, b) => b.edge - a.edge);

  return {
    mode,
    stake,
    cap,
    stakeClamped: clamped,
    minEdge,
    scanned: candidates.length,
    quotes,
    passed,
    errors,
    note:
      quotes.length === 0
        ? `priced ${candidates.length} window(s) and found nothing clearing a ${minEdge} edge bar. ` +
          'That is the normal state — the model only acts when the book disagrees with it.'
        : `best edge ${quotes[0]!.edge} on ${quotes[0]!.window}. ${quotes[0]!.sizingNote} ` +
          'Prices move: somnus_my_trade re-reads the book and re-prices before it sends anything.',
  };
}

export interface UserTradeOpts {
  /** Window to trade, by either outcome's symbol. Omitted = the best-edge window
   *  from a fresh scan. */
  symbol?: string;
  stake?: number;
  minEdge?: number;
  symbols?: string[];
  /** Nothing is sent without this. A quote is free; spending is deliberate. */
  confirm?: boolean;
}

export interface UserTradeResult {
  mode: UserTradingMode;
  handle: string;
  address: string;
  /** True only when an order actually reached the chain. */
  placed: boolean;
  /** True when the trade was priced and recorded on purpose without being sent. */
  simulated?: boolean;
  quote?: UserQuote;
  txHash?: string;
  status?: string;
  /** Contracts the venue actually filled — an IOC can fill partially. */
  filled?: number;
  /** What the fill actually cost, from the venue's own numbers. */
  cost?: number;
  gasNative?: number;
  wallet?: UserWallet;
  rate?: RateCheck;
  cap?: number;
  stakeClamped?: boolean;
  reason: string;
}

/** Price a trade for a caller and, once confirmed, send it from their own wallet. */
export function placeUserTrade(
  identity: UserIdentity,
  opts: UserTradeOpts = {},
): Promise<UserTradeResult> {
  return serialisedForUser(identity.handle, () => executeUserTrade(identity, opts));
}

async function executeUserTrade(
  identity: UserIdentity,
  opts: UserTradeOpts,
): Promise<UserTradeResult> {
  const base = { handle: identity.handle, address: identity.address, mode: userTradingMode() };
  const availability = userTradingAvailable();
  if (!availability.ok) {
    return { ...base, placed: false, reason: `cannot trade: ${availability.reason}` };
  }

  const { stake, cap, clamped } = clampStake(opts.stake);
  const minEdge = resolveUserMinEdge(opts.minEdge);

  // ── price it ────────────────────────────────────────────────────────────────
  let quote: UserQuote | undefined;
  let why = '';
  if (opts.symbol) {
    const market = await findWindow(opts.symbol);
    if (!market) {
      return {
        ...base,
        placed: false,
        cap,
        reason:
          `no live window matches "${opts.symbol}". Windows are minted and expire continuously — ` +
          'run somnus_my_quote (or somnus_markets) for the current list.',
      };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const policy = horizonPolicy(
      market.intervalSec,
      market.expiry === undefined ? Number.NaN : market.expiry - nowSec,
    );
    if (policy.tier === 'blocked') {
      return { ...base, placed: false, cap, reason: `this window is not tradeable: ${policy.note}` };
    }
    const ctx = await buildSignalContext([market.asset]);
    const priced = await priceWindow(
      market,
      { ...policy, tier: policy.tier },
      ctx,
      stake,
      minEdge,
    );
    quote = priced.quote;
    why = priced.skipped ?? '';
  } else {
    const scan = await quoteUserTrades({
      ...(opts.stake !== undefined ? { stake: opts.stake } : {}),
      ...(opts.minEdge !== undefined ? { minEdge: opts.minEdge } : {}),
      ...(opts.symbols !== undefined ? { symbols: opts.symbols } : {}),
    });
    quote = scan.quotes[0];
    why = scan.note;
  }

  if (!quote) {
    return {
      ...base,
      placed: false,
      cap,
      stakeClamped: clamped,
      reason: `nothing worth trading: ${why || 'no edge over the book'}`,
    };
  }

  // ── gates that stand between a price and a spend ────────────────────────────
  if (opts.confirm !== true) {
    return {
      ...base,
      placed: false,
      quote,
      cap,
      stakeClamped: clamped,
      reason:
        `quote only — nothing sent. Call again with confirm:true to buy ${quote.contracts} ` +
        `${quote.side} contract(s) on ${quote.window} for ${quote.cost} tUSDC, paying out ` +
        `${quote.payoutIfWin} if it wins. ${quote.sizingNote} ` +
        'The book will be re-read and re-priced then.',
    };
  }

  const rate = userRateCheck(identity.handle);
  if (!rate.ok) {
    return {
      ...base,
      placed: false,
      quote,
      rate,
      cap,
      reason:
        `rate limit: ${rate.used} of ${rate.limit} trades used in the last hour. ` +
        `Try again in about ${Math.ceil((rate.retryAfterSec ?? 60) / 60)} minute(s). This bounds a ` +
        'retry loop, which is the most likely way an automated caller empties its own wallet.',
    };
  }

  if (base.mode !== 'live') {
    // Recorded, not sent. The entry is marked dryRun so it can never be mistaken for
    // a position, and it is still hash-linked — a simulated trade is part of the
    // honest record of what this endpoint was asked to do.
    await appendUserOrder(identity, quote, {
      status: 'simulated',
      dryRun: true,
      reason: 'SOMNUS_USER_TRADING is not live — priced and recorded, nothing sent',
    });
    return {
      ...base,
      placed: false,
      simulated: true,
      quote,
      cap,
      stakeClamped: clamped,
      reason:
        'this deployment prices per-user trades but does not send them ' +
        '(SOMNUS_USER_TRADING is not set to live). Nothing reached the chain and nothing was spent.',
    };
  }

  // ── can this wallet actually pay? ───────────────────────────────────────────
  //
  // Fails CLOSED on a balance it could not confirm, which is the opposite of the
  // agent's own affordability gate — and deliberately so. There, refusing to trade
  // over one RPC hiccup would halt a healthy agent, and the on-chain revert is an
  // acceptable backstop because the operator chose to run it. Here the cost of
  // guessing wrong is somebody else's gas spent on a certain revert, and the cost of
  // refusing is a retry. So an unknown balance is a refusal with a clear reason.
  const wallet = await userWalletSnapshot(identity);
  if (wallet.gas === undefined) {
    return {
      ...base,
      placed: false,
      quote,
      wallet,
      cap,
      reason:
        'could not read this wallet\'s gas balance, so the order was not sent — an order that ' +
        `cannot pay gas reverts and costs the attempt. ${wallet.error ?? wallet.unconfirmed ?? ''}`.trim(),
    };
  }
  if (wallet.gas < minUserGas()) {
    return {
      ...base,
      placed: false,
      quote,
      wallet,
      cap,
      reason:
        `this wallet holds ${wallet.gas.toFixed(4)} ${wallet.gasCode ?? 'native token'} and needs about ` +
        `${minUserGas()} to transact. The trade itself burns roughly 0.004, but the venue reserves the ` +
        'worst-case fee (a 10M gas limit at 60 gwei) against your balance before it will accept the ' +
        `transaction at all. Send ${minUserGas()} ${wallet.gasCode ?? 'STT'} to ${identity.address} ` +
        "from Somnia's public testnet faucet, then trade.",
    };
  }
  if (wallet.collateral === undefined) {
    return {
      ...base,
      placed: false,
      quote,
      wallet,
      cap,
      reason:
        `no collateral balance could be confirmed for ${identity.address}, so nothing was sent. ` +
        'If you have not funded this wallet yet, run somnus_my_fund to draw testnet tUSDC — an ' +
        'unfunded wallet and an unreadable one look identical from here, and buying on a guess ' +
        'costs gas for a revert.',
    };
  }
  if (wallet.collateral < quote.cost) {
    return {
      ...base,
      placed: false,
      quote,
      wallet,
      cap,
      reason:
        `collateral ${wallet.collateral.toFixed(2)} ${wallet.collateralCode ?? ''} cannot cover ` +
        `${quote.cost.toFixed(2)} — run somnus_my_fund to draw testnet tUSDC, or lower the stake.`,
    };
  }

  // The indexer trails the chain, so a window it still lists as open may already be
  // locked. Checking costs a read; not checking costs gas on a certain revert.
  if (quote.marketId && !(await isMarketTrading(quote.marketId))) {
    return {
      ...base,
      placed: false,
      quote,
      wallet,
      cap,
      reason: 'that window has already locked on-chain (the indexer was a few seconds stale).',
    };
  }

  // ── send it, from the caller's own wallet ───────────────────────────────────
  try {
    const exchange = await getUserExchangeReady(identity.privateKey, identity.address);
    const result = await placeOrderOnExchange(exchange, {
      symbol: quote.outcomeSymbol,
      price: quote.limitPrice,
      size: quote.contracts,
    });
    // What the venue did, not what we asked for: the quantity is floored onto the lot
    // grid, the price snapped onto the tick grid, and an IOC that exhausts the depth
    // at its limit fills partially. Same accounting as the agent's own fills.
    const { filled, paidPrice, cost } = resolveFill(result, {
      size: quote.contracts,
      price: quote.limitPrice,
    });
    const gasNative = gasCostFromReceipt(result.receipt);
    noteUserTrade(identity.handle);
    await appendUserOrder(identity, quote, {
      status: 'submitted',
      dryRun: false,
      price: paidPrice,
      filledSize: filled,
      fillStatus: result.status,
      txHash: result.txHash,
      gasNative,
      cost,
      retainedEdge: round4(quote.fairForSide - paidPrice),
      reason: result.reason,
    });
    const partial =
      filled !== undefined && filled > 0 && filled < quote.contracts
        ? ` Partial fill: ${filled} of ${quote.contracts} contracts — an IOC cancels whatever the ` +
          'book could not fill at the limit.'
        : '';
    return {
      ...base,
      placed: filled !== undefined && filled > 0,
      quote,
      wallet,
      cap,
      stakeClamped: clamped,
      txHash: result.txHash,
      status: result.status,
      filled,
      cost,
      gasNative,
      rate: userRateCheck(identity.handle),
      reason:
        filled !== undefined && filled > 0
          ? `bought ${filled} ${quote.side} contract(s) on ${quote.window} at ${paidPrice} for ` +
            `${cost ?? '?'} tUSDC.${partial} ${quote.sizingNote} It settles by itself at ${
              quote.expiry ? new Date(quote.expiry * 1000).toISOString() : 'the window expiry'
            }; run somnus_my_claim afterwards to redeem a winner.`
          : `the order found no fill: ${result.reason}`,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // An IOC that finds nothing reverts `ImmediateOrCancelNoFill`. That is the book
    // moving between the read and the send — ordinary taker behaviour, not breakage.
    const noFill = /ImmediateOrCancelNoFill/i.test(msg);
    warn(`user order failed (${identity.handle}):`, msg);
    await appendUserOrder(identity, quote, {
      status: 'rejected',
      dryRun: false,
      reason: msg,
    });
    return {
      ...base,
      placed: false,
      quote,
      wallet,
      cap,
      reason: noFill
        ? 'no fill — the book moved before the order landed (IOC). Nothing was bought; only gas ' +
          'was spent. Re-quote and try again.'
        : `the order failed: ${msg}`,
    };
  }
}

/** Write a caller's order into the same hash-linked, signed audit chain the agent's
 *  own orders go into.
 *
 *  Identified by HANDLE and wallet address only. The handle is a separate HMAC of the
 *  token (see identity.ts), so an entry proves which wallet acted without recording
 *  the secret that controls it — the chain is meant to be published, and a token in it
 *  would be a published private key.
 *
 *  `user` is also what keeps these out of the agent's own accounting: the P&L ledger
 *  holds the agent's cost basis and feeds the agent's breakers, so a user order is
 *  tagged and skipped there rather than counted as a lost write. */
async function appendUserOrder(
  identity: UserIdentity,
  quote: UserQuote,
  extra: {
    status: 'simulated' | 'submitted' | 'rejected';
    dryRun: boolean;
    price?: number;
    filledSize?: number;
    fillStatus?: string;
    txHash?: string;
    gasNative?: number;
    cost?: number;
    retainedEdge?: number;
    reason: string;
  },
): Promise<void> {
  try {
    await appendEntry({
      kind: 'order',
      payload: {
        id: randomUUID().slice(0, 8),
        ts: Date.now(),
        via: 'mcp-user',
        user: identity.handle,
        wallet: identity.address,
        window: quote.window,
        symbol: quote.outcomeSymbol,
        marketId: quote.marketId,
        outcome: quote.side === 'Up' ? 'YES' : 'NO',
        side: 'buy',
        timeInForce: 'IOC',
        price: extra.price ?? quote.limitPrice,
        size: quote.contracts,
        cost: extra.cost ?? quote.cost,
        fair: quote.fair,
        fairForSide: quote.fairForSide,
        quoted: quote.quoted,
        edge: quote.edge,
        requiredEdge: quote.requiredEdge,
        retainedEdge: extra.retainedEdge,
        horizon: quote.horizon,
        horizonTier: quote.tier,
        model: quote.model,
        expiry: quote.expiry,
        status: extra.status,
        dryRun: extra.dryRun,
        filledSize: extra.filledSize,
        fillStatus: extra.fillStatus,
        txHash: extra.txHash,
        gasNative: extra.gasNative,
        reason: extra.reason,
      },
    });
  } catch (err) {
    // A chain write must never swallow a trade that already happened. Report and move
    // on: the transaction hash is in the result either way.
    warn('could not record a user order in the audit chain:', (err as Error).message);
  }
}

export interface UserPositionRow {
  marketId: string;
  outcome: 'YES' | 'NO';
  contracts: number;
  asset?: string;
  expiry?: number;
  secondsLeft?: number;
  status: string;
}

export interface UserPortfolio {
  address: string;
  handle: string;
  /** Positions in windows that have not resolved yet. */
  open: UserPositionRow[];
  /** Settled winners, redeemable with somnus_my_claim. */
  claimable: ClaimableRow[];
  claimableTotal: number;
  /** Settled positions that did not win. Listed because a portfolio that silently
   *  drops losers reads as though every trade worked. */
  settledLost: Array<{ marketId: string; outcome: 'YES' | 'NO' }>;
  note: string;
}

/** Everything a caller's wallet is holding, on-chain rather than from a local file.
 *
 *  Read straight off the venue: this process keeps no per-user ledger, so there is
 *  nothing here that could disagree with the chain. */
export async function userPositions(identity: UserIdentity): Promise<UserPortfolio> {
  const [held, scan] = await Promise.all([
    heldPositions(identity.address),
    findClaimable(identity.address),
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  const open = held
    .filter((p) => !p.settled)
    .map((p) => ({
      marketId: p.marketId,
      outcome: (p.outcomeIdx === 0 ? 'YES' : 'NO') as 'YES' | 'NO',
      contracts: p.amountHuman,
      asset: p.asset,
      expiry: p.expiry,
      secondsLeft: p.expiry === undefined ? undefined : p.expiry - nowSec,
      status: p.status,
    }));
  return {
    address: identity.address,
    handle: identity.handle,
    open,
    claimable: scan.claimable,
    claimableTotal: scan.totalEstPayoutHuman,
    settledLost: scan.settledLosers.map((l) => ({
      marketId: l.marketId,
      outcome: (l.outcomeIdx === 0 ? 'YES' : 'NO') as 'YES' | 'NO',
    })),
    note:
      scan.claimable.length > 0
        ? `${scan.claimable.length} settled winner(s) worth about ${scan.totalEstPayoutHuman} tUSDC — ` +
          'run somnus_my_claim to redeem them.'
        : open.length > 0
          ? `${open.length} position(s) still open; each settles by itself at its window expiry.`
          : 'this wallet holds no positions.',
  };
}

export interface UserClaimResult {
  mode: UserTradingMode;
  address: string;
  handle: string;
  claimed: ClaimableRow[];
  totalEstPayout: number;
  txHash?: string;
  gasNative?: number;
  reason: string;
}

/** Redeem a caller's settled winners into collateral, in one batched transaction.
 *
 *  Signed by their wallet, so the payout lands in their wallet. Nothing is written to
 *  the agent's P&L ledger: these are not the agent's positions and folding them in
 *  would corrupt the numbers its own loss breakers read. */
export function claimUserPositions(
  identity: UserIdentity,
  confirm = false,
): Promise<UserClaimResult> {
  return serialisedForUser(identity.handle, () => executeUserClaim(identity, confirm));
}

async function executeUserClaim(identity: UserIdentity, confirm: boolean): Promise<UserClaimResult> {
  const mode = userTradingMode();
  const base = { mode, address: identity.address, handle: identity.handle };
  const scan = await findClaimable(identity.address);
  const total = scan.totalEstPayoutHuman;

  if (scan.claimable.length === 0) {
    return {
      ...base,
      claimed: [],
      totalEstPayout: 0,
      reason: `nothing to redeem (scanned ${scan.scanned} position(s) in this wallet).`,
    };
  }
  if (!confirm) {
    return {
      ...base,
      claimed: scan.claimable,
      totalEstPayout: total,
      reason:
        `${scan.claimable.length} settled winner(s) worth about ${total} tUSDC. Call again with ` +
        'confirm:true to redeem them — one batched transaction, paid for with this wallet\'s gas.',
    };
  }
  if (mode !== 'live') {
    return {
      ...base,
      claimed: scan.claimable,
      totalEstPayout: total,
      reason:
        'this deployment does not send per-user transactions (SOMNUS_USER_TRADING is not live), so ' +
        'nothing was redeemed. The winnings stay claimable — they do not expire.',
    };
  }

  const entries = scan.claimable.map((c) => ({
    marketId: c.marketId as `0x${string}`,
    outcomeIdx: c.outcomeIdx,
    amount: BigInt(c.amount),
  }));
  try {
    const exchange = await getUserExchangeReady(identity.privateKey, identity.address);
    const tx = (await exchange.trader.redeemMany({ entries } as never)) as {
      hash?: string;
      receipt?: { status?: string };
    };
    const txHash = typeof tx?.hash === 'string' ? tx.hash : undefined;
    if (tx?.receipt?.status === 'reverted') {
      throw new Error(`redeem reverted${txHash ? ` (${txHash})` : ''}`);
    }
    const gasNative = gasCostFromReceipt(tx?.receipt);
    await appendUserClaim(identity, scan.claimable, {
      status: 'submitted',
      txHash,
      gasNative,
      total,
    });
    debug(`user ${identity.handle} redeemed ${entries.length} position(s)`);
    return {
      ...base,
      claimed: scan.claimable,
      totalEstPayout: total,
      txHash,
      gasNative,
      reason: `redeemed ${entries.length} position(s) for about ${total} tUSDC${txHash ? ` in ${txHash}` : ''}.`,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    warn(`user claim failed (${identity.handle}):`, msg);
    await appendUserClaim(identity, scan.claimable, { status: 'rejected', reason: msg, total });
    return {
      ...base,
      claimed: [],
      totalEstPayout: total,
      reason: `the redeem failed: ${msg}. The positions stay claimable — nothing was lost.`,
    };
  }
}

/** A caller's redemption, in the same audit chain and with the same handle-only
 *  identification as their orders. */
async function appendUserClaim(
  identity: UserIdentity,
  positions: ClaimableRow[],
  extra: { status: 'submitted' | 'rejected'; txHash?: string; gasNative?: number; total: number; reason?: string },
): Promise<void> {
  try {
    await appendEntry({
      kind: 'claim',
      payload: {
        via: 'mcp-user',
        user: identity.handle,
        wallet: identity.address,
        dryRun: false,
        status: extra.status,
        positions,
        totalEstPayoutHuman: extra.total,
        txHash: extra.txHash,
        gasNative: extra.gasNative,
        reason: extra.reason,
      },
    });
  } catch (err) {
    warn('could not record a user claim in the audit chain:', (err as Error).message);
  }
}

/** Forget every per-user rate-limit and serialisation record. For tests. */
export function __resetUserTradingForTests(): void {
  sendTimes.clear();
  sendGates.clear();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Age of a timestamp in ms, or undefined when the input never arrived. Undefined
 *  propagates as "unknown", which the freshness gate treats as stale rather than
 *  fine — a missing timestamp is exactly the case where currency cannot be shown. */
function ageFrom(ts: number | undefined): number | undefined {
  if (ts === undefined || !Number.isFinite(ts)) return undefined;
  return Math.max(0, Date.now() - ts);
}
