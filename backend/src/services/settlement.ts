import { claimableFrom, type ClaimablePosition } from '@somnia-chain/markets-sdk';
import { config, debug, log, warn } from '../config';
import { effectiveDryRun, loadAgentConfig } from '../agent-config';
import { getExchange, getSignerAddress, getTradingExchangeReady, withRetry } from './sdk';
import { appendEntry } from './store';
import { realizedSince, openNotional, recordGas, recordSettlement } from './pnl';
import { recordSweep } from './risk';
import { raiseAlert } from './alerts';
import { gasCostFromReceipt } from './wallet';

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

/** One non-zero outcome balance held by an address, with the market context the
 *  indexer returns alongside it. */
export interface HeldPosition {
  marketId: string;
  outcomeIdx: 0 | 1;
  /** Raw integer balance, in the collateral's own decimals. */
  amount: string;
  /** Human units, safe to display. */
  amountHuman: number;
  status: string;
  /** True once the window has resolved — no longer open exposure. */
  settled: boolean;
  asset?: string;
  expiry?: number;
  decimals: number;
}

/** Every outcome position an address still holds. Read-only and keyless: the
 *  read client answers for any address, which is what lets one process report on
 *  the agent's wallet and on a derived per-user wallet without a key for either.
 *
 *  `getPortfolio` rather than paging `listBinaryMarkets` — see `findClaimable`
 *  for why that alternative silently misses real positions.                    */
export async function heldPositions(address: string): Promise<HeldPosition[]> {
  const out: HeldPosition[] = [];
  if (!address) return out;
  const ex = getExchange();
  const portfolio = (await withRetry('getPortfolio', () => ex.client.getPortfolio(address))) as {
    positions?: Array<Record<string, any>>;
  };
  for (const p of portfolio?.positions ?? []) {
    const amount = toBig(p.balance);
    if (amount <= 0n) continue;
    const m = (p.market ?? {}) as Record<string, any>;
    const marketId = String(m.id ?? '');
    if (!marketId) continue;
    const status = String(m.status ?? '');
    const decimals = Number(m.quoteDecimals ?? 6);
    out.push({
      marketId,
      outcomeIdx: Number(p.outcomeIndex) === 1 ? 1 : 0,
      amount: String(amount),
      amountHuman: Number(amount) / 10 ** decimals,
      status,
      settled: SETTLED_STATUSES.has(status),
      asset: m.asset ? String(m.asset) : undefined,
      expiry: m.expiry === undefined ? undefined : Number(m.expiry),
      decimals,
    });
  }
  return out;
}

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
  for (const p of await heldPositions(signer)) {
    if (p.settled) continue;
    out.set(p.marketId, (out.get(p.marketId) ?? 0) + 1);
  }
  return out;
}

/** Find every settled position an address can redeem. Read-only.
 *
 *  Defaults to the agent's own signer; pass an address to scan a derived per-user
 *  wallet with the same rules. Keyless either way — claimability is a property of
 *  the market and the balance, not of who holds the key.
 *
 *  Uses `getPortfolio`, which returns the wallet's non-zero outcome positions
 *  with market context in one round-trip. The obvious alternative — page through
 *  `listBinaryMarkets({status:'Finalized'})` and batch-read balances — is
 *  quietly wrong: the market list is paged and sorted by creation, so a real
 *  position in an older or off-page window is reported as "nothing to claim".
 *  Verified against a genuine on-chain fill that a 400-market scan missed.    */
export async function findClaimable(address?: string): Promise<ClaimScan> {
  const signer = address ?? getSignerAddress();
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

export interface SweepResult {
  ts: number;
  /** Positions whose outcome was newly written to the ledger. */
  realized: number;
  winners: number;
  losers: number;
  /** Realised P&L this sweep added, in tUSDC. */
  pnl: number;
  /** Set when the sweep deliberately did nothing (no open exposure, checked recently). */
  skipped?: string;
  error?: string;
}

/** Realise every settled position's outcome, WITHOUT redeeming anything.
 *
 *  This exists because the loss breakers read the P&L ledger, and until now the
 *  ledger only learned that a position had settled when `executeClaim` redeemed it.
 *  That put `maxDailyLoss` and `maxConsecutiveLosses` downstream of a separate,
 *  failure-prone subsystem: if claiming broke — indexer down, no gas, `redeemMany`
 *  reverting, `claimEnabled` off, or simply dry-run — the agent kept trading with a
 *  brake reading a gauge nobody was filling.
 *
 *  Settlement and redemption are different events and only the first one determines
 *  P&L. A finalized window has a known winner and dreamDEX charges no settlement fee,
 *  so the payout is already determined the moment it resolves; redeeming only moves
 *  the collateral back into the wallet. Recording the outcome at settlement is
 *  therefore not optimistic, it is just earlier — and it is what makes the breakers
 *  trustworthy.
 *
 *  Read-only and idempotent: `recordSettlement` ignores anything already recorded and
 *  anything we never traded, so running this every cycle is free.                */
/** One settlement-recording operation at a time.
 *
 *  `recordSettlement` is read-then-write: it reads the whole ledger to check the
 *  position was traded and not already settled, then appends. Two overlapping
 *  callers can both pass that check and both append, double-counting one outcome.
 *  `claimAll` was serialised against itself but not against the sweep, so
 *  `POST /agent/settle-sweep` and `POST /agent/claim` arriving together could do
 *  exactly that. One gate covers both, because they write the same rows.          */
let settlementGate: Promise<unknown> = Promise.resolve();

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = settlementGate.then(fn);
  settlementGate = run.catch(() => undefined);
  return run;
}

/** How often to sweep when there is nothing open, as a safety net. The ledger can
 *  under-report exposure (a fill whose write was lost), so "nothing open" is a strong
 *  hint rather than proof — check anyway, just not every minute. */
const IDLE_SWEEP_MS = Number(process.env.AGENT_IDLE_SWEEP_MS ?? 900_000);
let lastSweepAt = 0;

export function sweepSettlements(): Promise<SweepResult> {
  return serialised(() => executeSweep());
}

async function executeSweep(): Promise<SweepResult> {
  const result: SweepResult = { ts: Date.now(), realized: 0, winners: 0, losers: 0, pnl: 0 };

  // Nothing open means nothing can settle, and this costs a portfolio read every
  // cycle. Still run periodically, because the ledger is not the only truth — a lost
  // write would leave real exposure the ledger cannot see.
  if (openNotional() === 0 && Date.now() - lastSweepAt < IDLE_SWEEP_MS) {
    result.skipped = 'nothing open';
    return result;
  }
  lastSweepAt = Date.now();

  try {
    const scan = await findClaimable();
    const before = realizedSince(0);

    // Winners: payout is known from `estPayout` before any redemption happens.
    for (const c of scan.claimable) {
      recordSettlement(c.marketId, c.outcomeIdx, Number(c.estPayout) / 10 ** c.decimals, true, true);
    }
    // Losers: settled, held, and not claimable — the side we bought did not win.
    for (const l of scan.settledLosers) {
      recordSettlement(l.marketId, l.outcomeIdx, 0, false, true);
    }

    const after = realizedSince(0);
    result.pnl = Math.round((after - before) * 100) / 100;
    result.winners = scan.claimable.length;
    result.losers = scan.settledLosers.length;
    result.realized = result.winners + result.losers;
    recordSweep(result);
    if (result.pnl !== 0) {
      log(`settlement sweep realised ${result.pnl >= 0 ? '+' : ''}${result.pnl} tUSDC`);
    }
    return result;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    result.error = msg;
    debug('settlement sweep failed:', msg);
    recordSweep(result);
    // A sweep that cannot run means the loss breakers are reading stale data. That
    // is worth telling someone about, because the agent looks perfectly healthy
    // while its most important limit is blind.
    raiseAlert({
      level: 'warning',
      key: 'settlement-sweep-failed',
      title: 'settlement sweep failed — loss breakers are reading stale P&L',
      detail: { error: msg },
    });
    return result;
  }
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
  // Shares the settlement gate with the sweep: both write settlement rows through the
  // same read-then-write path, so serialising each against itself is not enough.
  claimInFlight = serialised(() => executeClaim()).finally(() => {
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
    // Redemption gas belongs in the cost of running the agent. Booked as its own
    // row because a batched redeem covers many positions and cannot be attributed
    // to one of them.
    const gasNative = gasCostFromReceipt(tx?.receipt);
    if (gasNative !== undefined) recordGas(gasNative, `redeemed ${entries.length} position(s)`, txHash);
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
