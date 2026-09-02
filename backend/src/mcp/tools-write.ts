import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { effectiveDryRun, loadAgentConfig, sanitize, saveAgentConfig } from '../agent-config';
import { runCycle } from '../services/agent';
import { executeStandaloneDecision } from '../services/broker';
import { loopStatus, startLoop, stopLoop } from '../services/loop';
import { listPending, popPending } from '../services/pending';
import { pauseTrading, resumeTrading, reviewAfterSettlement } from '../services/risk';
import { claimAll, sweepSettlements } from '../services/settlement';
import { appendEntry } from '../services/store';
import { createLocalWallet, fundCollateral } from './setup';
import { ok, say, simpleTool, guard } from './shared';
import type { AgentConfigDoc } from '../types';

/** WRITE tools — everything that can move money or change a limit.
 *
 *  These ship ONLY in the local stdio install, never on the hosted URL. The person
 *  running the process owns the wallet, so authority is where it belongs: no key is
 *  handed out, no operator takes custody, and the hosted deployment cannot be made
 *  to trade by anyone who happens to know its address.
 *
 *  Every tool that spends is still gated by the same broker and breakers as the
 *  HTTP API — MCP is a different doorway onto the same enforcement, not a way past
 *  it. Dry-run remains a floor: an order needs both the env flag and saved mode.  */
export function registerWriteTools(server: McpServer): void {
  // ── onboarding ───────────────────────────────────────────────────────────────
  simpleTool(
    server,
    'somnus_setup',
    'First-run setup for a local install: create a fresh trading wallet if none is ' +
      'configured, then fund its collateral from the testnet faucet. The key is written ' +
      'to backend/.env and never returned over this channel. Gas is the one step that ' +
      'cannot be automated — the SDK has no faucet for the gas token — so this reports ' +
      'the address to fund when the wallet is empty.',
    async () => {
      const wallet = createLocalWallet();
      if (wallet.created) {
        return say(
          [
            `Created a new trading wallet: ${wallet.address}`,
            '',
            wallet.note,
            '',
            'Next: send a small amount of the native gas token to that address (Somnia\'s public',
            'testnet faucet, or any funded wallet), restart Somnus, then run somnus_setup again to',
            'draw trading collateral. Dry-run stays on until you explicitly switch to live.',
          ].join('\n'),
        );
      }
      const funded = await fundCollateral();
      return ok({ wallet: { address: wallet.address, alreadyExisted: true }, funding: funded });
    },
  );

  // ── scanning and manual trading ──────────────────────────────────────────────
  server.registerTool(
    'somnus_scan',
    {
      description:
        'Run one decision cycle: price the live windows, compute fair value, and report ' +
        'what it would trade and why. With confirm=false (the default) nothing is placed — ' +
        'candidates come back as pending trades you confirm with somnus_confirm.',
      inputSchema: {
        maxTradeSize: z.number().positive().optional().describe('Collateral per trade for this run only'),
        maxTrades: z.number().int().positive().optional().describe('Cap orders placed this run'),
        minEdge: z.number().min(0).max(1).optional().describe('Minimum edge for this run, e.g. 0.02'),
        symbols: z.array(z.string()).optional().describe('Assets to consider, e.g. ["BTC","ETH"]'),
        confirm: z.boolean().optional().describe('true = place immediately, skipping the pending step'),
      },
    },
    (args) =>
      guard(async () => {
        const out = await runCycle({
          ...(args.maxTradeSize !== undefined ? { maxTradeSize: args.maxTradeSize } : {}),
          ...(args.maxTrades !== undefined ? { maxTrades: args.maxTrades } : {}),
          ...(args.minEdge !== undefined ? { minEdge: args.minEdge } : {}),
          ...(args.symbols !== undefined ? { symbols: args.symbols } : {}),
          requireConfirm: args.confirm !== true,
        });
        return ok({
          dryRun: effectiveDryRun(),
          decisions: out.decisions.map((d) => ({
            symbol: d.symbol,
            action: d.action,
            horizon: d.horizon,
            tier: d.horizonTier,
            fair: d.fair,
            bid: d.bid,
            ask: d.ask,
            edge: d.edge,
            requiredEdge: d.requiredEdge,
            reason: d.reason,
          })),
          pending: out.pending.map((p) => ({
            id: p.id,
            symbol: p.symbol,
            horizon: p.horizon,
            cost: p.cost,
            payoutIfWin: p.payoutIfWin,
            edge: p.edge,
            expiresInSec: 90,
          })),
          orders: out.orders,
          errors: out.errors,
          note:
            out.pending.length > 0
              ? 'Pending trades expire after 90 seconds — confirm promptly or re-scan.'
              : undefined,
        });
      }),
  );

  server.registerTool(
    'somnus_confirm',
    {
      description:
        'Place a pending trade found by somnus_scan. Re-reads exposure baselines from ' +
        'chain and ledger first, so every limit binds on this path exactly as it does in ' +
        'the autonomous loop.',
      inputSchema: { id: z.string().describe('Pending trade id from somnus_scan') },
    },
    ({ id }) =>
      guard(async () => {
        const pending = popPending(id);
        if (!pending) {
          return ok({
            placed: false,
            reason: 'Pending trade not found or expired (they last 90 seconds). Re-run somnus_scan.',
            stillPending: listPending().map((p) => p.id),
          });
        }
        const order = await executeStandaloneDecision(pending.decision);
        return ok({
          placed: order.status === 'submitted',
          status: order.status,
          symbol: order.symbol,
          price: order.price,
          requestedSize: order.size,
          filledSize: order.filledSize,
          fillStatus: order.fillStatus,
          gasNative: order.gasNative,
          txHash: order.txHash,
          reason: order.reason,
        });
      }),
  );

  // ── autonomous operation ─────────────────────────────────────────────────────
  simpleTool(
    server,
    'somnus_loop_start',
    'Arm the autonomous loop: scan, decide and trade on the saved interval, settling and ' +
      'claiming by itself. This is how the agent runs unattended.',
    async () => {
      const rules = loadAgentConfig();
      const loop = startLoop();
      return ok({
        loop,
        dryRun: effectiveDryRun(rules),
        warning: effectiveDryRun(rules)
          ? 'Dry-run: decisions are recorded, no orders are sent.'
          : `LIVE: real orders every ${rules.intervalMs / 1000}s, up to ${rules.maxTradeSize} per trade.`,
      });
    },
  );

  simpleTool(server, 'somnus_loop_stop', 'Stop the autonomous loop. Open positions are untouched and still settle.', async () =>
    ok({ loop: stopLoop() }),
  );

  simpleTool(
    server,
    'somnus_loop_status',
    'Is the loop running, how many cycles has it completed, and what did the last one do?',
    async () => ok({ loop: loopStatus(), dryRun: effectiveDryRun() }),
  );

  // ── the kill switch ──────────────────────────────────────────────────────────
  server.registerTool(
    'somnus_pause',
    {
      description:
        'Emergency stop. Sets the persistent kill switch and halts the loop — the pause ' +
        'survives a restart and only an explicit resume clears it. Existing positions are ' +
        'left alone and still settle and claim; this stops NEW risk, it does not liquidate.',
      inputSchema: { reason: z.string().optional().describe('Why, for the audit trail') },
    },
    ({ reason }) =>
      guard(async () => {
        const status = pauseTrading(reason?.trim() || 'paused via MCP');
        stopLoop();
        await appendEntry({ kind: 'config', payload: { action: 'pause', reason, via: 'mcp' } });
        return ok({ paused: status.paused, pauseReason: status.pauseReason, blocked: status.blocked });
      }),
  );

  server.registerTool(
    'somnus_resume',
    {
      description:
        'Clear the kill switch. Does not restart the loop — arming trading and arming the ' +
        'scheduler are separate acts. Set clearFailures only when a venue problem the ' +
        'execution-failure counter was measuring has actually been fixed.',
      inputSchema: {
        clearFailures: z.boolean().optional().describe('Also reset the execution-failure counter'),
      },
    },
    ({ clearFailures }) =>
      guard(async () => {
        const status = resumeTrading({ clearFailures: clearFailures === true });
        await appendEntry({ kind: 'config', payload: { action: 'resume', clearFailures, via: 'mcp' } });
        return ok({
          tradingAllowed: status.ok,
          stillBlocked: status.blocked,
          note: status.ok ? 'Run somnus_loop_start to resume autonomous trading.' : undefined,
        });
      }),
  );

  // ── limits ───────────────────────────────────────────────────────────────────
  server.registerTool(
    'somnus_config_set',
    {
      description:
        'Change the rules the agent enforces. Values are clamped to a sane envelope, so no ' +
        'call here can hand the agent an unlimited mandate. The change itself is written to ' +
        'the audit chain, so you can prove what the limits were when any order was placed.',
      inputSchema: {
        maxTradeSize: z.number().min(0).max(10_000).optional().describe('Collateral per trade'),
        maxOpenNotional: z.number().min(0).optional().describe('Total collateral at risk at once (0 = off)'),
        maxDailyLoss: z.number().min(0).optional().describe('Realised loss per UTC day before self-pause'),
        maxDrawdown: z.number().min(0).optional().describe('Loss from equity peak before self-pause (0 = off)'),
        minEdge: z.number().min(0).max(1).optional().describe('Minimum edge to trade, e.g. 0.02 for 2%'),
        maxOpenPositions: z.number().int().min(0).max(100).optional(),
        maxPerExpiryBucket: z.number().int().min(0).max(100).optional().describe('Positions sharing one expiry'),
        intervalMs: z.number().int().min(5_000).optional().describe('Loop interval in milliseconds'),
        symbols: z.array(z.string()).optional().describe('Assets to trade, e.g. ["BTC","ETH"]'),
        mode: z.enum(['dry-run', 'live', 'view']).optional().describe('live also requires DRY_RUN=false in .env'),
      },
    },
    (args) =>
      guard(async () => {
        const next = sanitize({ ...loadAgentConfig(), ...args } as AgentConfigDoc);
        await appendEntry({ kind: 'config', payload: { config: next, via: 'mcp' } });
        saveAgentConfig(next);
        return ok({
          config: next,
          effectiveDryRun: effectiveDryRun(next),
          note:
            args.mode === 'live' && effectiveDryRun(next)
              ? 'Mode is saved as live but DRY_RUN=true in .env still forces dry-run. Both must permit it.'
              : undefined,
        });
      }),
  );

  // ── settlement ───────────────────────────────────────────────────────────────
  simpleTool(
    server,
    'somnus_settle',
    'Realise the outcome of settled positions without redeeming them. This is what keeps ' +
      'the loss limits honest: settlement determines P&L, redemption only moves the ' +
      'collateral back, and the breakers read the ledger this writes.',
    async () => {
      const sweep = await sweepSettlements();
      const risk = reviewAfterSettlement();
      return ok({ sweep, tradingAllowed: risk.ok, blocked: risk.blocked });
    },
  );

  simpleTool(
    server,
    'somnus_claim',
    'Redeem settled winning positions back into collateral. Honours dry-run and the saved ' +
      'claimEnabled rule, and records the attempt in the audit chain either way.',
    async () => ok(await claimAll()),
  );
}

/** Tools that are safe to expose but only make sense with a wallet configured.
 *  Kept separate so a future hosted-with-deposits deployment can pick and choose. */
export function writeToolNames(): string[] {
  return [
    'somnus_setup',
    'somnus_scan',
    'somnus_confirm',
    'somnus_loop_start',
    'somnus_loop_stop',
    'somnus_loop_status',
    'somnus_pause',
    'somnus_resume',
    'somnus_config_set',
    'somnus_settle',
    'somnus_claim',
  ];
}
