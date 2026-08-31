import { claimableFrom, type ClaimablePosition } from '@somnia-chain/markets-sdk';
import { config, debug, log, warn } from '../config';
import { effectiveDryRun, loadAgentConfig } from '../agent-config';
import { getExchange, getSignerAddress, getTradingExchangeReady, withRetry } from './sdk';
import { appendEntry } from './store';
import { recordSettlement } from './pnl';

/** Settlement sweep — turn won positions back into collateral.
 *
 *  Without this, testnet winnings sit as outcome tokens forever and the demo
 *  can't show a completed round trip (decide -> trade -> settle -> claim).
 *
 *  Two traps the docs call out, both handled here:
 *  - `loadMarkets()` SKIPS finalized binaries, so a redeem-by-scan built on it
 *    reports zero winnings. Settled markets must come from the binary tier via
 *    `listBinaryMarkets({ status: 'Finalized' })`.
 *  - Pools are recycled between windows, so state is keyed by `marketId`, never
 *    by pool address.                                                         */

/** dreamDEX sets the settlement fee to zero, so winners redeem 1:1. Kept as a
 *  named constant rather than a bare 0n so it's obvious what to change if the
 *  venue ever starts skimming. */
const SETTLEMENT_FEE_BPS = 0n;

/** Balances arrive as decimal strings or bigints depending on SDK version. */
function toBig(v: string | bigint | number | undefined | null): bigint {
  if (v === undefined || v === null) return 0n;
  try {
    return typeof v === 'bigint' ? v : BigInt(String(v));
  } catch {
    return 0n;
  }
}

export interface ClaimableRow {
  marketId: string;
  outcomeIdx: 0 | 1;
  amount: string;
  estPayout: string;
  status: string;
  asset?: string;
  expiry?: number;
  voided: boolean;
  /** Collateral decimals for this market (6 on the testnet faucet token). */
  decimals: number;
}

export interface ClaimScan {
  signer?: string;
  /** Non-zero outcome positions held (claimable or not). */
  scanned: number;
  skippedOlder: number;
  claimable: ClaimableRow[];
  /** Settled positions the signer held but did NOT win (lost exposure), keyed for
   *  the P&L ledger so losses are realised rather than silently forgotten. */
  settledLosers: Array<{ marketId: string; outcomeIdx: 0 | 1 }>;
  /** Raw sum — only meaningful when every position shares the same decimals. */
  totalEstPayout: string;
  /** Decimal-normalised total. Always safe to display. */
  totalEstPayoutHuman: number;
  /** True when positions span different collateral decimals, making the raw
   *  sum meaningless (testnet tUSDC is 6dp; mainnet USDso is 18dp). */
  mixedDecimals: boolean;
}

/** Market lifecycle states that mean the position is done — no longer exposure. */
const SETTLED_STATUSES = new Set(['Finalized', 'Resolved', 'Voided']);

/** How many positions are still OPEN on-chain: non-zero outcome balances in
 *  markets that haven't settled yet.
 *
 *  This is what `maxOpenPositions` should gate on. Counting "submitted orders
 *  seen in the log" never decreases, so the agent silently stops trading forever
 *  once it crosses the limit — it looks broken rather than governed.          */
export async function countOpenOnChainPositions(): Promise<number> {
  const byMarket = await countOpenByMarket();
  let n = 0;
  for (const c of byMarket.values()) n += c;
  return n;
}

/** Open positions keyed by marketId — feeds the broker's per-window cap
 *  (`maxPerMarket`), which bounds averaging into a single dying window. */
export async function countOpenByMarket(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const signer = getSignerAddress();
  if (!signer) return out;
  const ex = getExchange();
  const portfolio = (await withRetry('getPortfolio', () => ex.client.getPortfolio(signer))) as {
    positions?: Array<Record<string, any>>;
  };
  for (const p of portfolio?.positions ?? []) {
    if (toBig(p.balance) <= 0n) continue;
    const m = (p.market ?? {}) as Record<string, any>;
    const status = String(m.status ?? '');
    if (SETTLED_STATUSES.has(status)) continue;
    const id = String(m.id ?? '');
    if (!id) continue;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** Find every settled position the signer can redeem. Read-only.
 *
 *  Uses `getPortfolio`, which returns the wallet's non-zero outcome positions
 *  with market context in one round-trip. The obvious alternative — page through
 *  `listBinaryMarkets({status:'Finalized'})` and batch-read balances — is
 *  quietly wrong: the market list is paged and sorted by creation, so a real
 *  position in an older or off-page window is reported as "nothing to claim".
 *  Verified against a genuine on-chain fill that a 400-market scan missed.    */
export async function findClaimable(): Promise<ClaimScan> {
  const signer = getSignerAddress();
  if (!signer) {
    return {
      signer: undefined,
      scanned: 0,
      skippedOlder: 0,
      claimable: [],
      settledLosers: [],
      totalEstPayout: '0',
      totalEstPayoutHuman: 0,
      mixedDecimals: false,
    };
  }

  const ex = getExchange();
  const portfolio = (await withRetry('getPortfolio', () => ex.client.getPortfolio(signer))) as {
    positions?: Array<Record<string, any>>;
  };
  const positions = portfolio?.positions ?? [];

  const inputs: Array<Record<string, any>> = [];
  const meta = new Map<string, { asset?: string; expiry?: number; voided: boolean; decimals: number }>();

  for (const p of positions) {
    const m = (p.market ?? {}) as Record<string, any>;
    const marketId = String(m.id ?? '');
    if (!marketId) continue;

    // Scope to one venue when configured. Portfolio rows don't always carry
    // venueId, so only filter when the field is actually present.
    if (config.venueId && m.venueId && String(m.venueId) !== config.venueId) continue;

    const amount = toBig(p.balance);
    if (amount <= 0n) continue;

    const outcomeIdx = Number(p.outcomeIndex) === 1 ? 1 : 0;
    meta.set(`${marketId}:${outcomeIdx}`, {
      asset: m.asset ? String(m.asset) : undefined,
      expiry: m.expiry === undefined ? undefined : Number(m.expiry),
      voided: Boolean(m.voided),
      decimals: Number(m.quoteDecimals ?? 6),
    });

    inputs.push({
      marketId,
      pool: String(m.poolAddress ?? ''),
      outcomeIdx,
      amount,
      winningOutcome:
        m.winningOutcome === null || m.winningOutcome === undefined
          ? null
          : Number(m.winningOutcome),
      voided: Boolean(m.voided),
      status: String(m.status ?? ''),
      settlementFeeBps: SETTLEMENT_FEE_BPS,
    });
  }

  // The SDK decides what's actually claimable: winner side, or either side on a
  // voided market (both redeem at half). Loser and still-trading are dropped.
  const claimable = claimableFrom(inputs as never) as ClaimablePosition[];
  debug(`settlement: ${positions.length} position(s) held, ${claimable.length} claimable`);

  // Anything settled (Finalized/Resolved/Voided) that the SDK did NOT return as
  // claimable is a realised loss for the side we held — record it so P&L reflects
  // losers too, not just winners.
  const wonKeys = new Set(claimable.map((c) => `${String(c.marketId)}:${c.outcomeIdx}`));
  const settledLosers: Array<{ marketId: string; outcomeIdx: 0 | 1 }> = [];
  for (const p of positions) {
    const m = (p.market ?? {}) as Record<string, any>;
    if (!SETTLED_STATUSES.has(String(m.status ?? ''))) continue;
    const marketId = String(m.id ?? '');
    const outcomeIdx: 0 | 1 = Number(p.outcomeIndex) === 1 ? 1 : 0;
    if (!marketId || wonKeys.has(`${marketId}:${outcomeIdx}`)) continue;
    settledLosers.push({ marketId, outcomeIdx });
  }

  let total = 0n;
  let totalHuman = 0;
  const decimalsSeen = new Set<number>();
  const out: ClaimableRow[] = claimable.map((c) => {
    const m = meta.get(`${String(c.marketId)}:${c.outcomeIdx}`);
    const decimals = m?.decimals ?? 6;
    decimalsSeen.add(decimals);
    total += BigInt(c.estPayout);
    // Normalise per position: raw units are only comparable within one market's
    // decimals, so a raw cross-market sum is nonsense the moment they differ.
    totalHuman += Number(c.estPayout) / 10 ** decimals;
    return {
      marketId: String(c.marketId),
      outcomeIdx: c.outcomeIdx,
      amount: String(c.amount),
      estPayout: String(c.estPayout),
      status: c.status,
      asset: m?.asset,
      expiry: m?.expiry,
      voided: m?.voided ?? false,
      decimals,
    };
  });

  return {
    signer,
    scanned: positions.length,
    skippedOlder: 0,
    claimable: out,
    settledLosers,
    totalEstPayout: String(total),
    totalEstPayoutHuman: Number(totalHuman.toFixed(6)),
    mixedDecimals: decimalsSeen.size > 1,
  };
}

export interface ClaimResult {
  dryRun: boolean;
  claimed: ClaimableRow[];
  txHash?: string;
  reason: string;
  totalEstPayout: string;
}

/** Redeem every claimable position in one batched transaction.
 *  Honours DRY_RUN and the saved `claimEnabled` rule; records the outcome in the
 *  proof chain either way, so the audit trail shows intent as well as action.
 *
 *  Serialised: two concurrent claims would each scan, each see the same
 *  positions, and each submit a redeem for them — the second burning gas to
 *  revert on tokens the first already spent. A concurrent caller joins the
 *  in-flight claim and receives its result.                                   */
let claimInFlight: Promise<ClaimResult> | undefined;

export function claimAll(): Promise<ClaimResult> {
  if (claimInFlight) return claimInFlight;
  claimInFlight = executeClaim().finally(() => {
    claimInFlight = undefined;
  });
  return claimInFlight;
}

async function executeClaim(): Promise<ClaimResult> {
  const rules = loadAgentConfig();
  const dryRun = effectiveDryRun(rules);
  const scan = await findClaimable();

  if (!rules.claimEnabled) {
    return {
      dryRun,
      claimed: [],
      reason: 'claimEnabled is false in the saved rules',
      totalEstPayout: '0',
    };
  }
  if (scan.claimable.length === 0) {
    return {
      dryRun,
      claimed: [],
      reason: `nothing to claim (scanned ${scan.scanned} settled windows)`,
      totalEstPayout: '0',
    };
  }

  if (dryRun) {
    await appendEntry({
      kind: 'claim',
      payload: {
        dryRun: true,
        status: 'simulated',
        positions: scan.claimable,
        totalEstPayout: scan.totalEstPayout,
        reason: 'DRY_RUN (default safe mode)',
      },
    });
    return {
      dryRun,
      claimed: scan.claimable,
      reason: 'DRY_RUN — would redeem, sent nothing',
      totalEstPayout: scan.totalEstPayout,
    };
  }

  const exchange = await getTradingExchangeReady();
  const entries = scan.claimable.map((c) => ({
    marketId: c.marketId as `0x${string}`,
    outcomeIdx: c.outcomeIdx,
    amount: BigInt(c.amount),
  }));

  try {
    const tx = (await exchange.trader.redeemMany({ entries } as never)) as {
      hash?: string;
      receipt?: { status?: string };
    };
    const txHash = typeof tx?.hash === 'string' ? tx.hash : undefined;
    if (tx?.receipt?.status === 'reverted') {
      throw new Error(`redeem reverted${txHash ? ` (${txHash})` : ''}`);
    }
    await appendEntry({
      kind: 'claim',
      payload: {
        dryRun: false,
        status: 'submitted',
        positions: scan.claimable,
        totalEstPayout: scan.totalEstPayout,
        txHash,
      },
    });
    log(`claimed ${entries.length} position(s), tx ${txHash ?? '(no hash)'}`);
    // Realised P&L: winners (payout) and losers (0) against the recorded cost.
    for (const c of scan.claimable) {
      recordSettlement(c.marketId, c.outcomeIdx, Number(c.estPayout) / 10 ** c.decimals, true);
    }
    for (const l of scan.settledLosers) {
      recordSettlement(l.marketId, l.outcomeIdx, 0, false);
    }
    return {
      dryRun,
      claimed: scan.claimable,
      txHash,
      reason: txHash ? `redeemed in ${txHash}` : 'redeem accepted',
      totalEstPayout: scan.totalEstPayout,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    warn('claim failed:', msg);
    await appendEntry({
      kind: 'claim',
      payload: {
        dryRun: false,
        status: 'rejected',
        positions: scan.claimable,
        totalEstPayout: scan.totalEstPayout,
        reason: msg,
      },
    });
    return {
      dryRun,
      claimed: [],
      reason: `claim failed: ${msg}`,
      totalEstPayout: scan.totalEstPayout,
    };
  }
}
