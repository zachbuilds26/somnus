import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadAgentConfig, saveAgentConfig, sanitize, effectiveDryRun } from './agent-config';
import { runCycle, type RunOpts } from './services/agent';
import { startLoop, stopLoop, loopStatus } from './services/loop';
import { pnlSummary, pnlRecent, settledTrades } from './services/pnl';
import { claimAll, findClaimable, countOpenByMarket } from './services/settlement';
import { eventBook, listEventMarketRows } from './services/sdk';
import { buildPerformanceReport } from './services/report';
import {
  readAllFromDisk,
  signerAddress,
  currentAnchor,
  verifyChain,
  appendEntry,
  computeHash,
} from './services/store';
import { verifyProofSignature } from './services/proof';
import { createUserSession, getUserSession, revokeUserSession } from './services/sessions';

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}
function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/**
 * Register all Somnus tools on a given MCP server. Shared by the local stdio
 * server (mcp-server.ts) and the remote HTTP server (mcp-http.ts) so both expose
 * exactly the same surface.
 */
export function registerSomnusTools(
  server: McpServer,
  ctx: { getUserId: () => string | null },
): void {
  server.registerTool(
    'somnus_config_get',
    {
      title: 'Somnus config (get)',
      description: 'Read the Somnus agent config and effective dry-run mode.',
      inputSchema: {},
    },
    async () => {
      try {
        const config = loadAgentConfig();
        return text({ ok: true, config, effectiveDryRun: effectiveDryRun(), signer: signerAddress() ?? null });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_config_set',
    {
      title: 'Somnus config (set)',
      description:
        'Adjust Somnus risk/run limits via a partial update (values sanitized). Writes an auditable config-change proof entry. Use maxDailyLoss 0 for no daily cap, maxTradeSize up to 1000.',
      inputSchema: {
        maxTradeSize: z.number().positive().max(1000).optional().describe('Max tUSDC per position (1-1000).'),
        maxDailyLoss: z.number().min(0).max(10000).optional().describe('Max realized loss per UTC day before pause. 0 = no daily cap (unlimited).'),
        maxConsecutiveLosses: z.number().int().min(0).max(100).optional().describe('Consecutive settled losses before pause. 0 = no streak cap.'),
        edgePreset: z.enum(['very-sure', 'middle', 'a-bit-sure']).optional().describe('How sure: very-sure 7% / middle 5% / a-bit-sure 3%.'),
        minEdge: z.number().min(0).max(0.5).optional().describe('Custom min edge, overrides preset if both set.'),
        mode: z.enum(['live', 'dry-run']).optional().describe('live = real on-chain orders; dry-run = simulate only.'),
        symbols: z.array(z.string()).optional().describe('Market symbols to trade, e.g. ["BTC","ETH"].'),
        intervalMs: z.number().int().min(5000).max(3600000).optional().describe('Autonomous loop interval in ms.'),
        maxOpenPositions: z.number().int().min(1).max(100).optional().describe('Max simultaneous open positions.'),
        maxPerMarket: z.number().int().min(0).max(100).optional().describe('Max per window (0 = unlimited per window).'),
      },
    },
    async (args) => {
      try {
        const current = loadAgentConfig();
        const patch: Record<string, unknown> = {};
        for (const k of [
          'maxTradeSize',
          'maxDailyLoss',
          'maxConsecutiveLosses',
          'edgePreset',
          'minEdge',
          'mode',
          'symbols',
          'intervalMs',
          'maxOpenPositions',
          'maxPerMarket',
        ] as const) {
          if ((args as Record<string, unknown>)[k] !== undefined) patch[k] = (args as Record<string, unknown>)[k];
        }
        const next = sanitize({ ...current, ...patch } as never);
        // sanitize already maps edgePreset -> minEdge, but ensure save uses sanitized
        (saveAgentConfig as unknown as (d: unknown) => void)(next);
        await appendEntry({
          kind: 'config',
          payload: { reason: 'mcp-config-set', before: current, after: next },
        });
        return text({ ok: true, config: next, effectiveDryRun: effectiveDryRun(next as never) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_scan',
    {
      title: 'Somnus scan (no trade)',
      description:
        'Scan live Event Contract windows and show edges without placing orders. Agent stays on until edge appears.',
      inputSchema: {
        symbols: z.array(z.string()).optional().describe('Filter symbols, e.g. ["BTC"].'),
      },
    },
    async (args) => {
      try {
        const out = await runCycle({
          ...(args.symbols ? { symbols: args.symbols } : {}),
          requireConfirm: true,
        } as never);
        const preview = out.pending.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          horizon: p.horizon,
          fair: p.fair,
          mid: p.mid,
          edgePct: Number((p.edge * 100).toFixed(2)),
          requiredPct: Number((p.requiredEdge * 100).toFixed(2)),
          cost: p.cost,
          payoutIfWin: p.payoutIfWin,
          price: p.price,
          size: p.size,
          preset: p.preset,
          reason: p.decision.reason,
        }));
        return text({
          ok: true,
          found: preview.length,
          preview,
          decisions: out.decisions.length,
          books: out.books.length,
          errors: out.errors,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_trade',
    {
      title: 'Somnus trade (one-tap)',
      description:
        'Simplest trade: say amount. Agent stays on until it finds edge and places ONE trade. For ChatGPT: "Trade $50" -> somnus_trade {amount:50}. Caps at $1000, uses saved edge.',
      inputSchema: {
        amount: z.number().positive().max(1000).describe('tUSDC to risk on this trade (1-1000).'),
        symbol: z.string().optional().describe('Asset to trade, e.g. "BTC". Defaults to BTC+ETH.'),
      },
    },
    async (args) => {
      try {
        const symbols = args.symbol ? [args.symbol.toUpperCase()] : undefined;
        const out = await runCycle({ maxTrades: 1, maxTradeSize: args.amount, ...(symbols ? { symbols } : {}) });
        const order = out.orders[0];
        const plain = order
          ? order.status === 'submitted'
            ? `Placed $${(order.size * order.price).toFixed(2)} on ${order.symbol.split('/')[0]} ${order.price < 0.5 ? 'UP' : 'DOWN'} — ${order.size} contracts @ ${order.price} tx ${order.txHash ?? ''}`
            : `No fill: ${order.reason} — staying on, will retry next window`
          : out.pending[0]
            ? `Found: ${out.pending[0].symbol} — Cost $${out.pending[0].cost} → Win $${out.pending[0].payoutIfWin} (ask confirm)`
            : `No edge this minute — staying on, hunting next window automatically.`
        return text({ ok: true, amount: args.amount, plain, orders: out.orders, pending: out.pending, decisions: out.decisions.length });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_run',
    {
      title: 'Somnus run cycle',
      description:
        'Run one Somnus trade cycle: scan markets, decide edges, place orders. You MUST specify how many trades and how much tUSDC per trade. These override the saved config for this run only.',
      inputSchema: {
        trades: z.number().int().min(1).max(50).describe('How many trades to place this run (1-50).'),
        sizePerTrade: z
          .number()
          .positive()
          .max(1000)
          .describe('tUSDC to risk per trade (overrides config.maxTradeSize).'),
        symbols: z
          .array(z.string())
          .optional()
          .describe('Markets to trade, e.g. ["BTC","ETH"]. Defaults to config.symbols.'),
        minEdge: z
          .number()
          .positive()
          .max(0.5)
          .optional()
          .describe('Minimum edge required to trade. Defaults to config.minEdge.'),
        session: z
          .boolean()
          .optional()
          .describe(
            'Trade through YOUR funded session account (non-custodial of your main wallet). Requires wallet auth + a created session. Defaults to the operator key.',
          ),
      },
    },
    async (args) => {
      try {
        const opts: RunOpts = {
          maxTrades: args.trades,
          maxTradeSize: args.sizePerTrade,
          ...(args.symbols ? { symbols: args.symbols } : {}),
          ...(args.minEdge !== undefined ? { minEdge: args.minEdge } : {}),
        };
        if (args.session === true) {
          const uid = ctx.getUserId();
          if (!uid) {
            return fail('wallet auth required: connect your wallet and pass the JWT in Authorization');
          }
          const s = getUserSession(uid);
          if (!s) {
            return fail('no session yet — call somnus_session_create, fund the returned address with tUSDC, then retry');
          }
          opts.sessionSeed = s.seed as `0x${string}`;
        }
        const out = await runCycle(opts);
        const plainOrders = out.orders.map((o) => ({
          plain: o.status === 'submitted' ? `Placed $${(o.size * o.price).toFixed(2)} tx ${o.txHash ?? ''}` : `No fill: ${o.reason}`,
          order: o,
        }));
        return text({ ok: true, requestedTrades: args.trades, sizePerTrade: args.sizePerTrade, session: args.session === true, plainOrders, pending: out.pending, decisions: out.decisions.length });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_scan_markets',
    {
      title: 'Somnus markets live',
      description: 'List live Event Contract windows with current books (no decision). Shows what the market offers right now.',
      inputSchema: {
        symbols: z.array(z.string()).optional().describe('Filter by asset, e.g. ["BTC"].'),
      },
    },
    async (args) => {
      try {
        const rows = await listEventMarketRows();
        const filtered = args.symbols?.length ? rows.filter((r) => args.symbols!.map((s) => s.toUpperCase()).includes(r.asset.toUpperCase())) : rows;
        const sample = await Promise.all(
          filtered.slice(0, 8).map(async (r) => {
            try {
              const book = await eventBook(r.symbol, 3);
              return { symbol: r.symbol, asset: r.asset, expiry: r.expiry, intervalSec: r.intervalSec, book };
            } catch {
              return { symbol: r.symbol, asset: r.asset, book: null };
            }
          }),
        );
        return text({ ok: true, total: filtered.length, sample });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_positions',
    {
      title: 'Somnus positions',
      description: 'Show open on-chain positions, claimable winners, and settled losers — live mark-to-market not just ledger.',
      inputSchema: {},
    },
    async () => {
      try {
        const openByMarket = await countOpenByMarket();
        const claimScan = await findClaimable();
        const settled = settledTrades().slice(-20).reverse();
        const report = buildPerformanceReport();
        return text({
          ok: true,
          openPositions: [...openByMarket.entries()].map(([marketId, c]) => ({ marketId, count: c })),
          openCount: [...openByMarket.values()].reduce((a, b) => a + b, 0),
          claimable: claimScan.claimable,
          settledLosers: claimScan.settledLosers,
          recentSettled: settled,
          performance: { pnl: report.pnl, winRate: report.pnl.winRate, realizedPnl: report.pnl.realizedPnl },
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_loop_start',
    {
      title: 'Somnus loop start',
      description:
        'Start the autonomous trading loop (repeats every intervalMs). Optionally override sizePerTrade and edgePreset for this loop session (saved to config).',
      inputSchema: {
        sizePerTrade: z.number().positive().max(1000).optional().describe('tUSDC per trade for the loop (overrides config).'),
        edgePreset: z.enum(['very-sure', 'middle', 'a-bit-sure']).optional().describe('Preset for the loop.'),
        intervalMs: z.number().int().min(5000).max(3600000).optional().describe('Loop interval ms.'),
      },
    },
    async (args) => {
      try {
        if (args.sizePerTrade !== undefined || args.edgePreset !== undefined || args.intervalMs !== undefined) {
          const cur = loadAgentConfig();
          const patch: Record<string, unknown> = {};
          if (args.sizePerTrade !== undefined) patch.maxTradeSize = args.sizePerTrade;
          if (args.edgePreset !== undefined) patch.edgePreset = args.edgePreset;
          if (args.intervalMs !== undefined) patch.intervalMs = args.intervalMs;
          const next = sanitize({ ...cur, ...patch } as never);
          (saveAgentConfig as unknown as (d: unknown) => void)(next);
          await appendEntry({ kind: 'config', payload: { reason: 'mcp-loop-start-override', before: cur, after: next } });
        }
        return text({ ok: true, status: startLoop() });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_loop_stop',
    {
      title: 'Somnus loop stop',
      description: 'Stop the autonomous trading loop. Returns loop status.',
      inputSchema: {},
    },
    async () => {
      try {
        return text({ ok: true, status: stopLoop() });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_pnl',
    {
      title: 'Somnus P&L',
      description: 'Read realized/open P&L, win rate, and recent fills from the ledger. Returns plain summary for chat.',
      inputSchema: {},
    },
    async () => {
      try {
        const summary = await pnlSummary();
        const recent = await pnlRecent(5);
        const r0 = recent[0] as unknown as { t: string; symbol?: string; cost?: number; marketId?: string; won?: boolean };
        const plain = `You are ${summary.realizedPnl >= 0 ? 'up' : 'down'} $${Math.abs(summary.realizedPnl).toFixed(2)} over ${summary.closedTrades} settled (win rate ${(summary.winRate * 100).toFixed(1)}%, open $${summary.openCost.toFixed(2)}). Last: ${r0?.t === 'fill' ? `filled ${r0.symbol} $${r0.cost}` : r0?.t === 'settle' ? `${r0.won ? 'won' : 'lost'} ${r0.marketId?.slice(-6)}` : 'no fills yet'}.`;
        return text({ ok: true, plain, summary, recent: recent.slice(0, 3) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_proof_verify',
    {
      title: 'Somnus proof verify',
      description:
        'Verify the audit chain: hash linkage plus signature of every entry against the configured signer.',
      inputSchema: {},
    },
    async () => {
      try {
        const entries = readAllFromDisk();
        const anchor = currentAnchor();
        const chain = verifyChain('0'.repeat(64), entries);
        const signer = signerAddress();
        let signatureOk = true;
        let badSignatures = 0;
        if (signer) {
          for (const e of entries) {
            if (!e.signature) continue;
            const proofHash = computeHash(e.prevHash, e.payloadHash, e.kind);
            if (!(await verifyProofSignature(proofHash, e.signature, signer))) {
              signatureOk = false;
              badSignatures++;
            }
          }
        }
        return text({
          ok: chain.ok && (signer ? signatureOk : true),
          entries: entries.length,
          anchor,
          hashChainOk: chain.ok,
          hashChainChecked: chain.checked,
          signer: signer ?? null,
          signatureOk: signer ? signatureOk : null,
          badSignatures: signer ? badSignatures : null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_claim',
    {
      title: 'Somnus claim',
      description:
        'Claim/redeem settled winning positions on-chain. go:true actually redeems; go:false (default) is a safe no-op preview.',
      inputSchema: {
        go: z.boolean().optional().describe('Set true to redeem settled positions. Defaults to false (preview only).'),
      },
    },
    async (args) => {
      try {
        if (args.go !== true) {
          return text({
            ok: true,
            preview: true,
            message: 'No redemption performed. Call again with go:true to redeem settled positions.',
          });
        }
        const res = await claimAll();
        return text({ ok: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'somnus_session_create',
    {
      title: 'Somnus session create',
      description:
        'Create a per-user Somnia session key for non-custodial trading. Returns a session address to fund with tUSDC. Requires wallet auth (Authorization: Bearer <jwt>).',
      inputSchema: {},
    },
    async () => {
      const uid = ctx.getUserId();
      if (!uid) {
        return fail('wallet auth required: connect your wallet and pass the JWT in the Authorization header');
      }
      const s = createUserSession(uid);
      return text({
        ok: true,
        userId: uid,
        sessionAddress: s.address,
        note: 'Fund this address with tUSDC on Somnia testnet. Then run somnus_run with session:true to trade through it (non-custodial of your main wallet).',
      });
    },
  );

  server.registerTool(
    'somnus_session_status',
    {
      title: 'Somnus session status',
      description: 'Show the caller session address and whether one exists. Requires wallet auth.',
      inputSchema: {},
    },
    async () => {
      const uid = ctx.getUserId();
      if (!uid) {
        return fail('wallet auth required: connect your wallet and pass the JWT in the Authorization header');
      }
      const s = getUserSession(uid);
      if (!s) {
        return text({ ok: true, hasSession: false, message: 'No session yet — call somnus_session_create.' });
      }
      return text({ ok: true, hasSession: true, sessionAddress: s.address, createdAt: s.createdAt });
    },
  );

  server.registerTool(
    'somnus_session_revoke',
    {
      title: 'Somnus session revoke',
      description: 'Delete the caller session key (agent can no longer trade through it). Requires wallet auth.',
      inputSchema: {},
    },
    async () => {
      const uid = ctx.getUserId();
      if (!uid) {
        return fail('wallet auth required: connect your wallet and pass the JWT in the Authorization header');
      }
      const ok = revokeUserSession(uid);
      return text({ ok, revoked: ok });
    },
  );
}
