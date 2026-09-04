import { debug, warn } from '../config';
import { getTradingExchange, nativeGasBalance } from './sdk';

/** What the wallet can actually afford.
 *
 *  The broker checked native gas before every submit and never checked collateral,
 *  so a drained wallet placed orders that reverted at transfer — five times, one
 *  gas payment each, before `maxExecutionFailures` worked out that there was no
 *  money. "Can I pay for this" is the cheapest question in trading and it was the
 *  one nobody asked.
 *
 *  Two separate assets, and they are not interchangeable: Event Contracts are
 *  bought with tUSDC collateral, and every transaction pays gas in the chain's
 *  native token. Having one and not the other still means you cannot trade, which
 *  is why they are reported separately and never summed.                        */

/** Minimum native balance worth attempting a transaction with.
 *
 *  0.7, not the 0.02 this used to be. The venue builds Event Contract transactions
 *  with a 10,000,000 gas limit at 60 gwei, so the node demands roughly 0.6 native
 *  of headroom before it will accept one — even though the actual burn is ~0.005.
 *  At 0.02 `canAfford()` green-lit wallets the node then rejected, which converted
 *  a clean early refusal into a wasted attempt plus an execution-failure count,
 *  and five of those pause the agent. Measured against Somnia testnet, not guessed. */
export const MIN_GAS_NATIVE = Number(process.env.AGENT_MIN_GAS_NATIVE ?? 0.7);

export interface WalletSnapshot {
  /** Collateral available to buy contracts, human units. */
  collateral?: number;
  /** Currency code the collateral is denominated in (tUSDC on testnet). */
  collateralCode?: string;
  /** Native token balance, human units — this is what pays gas. */
  native?: number;
  /** Native token symbol (STT on testnet, SOMI on mainnet). */
  nativeCode?: string;
  /** When this was read (ms). */
  ts: number;
  /** Why a field is missing, when it is. An unreadable balance is UNKNOWN, never
   *  zero — refusing to trade on an RPC hiccup is as wrong as trading broke. */
  error?: string;
}

/** Balance reads are RPC round-trips and a cycle prices a dozen markets, so cache
 *  briefly. Short enough that a faucet top-up shows up within one cycle. */
const TTL_MS = Number(process.env.AGENT_WALLET_TTL_MS ?? 10_000);
let cache: WalletSnapshot | undefined;
/** Collateral committed since the cached balance was READ.
 *
 *  Without this the affordability check double-spends: the balance is cached for ten
 *  seconds and nothing decremented it, so with $10 of collateral three $8 orders in
 *  one cycle each compared 8 against a stale 10 and all three passed. The chain
 *  refuses the second and third, but the whole point of the check was to not find out
 *  that way. Reset on every fresh read, because a fresh read already reflects
 *  whatever was spent. */
let committedSinceRead = 0;

/** Native-currency symbols, so a collateral scan never mistakes gas for collateral. */
const NATIVE_CODES = new Set(['STT', 'SOMI', 'ETH']);

export interface CollateralRead {
  collateral?: number;
  collateralCode?: string;
  /** Set when the balances could not be trusted, with the reason. A zero that means
   *  "could not read" must never reach a caller as "you are broke". */
  unreadable?: string;
}

/** Which balance is spendable collateral, out of everything the venue reports.
 *
 *  Extracted so the agent's wallet and a derived per-user wallet answer this the
 *  same way. Two rules, both learned the hard way:
 *
 *   - skip native and outcome tokens. Outcome holdings are keyed by tradable
 *     symbol (`BTC-…/tUSDC#YES`) and are POSITIONS, not spendable collateral;
 *     counting them reports a wallet as funded when every dollar is already
 *     committed to open bets.
 *   - EVERY currency reading zero at once means unreadable, not empty.
 *     `fetchBalance` catches per-token RPC failures and substitutes 0n, so a
 *     network blip is indistinguishable from an empty wallet — and the
 *     affordability gate fails CLOSED on a readable zero, which is how a healthy
 *     wallet holding 9,577 tUSDC once got reported as `collateral: 0` and would
 *     have refused every trade. The venue lists a dozen currencies and a real
 *     wallet holds at least the collateral it trades with.                     */
export function pickCollateral(
  balances: Record<string, { free?: number; total?: number } | undefined>,
  nativeCode?: string,
): CollateralRead {
  let best: { code: string; amount: number } | undefined;
  let currencyKeys = 0;
  let nonZeroKeys = 0;
  for (const [code, bal] of Object.entries(balances)) {
    if (!bal) continue;
    if (code.includes('#') || code.includes('/')) continue;
    if (NATIVE_CODES.has(code) || code === nativeCode) continue;
    const amount = Number(bal.free ?? bal.total ?? 0);
    if (!Number.isFinite(amount)) continue;
    currencyKeys++;
    if (amount > 0) nonZeroKeys++;
    if (!best || amount > best.amount) best = { code, amount };
  }
  if (currencyKeys > 1 && nonZeroKeys === 0) {
    return { unreadable: 'every currency read 0 — treating as unreadable, not empty' };
  }
  if (!best) return {};
  return { collateral: best.amount, collateralCode: best.code };
}

export async function walletSnapshot(force = false): Promise<WalletSnapshot> {
  if (!force && cache && Date.now() - cache.ts < TTL_MS) return cache;

  const snapshot: WalletSnapshot = { ts: Date.now() };

  // Native balance goes through the raw RPC helper, which works without a signing
  // client and returns undefined rather than throwing on a transient failure.
  try {
    const wei = await nativeGasBalance();
    if (wei !== undefined) snapshot.native = Number(wei) / 1e18;
  } catch (err) {
    snapshot.error = `native: ${(err as Error).message}`;
  }

  // Collateral needs the signing client: balances are per-account, and the read-only
  // client has no account to read. Running keyless is a legitimate state (reads and
  // dry-run cycles need no key), so a missing key is not an error here.
  try {
    const ex = getTradingExchange();
    // Resolve the native symbol BEFORE the balance read. It comes from the chain
    // definition, not the network, so a failed balance call should not cost us the
    // unit label — a log line reading "gas 1.3079" with no currency is worse than one
    // that admits the balance is unknown.
    const native = ex.client?.config?.chain?.nativeCurrency?.symbol;
    if (typeof native === 'string') snapshot.nativeCode = native;

    const balances = (await ex.fetchBalance()) as Record<
      string,
      { free?: number; total?: number } | undefined
    >;

    const picked = pickCollateral(balances, snapshot.nativeCode);
    if (picked.unreadable) {
      snapshot.error = [snapshot.error, `collateral: ${picked.unreadable}`].filter(Boolean).join('; ');
    } else if (picked.collateral !== undefined) {
      snapshot.collateral = picked.collateral;
      snapshot.collateralCode = picked.collateralCode;
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // No key configured is expected in read-only and dry-run operation.
    if (/live execution needs a key/i.test(msg)) debug('wallet: no signing key, collateral unknown');
    else snapshot.error = [snapshot.error, `collateral: ${msg}`].filter(Boolean).join('; ');
  }

  cache = snapshot;
  committedSinceRead = 0;
  return snapshot;
}

/** Note collateral just committed, so the next affordability check sees it even
 *  though the cached balance predates it. Called by the broker on every accepted
 *  order. */
export function noteCommitted(cost: number): void {
  if (cost > 0) committedSinceRead += cost;
}

/** Collateral committed since the last balance read. Exposed for /health so an
 *  operator can see why the effective balance is below the on-chain one. */
export function committedSinceBalanceRead(): number {
  return Math.round(committedSinceRead * 100) / 100;
}

export interface AffordabilityCheck {
  ok: boolean;
  reason?: string;
  /** Collateral the wallet holds, when it could be read. */
  collateral?: number;
  /** Collateral still spendable: the balance minus what this cycle already committed
   *  against the same cached read. */
  available?: number;
}

/** Can this wallet pay for `cost` collateral plus gas right now?
 *
 *  Fails OPEN on an unreadable balance. An RPC blip must not halt an otherwise
 *  healthy agent; the on-chain revert is the backstop, and `maxExecutionFailures`
 *  still bounds how many times we pay to rediscover the problem. Fails CLOSED on a
 *  balance we could read and that is genuinely too small — that is not a guess. */
export async function canAfford(cost: number): Promise<AffordabilityCheck> {
  const w = await walletSnapshot();
  const gasCode = w.nativeCode ?? 'native';

  if (w.native !== undefined && w.native < MIN_GAS_NATIVE) {
    return {
      ok: false,
      reason: `native gas too low (${w.native.toFixed(4)} ${gasCode}) — fund the trade key before trading`,
      collateral: w.collateral,
    };
  }
  if (w.collateral !== undefined) {
    // Subtract what this cycle has already committed against the same cached read.
    const available = w.collateral - committedSinceRead;
    if (available < cost) {
      const spent = committedSinceRead > 0 ? `, ${committedSinceRead.toFixed(2)} already committed this cycle` : '';
      return {
        ok: false,
        reason:
          `collateral ${available.toFixed(2)} ${w.collateralCode ?? ''} cannot cover ` +
          `${cost.toFixed(2)}${spent} — run npm run faucet or reduce maxTradeSize`,
        collateral: w.collateral,
        available,
      };
    }
    return { ok: true, collateral: w.collateral, available };
  }
  return { ok: true, collateral: w.collateral };
}

/** Total capital under management: spendable collateral plus what is already
 *  committed to open positions. This is the denominator for percentage-of-equity
 *  sizing — spendable balance alone would shrink as positions open and make the
 *  agent size DOWN simply for having traded. */
export async function equity(openNotional: number): Promise<number | undefined> {
  const w = await walletSnapshot();
  if (w.collateral === undefined) return undefined;
  return w.collateral + Math.max(0, openNotional);
}

/** Gas cost of one transaction in native units, from its receipt.
 *
 *  Returned separately from tUSDC P&L rather than folded into it: adding STT to
 *  tUSDC needs an exchange rate this backend does not have, and inventing one to
 *  make a single number would be worse than reporting two honest ones. */
export function gasCostFromReceipt(receipt: unknown): number | undefined {
  const r = receipt as { gasUsed?: unknown; effectiveGasPrice?: unknown; gasPrice?: unknown } | null;
  if (!r) return undefined;
  try {
    const used = BigInt(String(r.gasUsed ?? 0));
    const price = BigInt(String(r.effectiveGasPrice ?? r.gasPrice ?? 0));
    if (used <= 0n || price <= 0n) return undefined;
    return Number(used * price) / 1e18;
  } catch {
    return undefined;
  }
}

export function __resetWalletCacheForTests(): void {
  cache = undefined;
  committedSinceRead = 0;
}

/** Log a one-line wallet summary. Used by the boot preflight. */
export async function logWalletState(): Promise<void> {
  const w = await walletSnapshot(true);
  const parts: string[] = [];
  parts.push(w.native === undefined ? 'gas unknown' : `gas ${w.native.toFixed(4)} ${w.nativeCode ?? ''}`);
  parts.push(
    w.collateral === undefined
      ? 'collateral unknown (no key, or unreadable)'
      : `collateral ${w.collateral.toFixed(2)} ${w.collateralCode ?? ''}`,
  );
  if (w.error) parts.push(`error: ${w.error}`);
  warn(`wallet: ${parts.join(' | ')}`);
}
