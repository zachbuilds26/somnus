import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  claimUserPositions,
  fundUserWallet,
  maxUserStake,
  minUserGas,
  placeUserTrade,
  quoteUserTrades,
  userMinEdgeFloor,
  userPositions,
  userTradingAvailable,
  userTradesPerHour,
  userWalletSnapshot,
} from '../services/user-trading';
import { ok, guard } from './shared';
import type { UserIdentity } from './identity';

/** PER-USER tools — the caller's own wallet, on the hosted endpoint.
 *
 *  The read tools let a stranger interrogate the agent. These let them trade with
 *  it: a token in the request header derives a wallet (identity.ts), and the agent's
 *  own model prices a trade that wallet signs and pays for. No key is handed out and
 *  the operator's wallet is never touched.
 *
 *  Registered ONLY when the deployment sets SOMNUS_USER_SECRET, so a server without
 *  one advertises nothing it cannot do. Everything that spends is additionally gated
 *  on `confirm: true`, a hard per-trade cap, an hourly rate limit, the operator's
 *  kill switch, and the wallet's own balance — see services/user-trading.ts.
 *
 *  Custodial, and said plainly rather than buried: this server can recompute the key
 *  for any token, so it could move any caller's funds. That is unavoidable on a venue
 *  with no scoped permissions, and acceptable only because these are faucet-funded
 *  testnet balances with no market value.                                          */

/** How the tools get the caller's identity. Injected because the answer differs by
 *  transport: an HTTP request carries a header, a stdio process reads its env. Throws
 *  (rather than returning undefined) so the reason a caller is anonymous reaches them
 *  as a tool error they can act on. */
export type IdentityResolver = () => UserIdentity;

export function registerUserTools(server: McpServer, resolve: IdentityResolver): void {
  server.registerTool(
    'somnus_my_wallet',
    {
      description:
        'Your own trading wallet on this hosted agent, derived from the token you sent. ' +
        'Reports its address, gas and collateral balances, the limits it trades under, and ' +
        'what to do next. The same token always derives the same wallet — nothing is stored ' +
        'server-side, so there is nothing to lose in a deploy and nothing to recover.',
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const identity = resolve();
        const snapshot = await userWalletSnapshot(identity);
        const availability = userTradingAvailable();
        return ok({
          address: snapshot.address,
          handle: snapshot.handle,
          gas: snapshot.gas,
          gasCode: snapshot.gasCode,
          collateral: snapshot.collateral,
          collateralCode: snapshot.collateralCode,
          unconfirmed: snapshot.unconfirmed,
          readError: snapshot.error,
          tradingMode: availability.mode,
          tradingBlocked: availability.ok ? undefined : availability.reason,
          maxPerTrade: maxUserStake(),
          minGasToTransact: minUserGas(),
          minEdgeFloor: userMinEdgeFloor(),
          tradesPerHour: userTradesPerHour(),
          nextStep: nextStep(snapshot.gas, snapshot.collateral),
          custody:
            'This wallet is derived from your token by the server, so the server can derive its key ' +
            'too — it is custodial. Testnet only, faucet funds only, nothing you would miss.',
        });
      }),
  );

  server.registerTool(
    'somnus_my_fund',
    {
      description:
        'Draw testnet tUSDC collateral into your derived wallet from the SDK faucet. ' +
        'Rate-limited per address by the venue, so a second call on a funded wallet is ' +
        'expected to revert and is reported as an outcome rather than an error. One step ' +
        'cannot be automated: the faucet mints collateral only, and minting is itself a ' +
        'transaction, so the wallet needs a little native gas first.',
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const identity = resolve();
        return ok(await fundUserWallet(identity));
      }),
  );

  server.registerTool(
    'somnus_my_quote',
    {
      description:
        'What would the agent trade for you right now, and at what price? Prices the live ' +
        'windows with the same model, horizon tiers and edge bar it applies to its own ' +
        'money, sized to your stake. Your stake is a ceiling: on a window class the model ' +
        'has not yet proven itself on it deliberately sizes at half and demands double the ' +
        'edge, so read each quote\'s sizingNote for why it costs what it costs. Reads only ' +
        '— it signs nothing and spends nothing, and an empty answer is the normal one: the ' +
        'model acts only when the book disagrees with it.',
      inputSchema: {
        stake: z
          .number()
          .positive()
          .optional()
          .describe(
            `Collateral to risk on one trade, tUSDC. Clamped to ${maxUserStake()}. This is a ` +
              'CEILING, not a fixed amount: a window whose horizon class the model has not ' +
              'proven itself on is sized at half, and contracts are whole units so the ' +
              'remainder is left unspent. Every quote reports stakeUsed and a sizingNote ' +
              'explaining its own cost.',
          ),
        minEdge: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Extra edge to demand, e.g. 0.05 for 5pp. Cannot go below the floor.'),
        symbols: z.array(z.string()).optional().describe('Assets to consider, e.g. ["BTC","ETH"]'),
      },
    },
    (args) =>
      guard(async () => {
        resolve();
        return ok(
          await quoteUserTrades({
            ...(args.stake !== undefined ? { stake: args.stake } : {}),
            ...(args.minEdge !== undefined ? { minEdge: args.minEdge } : {}),
            ...(args.symbols !== undefined ? { symbols: args.symbols } : {}),
          }),
        );
      }),
  );

  server.registerTool(
    'somnus_my_trade',
    {
      description:
        'Place a trade from YOUR derived wallet, chosen by the agent\'s model. Without ' +
        'confirm it re-prices and returns exactly what it would buy and for how much, ' +
        'sending nothing. With confirm:true it re-reads the book, re-prices from scratch ' +
        '(never from a stale quote) and submits an IOC signed by your wallet. The side is ' +
        'the model\'s call, not an argument: you choose the window and the stake, it ' +
        'chooses Up or Down or refuses. Settles by itself at the window expiry.',
      inputSchema: {
        symbol: z
          .string()
          .optional()
          .describe('Window to trade, from somnus_my_quote. Omit to take the best edge available.'),
        stake: z
          .number()
          .positive()
          .optional()
          .describe(
            `Collateral to risk, tUSDC. Clamped to ${maxUserStake()}. A CEILING, not a fixed ` +
              'amount — see sizingNote on the result for why a given trade cost less.',
          ),
        minEdge: z.number().min(0).max(1).optional().describe('Extra edge to demand before trading'),
        symbols: z.array(z.string()).optional().describe('Assets to consider when no symbol is given'),
        confirm: z.boolean().optional().describe('true = actually send it. Nothing is sent without this.'),
      },
    },
    (args) =>
      guard(async () => {
        const identity = resolve();
        return ok(
          await placeUserTrade(identity, {
            ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
            ...(args.stake !== undefined ? { stake: args.stake } : {}),
            ...(args.minEdge !== undefined ? { minEdge: args.minEdge } : {}),
            ...(args.symbols !== undefined ? { symbols: args.symbols } : {}),
            confirm: args.confirm === true,
          }),
        );
      }),
  );

  server.registerTool(
    'somnus_my_positions',
    {
      description:
        'What your derived wallet is holding: open positions with the time left on each, ' +
        'settled winners waiting to be redeemed, and settled losers. Read straight off the ' +
        'chain — this server keeps no per-user ledger, so there is nothing here that could ' +
        'disagree with the venue.',
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const identity = resolve();
        return ok(await userPositions(identity));
      }),
  );

  server.registerTool(
    'somnus_my_claim',
    {
      description:
        'Redeem your settled winning positions back into collateral, in one batched ' +
        'transaction signed by your wallet. Without confirm it lists what would be redeemed ' +
        'and for how much. Winnings do not expire, so there is no rush and no penalty for ' +
        'checking first.',
      inputSchema: {
        confirm: z.boolean().optional().describe('true = actually redeem. Nothing is sent without this.'),
      },
    },
    (args) =>
      guard(async () => {
        const identity = resolve();
        return ok(await claimUserPositions(identity, args.confirm === true));
      }),
  );
}

/** The one sentence a caller most needs after asking about their wallet. */
function nextStep(gas: number | undefined, collateral: number | undefined): string {
  if (gas === undefined || gas < minUserGas()) {
    return (
      `Send about ${minUserGas()} of the native gas token to this address (Somnia's public testnet ` +
      'faucet, or any funded wallet). A trade only burns ~0.004 of it, but the venue reserves the ' +
      'worst-case fee against your balance before it will accept any transaction — and no faucet in ' +
      'the SDK mints gas, so this is the one step that cannot be automated.'
    );
  }
  if (collateral === undefined || collateral <= 0) {
    return 'Run somnus_my_fund to draw testnet tUSDC collateral, then somnus_my_quote.';
  }
  return 'Run somnus_my_quote to see what the agent would trade for you.';
}

/** Names registered here, for tests and for the boot log. */
export function userToolNames(): string[] {
  return [
    'somnus_my_wallet',
    'somnus_my_fund',
    'somnus_my_quote',
    'somnus_my_trade',
    'somnus_my_positions',
    'somnus_my_claim',
  ];
}
