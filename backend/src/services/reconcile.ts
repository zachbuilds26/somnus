import { debug } from '../config';
import { openPositions } from './pnl';
import { getExchange, getSignerAddress, withRetry } from './sdk';
import { raiseAlert } from './alerts';

/** Reconciliation: does the chain agree with our ledger?
 *
 *  The P&L ledger is written from order results, in the same process, immediately
 *  after a submit. That is one unguarded gap wide enough to lose money through: if
 *  the process dies between the fill landing on-chain and `recordFill` returning —
 *  a deploy, an OOM, a `process.exit(0)` in a signal handler — the position exists
 *  and the ledger has never heard of it. Nothing detected that, so:
 *
 *   - `openNotional()` under-counts, and the exposure ceiling lets in more risk
 *     than the operator authorised,
 *   - the position settles and `recordSettlement` refuses it ("settled something we
 *     never traded"), so the loss never reaches the daily-loss breaker,
 *   - and every performance number is quietly computed over an incomplete sample.
 *
 *  The reverse drift matters too. A ledger row with no on-chain balance means the
 *  position is already gone — settled and redeemed without being recorded, or never
 *  actually filled — and its cost is being counted against the exposure budget
 *  forever, slowly starving the agent of room to trade.
 *
 *  This does not auto-repair. Writing invented rows into an append-only financial
 *  record to make two numbers match is how you turn a detectable problem into an
 *  undetectable one. It reports the diff and says what it would take to fix.     */

export interface ReconcileRow {
  marketId: string;
  outcomeIdx: 0 | 1;
  /** Outcome-token balance held on-chain, human units. */
  onChain?: number;
  /** Contracts the ledger thinks we hold. */
  ledger?: number;
  /** Cost basis the ledger recorded, tUSDC. */
  ledgerCost?: number;
  symbol?: string;
  status?: string;
}

export interface ReconcileReport {
  ts: number;
  signer?: string;
  ok: boolean;
  /** Positions held on-chain with no open ledger row — a lost write. The dangerous
   *  direction: real risk the limits cannot see. */
  onChainOnly: ReconcileRow[];
  /** Open ledger rows with no on-chain balance — cost basis pinned against the
   *  exposure budget for a position that no longer exists. */
  ledgerOnly: ReconcileRow[];
  /** Present in both, which is the healthy case. */
  matched: number;
  /** Exposure the ledger is currently blind to, tUSDC. Unknown per-position cost
   *  (we never recorded it), so this counts positions, not dollars. */
  unrecordedPositions: number;
  summary: string;
  error?: string;
}

/** Market lifecycle states that mean a position is finished, not exposure. */
const SETTLED = new Set(['Finalized', 'Resolved', 'Voided']);

export async function reconcile(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    ts: Date.now(),
    ok: true,
    onChainOnly: [],
    ledgerOnly: [],
    matched: 0,
    unrecordedPositions: 0,
    summary: '',
  };

  const signer = getSignerAddress();
  report.signer = signer;
  if (!signer) {
    report.summary = 'no signing key configured — nothing to reconcile against';
    return report;
  }

  let positions: Array<Record<string, unknown>>;
  try {
    const ex = getExchange();
    const portfolio = (await withRetry('getPortfolio', () => ex.client.getPortfolio(signer))) as {
      positions?: Array<Record<string, unknown>>;
    };
    positions = portfolio?.positions ?? [];
  } catch (err) {
    // An unreadable chain is not a reconciled chain. Say so rather than reporting
    // a clean diff computed from nothing.
    report.ok = false;
    report.error = (err as Error).message ?? String(err);
    report.summary = `could not read on-chain positions: ${report.error}`;
    return report;
  }

  // Open on-chain exposure, keyed the same way the ledger keys it. Pools are
  // recycled between windows, so marketId + outcome is the only stable key.
  const chain = new Map<string, { balance: number; symbol?: string; status?: string }>();
  for (const p of positions) {
    const market = (p.market ?? {}) as Record<string, unknown>;
    const status = String(market.status ?? '');
    if (SETTLED.has(status)) continue;
    const balance = Number(p.balance ?? 0);
    if (!(balance > 0)) continue;
    const marketId = String(market.id ?? '');
    if (!marketId) continue;
    const outcomeIdx = Number(p.outcomeIndex) === 1 ? 1 : 0;
    const decimals = Number(market.quoteDecimals ?? 6);
    chain.set(`${marketId}:${outcomeIdx}`, {
      balance: balance / 10 ** decimals,
      symbol: market.symbol ? String(market.symbol) : undefined,
      status,
    });
  }

  const ledger = new Map(openPositions().map((p) => [p.key, p]));

  for (const [key, held] of chain) {
    const row = ledger.get(key);
    const [marketId = '', idxRaw = '0'] = key.split(':');
    const outcomeIdx: 0 | 1 = idxRaw === '1' ? 1 : 0;
    if (row) {
      report.matched++;
      continue;
    }
    report.onChainOnly.push({
      marketId,
      outcomeIdx,
      onChain: held.balance,
      symbol: held.symbol,
      status: held.status,
    });
  }

  for (const [key, row] of ledger) {
    if (chain.has(key)) continue;
    report.ledgerOnly.push({
      marketId: row.marketId,
      outcomeIdx: row.outcomeIdx,
      ledger: row.size,
      ledgerCost: row.cost,
      symbol: row.symbol,
    });
  }

  report.unrecordedPositions = report.onChainOnly.length;
  report.ok = report.onChainOnly.length === 0 && report.ledgerOnly.length === 0;

  const pinned = report.ledgerOnly.reduce((a, r) => a + (r.ledgerCost ?? 0), 0);
  report.summary = report.ok
    ? `in sync: ${report.matched} open position(s) present in both chain and ledger`
    : [
        `${report.matched} matched`,
        report.onChainOnly.length > 0
          ? `${report.onChainOnly.length} on-chain position(s) MISSING from the ledger ` +
            '(risk the limits cannot see — a fill whose ledger write was lost)'
          : '',
        report.ledgerOnly.length > 0
          ? `${report.ledgerOnly.length} ledger row(s) with no on-chain balance, ` +
            `$${pinned.toFixed(2)} pinned against the exposure budget ` +
            '(run a settlement sweep; if it persists the fill never landed)'
          : '',
      ]
        .filter(Boolean)
        .join('; ');

  if (report.onChainOnly.length > 0) {
    raiseAlert({
      level: 'critical',
      key: 'reconcile-unrecorded-positions',
      title: `${report.onChainOnly.length} on-chain position(s) missing from the P&L ledger`,
      detail: { summary: report.summary, positions: report.onChainOnly.slice(0, 10) },
    });
  } else if (report.ledgerOnly.length > 0) {
    raiseAlert({
      level: 'warning',
      key: 'reconcile-stale-ledger-rows',
      title: `${report.ledgerOnly.length} ledger row(s) have no on-chain balance`,
      detail: { summary: report.summary, rows: report.ledgerOnly.slice(0, 10) },
    });
  }

  debug(`reconcile: ${report.summary}`);
  return report;
}
