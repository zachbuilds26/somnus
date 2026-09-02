import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config';
import { effectiveDryRun, loadAgentConfig } from '../agent-config';
import { calibrationSummary } from '../services/horizon';
import { loopStatus } from '../services/loop';
import { pnlSummary, settledTrades, verifyLedgerAgainstChain } from '../services/pnl';
import { buildPerformanceReport } from '../services/report';
import { riskStatus } from '../services/risk';
import { eventBook, feedHealthReport, listEventMarketRows } from '../services/sdk';
import { clockState } from '../services/clock';
import { walletSnapshot } from '../services/wallet';
import { reconcile } from '../services/reconcile';
import {
  computeHash,
  count,
  currentAnchor,
  readAllFromDisk,
  readChainPage,
  signerAddress,
  verifyChain,
} from '../services/store';
import { verifyProofSignature } from '../services/proof';
import { lastAnchorInfo } from '../services/anchor';
import { ok, say, simpleTool, guard } from './shared';

/** READ-ONLY tools. Safe to expose publicly with no credential.
 *
 *  Nothing here signs, spends, or changes a saved rule. That is what makes the
 *  hosted deployment shippable: anyone can add the URL and interrogate a live
 *  governed trading agent — its reasoning, its limits, its audit chain — without
 *  being able to touch it, and without the operator handing out a key.          */
export function registerReadTools(server: McpServer): void {
  simpleTool(
    server,
    'somnus_health',
    'Is the agent alive, allowed to trade, and seeing the market? Returns network, ' +
      'dry-run state, per-feed health, clock skew, wallet balances, open exposure, ' +
      'and every reason trading is currently blocked.',
    async () => {
      const rules = loadAgentConfig();
      const risk = riskStatus(rules);
      const wallet = await walletSnapshot();
      const clock = clockState();
      const feeds = feedHealthReport();
      return ok({
        network: config.network,
        dryRun: effectiveDryRun(rules),
        mode: rules.mode,
        tradingAllowed: risk.ok,
        blocked: risk.blocked,
        paused: risk.paused,
        pauseReason: risk.pauseReason,
        openNotional: risk.openNotional,
        maxOpenNotional: risk.limits.maxOpenNotional,
        lossToday: risk.lossToday,
        maxDailyLoss: risk.limits.maxDailyLoss,
        drawdown: risk.drawdown,
        consecutiveLosses: risk.consecutiveLosses,
        settlementSweepAgeSec:
          risk.settlementAgeMs === undefined ? undefined : Math.round(risk.settlementAgeMs / 1000),
        bookAgeSec: risk.bookAgeMs === undefined ? undefined : Math.round(risk.bookAgeMs / 1000),
        clockSkewSec: clock.skewSec,
        feedsFailing: feeds.failing,
        feeds: feeds.sources.map((s) => ({ source: s.source, ok: s.ok, error: s.error })),
        wallet: {
          collateral: wallet.collateral,
          collateralCode: wallet.collateralCode,
          gas: wallet.native,
          gasCode: wallet.nativeCode,
        },
        loop: { running: loopStatus().running, cycles: loopStatus().cycles },
      });
    },
  );

  simpleTool(
    server,
    'somnus_markets',
    'Live DreamDEX Event Contract windows (Up/Down prediction markets) on Somnia — ' +
      'asset, window class, expiry, and settlement reference for each.',
    async () => {
      const rows = await listEventMarketRows();
      const now = Math.floor(Date.now() / 1000);
      return ok({
        count: rows.length,
        windows: rows.map((r) => ({
          symbol: r.symbol,
          asset: r.asset,
          classSec: r.intervalSec,
          expiry: r.expiry,
          secondsLeft: r.expiry === undefined ? undefined : r.expiry - now,
          settlesAgainst: r.strikeRaw === '0' || r.strikeRaw === undefined ? 'opening price' : 'strike',
        })),
      });
    },
  );

  server.registerTool(
    'somnus_book',
    {
      description:
        'Top of book for one Event Contract window. The price is the probability the ' +
        'market assigns to the Up outcome, between 0 and 1. Pass the YES symbol from ' +
        'somnus_markets.',
      inputSchema: { symbol: z.string().describe('YES outcome symbol, e.g. BTC-0-02SEP26-1900/tUSDC#YES') },
    },
    ({ symbol }) =>
      guard(async () => {
        const book = await eventBook(symbol, 5);
        return ok({ symbol: book.symbol, bid: book.bid, ask: book.ask, mid: book.mid, readAt: book.ts });
      }),
  );

  simpleTool(
    server,
    'somnus_horizons',
    'Which window classes the agent trusts, and on what evidence. Each class is ' +
      'validated, provisional, or blocked based on measured Brier score against the ' +
      'base rate over settled windows — not a hardcoded list.',
    async () => ok(calibrationSummary()),
  );

  simpleTool(
    server,
    'somnus_pnl',
    'Profit and loss from the local fill/settlement ledger: realised P&L, win rate, ' +
      'open cost, drawdown from peak, and gas spent (reported separately, in the ' +
      'native token — it is a different asset from the tUSDC collateral).',
    async () => ok({ ...pnlSummary(), recentSettled: settledTrades().slice(-10).reverse() }),
  );

  simpleTool(
    server,
    'somnus_report',
    'Full performance report: P&L split by horizon, asset and evidence tier, how close ' +
      'each circuit breaker is to tripping, feed health, the calibration table, and a ' +
      'deliberately conservative recommendation.',
    async () => ok(buildPerformanceReport()),
  );

  server.registerTool(
    'somnus_decisions',
    {
      description:
        'Recent decisions and orders from the signed audit chain, newest first, with the ' +
        'reasoning behind each: model fair value, book price, edge, the bar it had to ' +
        'clear, and why it passed or traded.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('How many entries (default 20)'),
        kind: z.enum(['decision', 'order', 'claim', 'config']).optional().describe('Filter by entry kind'),
      },
    },
    ({ limit, kind }) =>
      guard(async () => {
        const page = readChainPage({ limit: limit ?? 20, kind });
        return ok({
          matched: page.matched,
          hasMore: page.hasMore,
          entries: page.entries.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, ...e.payload })),
        });
      }),
  );

  simpleTool(
    server,
    'somnus_proof_verify',
    'Cryptographically verify the whole audit chain. Checks three things independently: ' +
      'that every entry links to the one before it, that the recomputed head matches the ' +
      'anchor the server reports, and that every signature recovers to the configured ' +
      'signer. Also reports unsigned historical entries rather than hiding them.',
    async () => {
      const all = readAllFromDisk();
      const result = verifyChain('0'.repeat(64), all);
      const expected = signerAddress();
      let checked = 0;
      let valid = 0;
      let unsigned = 0;
      for (const e of all) {
        if (typeof e.signature !== 'string' || e.signature.length === 0) {
          unsigned++;
          continue;
        }
        if (!expected) continue;
        checked++;
        if (await verifyProofSignature(computeHash(e.prevHash, e.payloadHash, e.kind), e.signature, expected)) {
          valid++;
        }
      }
      const headMatches = result.anchor === currentAnchor();
      const signaturesOk = checked === valid;
      return ok({
        ok: result.ok && headMatches && signaturesOk,
        linkageOk: result.ok,
        headMatches,
        signaturesOk,
        signaturesChecked: checked,
        signaturesValid: valid,
        unsignedEntries: unsigned,
        entriesChecked: result.checked,
        totalEntries: count(),
        signer: expected,
        onChainAnchor: lastAnchorInfo(),
        note: unsigned > 0
          ? `${unsigned} historical entries are hash-linked but unsigned — from before signing was ` +
            'resolved for every entry point. They are reported rather than back-signed, because ' +
            'back-signing them would be dating a signature nobody actually made.'
          : undefined,
      });
    },
  );

  simpleTool(
    server,
    'somnus_pnl_verify',
    'Cross-check the P&L ledger against the signed audit chain. The chain is hash-linked ' +
      'and signed; the ledger is plain text. This rebuilds what the ledger should contain ' +
      'from the signed order entries and reports any difference.',
    async () => ok(verifyLedgerAgainstChain()),
  );

  simpleTool(
    server,
    'somnus_reconcile',
    'Does the blockchain agree with the local ledger? Reports positions held on-chain ' +
      'with no ledger row (a lost write — real risk the limits cannot see) and ledger rows ' +
      'with no on-chain balance. Read-only: it reports drift, it never invents rows to hide it.',
    async () => ok(await reconcile()),
  );

  simpleTool(
    server,
    'somnus_config',
    'The rules the agent actually enforces — per-trade size, open exposure ceiling, ' +
      'minimum edge, daily loss cap, drawdown limit, correlation caps, and the kill ' +
      'switch. These are read from the same saved document the broker gates on, so a ' +
      'limit shown here is a limit that binds.',
    async () => {
      const rules = loadAgentConfig();
      return ok({ config: rules, effectiveDryRun: effectiveDryRun(rules) });
    },
  );

  simpleTool(
    server,
    'somnus_explain',
    'How Somnus decides what to trade, in plain language — the model, the volatility ' +
      'estimator, the evidence tiers, and every guard between a decision and the chain.',
    async () => say(EXPLAIN),
  );
}

const EXPLAIN = `Somnus trades DreamDEX Event Contracts on Somnia: binary Up/Down windows from 1
minute to 24 hours.

THE MODEL. For each window it asks "what is the probability this asset finishes at or above the
window's reference level?" and answers with driftless geometric Brownian motion:
P(S_T >= K) = Phi((ln(S/K) - sigma^2*T/2) / (sigma*sqrt(T))), using live oracle spot, the window's
reference level, time remaining, and realised volatility. The edge is that number minus the book
price. Volatility is measured AT EACH WINDOW'S OWN HORIZON rather than by scaling 1-minute vol by
sqrt(t) — this feed mean-reverts, so sqrt-scaling overstated 4h volatility about fourfold and
manufactured a one-sided bias. It takes the max of the direct and scaled estimates, because
too-low vol costs money while too-high vol only costs opportunities.

WHAT IT WILL TRADE. Every window class carries an evidence tier measured against settled windows:
validated (beats the base rate and is calibrated, n>=40) trades at the operator's own rules;
provisional (too few samples, or directionally useful but miscalibrated) demands double the edge at
half the size; blocked (measured to be no better than the base rate) is not traded at all. The
table is not hardcoded — a study scores each class and writes it to disk, so a class graduates from
evidence rather than from someone editing a constant.

WHAT STOPS IT. Per order: size, open exposure, one position per window, positions sharing an
expiry, minimum edge, data freshness, and whether the wallet can actually pay. Per session: daily
realised loss, drawdown from peak, consecutive losses, failed executions, host-vs-chain clock skew,
staleness of the settlement sweep that feeds the loss limits, and a kill switch only an operator
can clear. Dry-run is a floor, not a preference: an order needs BOTH the environment flag and the
saved mode set to live.

WHAT IT RECORDS. Every decision, order, claim and rule change goes into an append-only chain —
sha256(prevHash + canonical payload + kind) — optionally signed with secp256k1, with the head
periodically written on-chain. somnus_proof_verify checks linkage, head match and signatures
independently, and reports unsigned historical entries instead of quietly back-signing them.`;
