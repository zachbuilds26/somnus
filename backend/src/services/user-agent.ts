import { randomUUID } from 'node:crypto';
import { SomniaMarkets } from '@somnia-chain/markets-sdk';
import { somniaShannon, somniaMainnet } from '@somnia-chain/markets-sdk/chains';
import { SOMNIA_TESTNET_ADDRESSES, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from '@somnia-chain/markets-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { config, debug, log, warn } from '../config';
import { saveUser, type SomnusUser } from './users';
import { appendEntry } from './store';

const notify = async (_chatId: number, _text: string): Promise<void> => {
  // Web-only: keep as no-op, web polls /api/agent/pnl and /api/agent/claimable
};
import { listEventMarketRows, eventBook, nativeGasBalance } from './sdk';
import { buildSignalContext, estimateFair } from './signal';
import { decideFromFair } from './pricing';
import { horizonPolicy } from './horizon';
import { crossingPrice } from './broker';
import { placeLiveOrderOn } from './sdk-live';
import { recordFill } from './pnl';
import type { Decision, OrderLog } from '../types';

const isMainnet = config.network === 'mainnet';
const ADDRESSES = isMainnet ? SOMNIA_MAINNET_ADDRESSES : SOMNIA_TESTNET_ADDRESSES;
const CHAIN = isMainnet ? somniaMainnet : somniaShannon;

export class UserAgent {
  private exchange: SomniaMarkets;
  private user: SomnusUser;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private cycles = 0;

  constructor(user: SomnusUser) {
    this.user = user;
    this.exchange = new SomniaMarkets({
      indexerUrl: config.indexerUrl,
      chain: CHAIN,
      wsRpcUrl: config.wsRpcUrl,
      addresses: ADDRESSES,
      privateKey: user.privateKey as `0x${string}`,
      ...(isMainnet ? {} : { priceFeed: SOMNIA_TESTNET_PRICE_FEED }),
    });
  }

  get userId(): number { return this.user.chatId; }
  get isRunning(): boolean { return this.timer !== undefined; }
  get cycleCount(): number { return this.cycles; }

  setConfig(opts: { budget?: number; markets?: string[] }): void {
    if (opts.budget !== undefined) this.user.config.maxTradeSize = opts.budget;
    if (opts.markets !== undefined) this.user.config.symbols = opts.markets;
    saveUser(this.user);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    log(`user ${this.user.chatId}: starting agent loop`);

    // Load markets into the user's exchange
    try {
      await this.exchange.loadMarkets(true);
    } catch (err) {
      warn(`user ${this.user.chatId}: initial loadMarkets failed`, (err as Error).message);
    }

    this.user.loopRunning = true;
    this.user.lastActivityAt = Date.now();
    saveUser(this.user);

    this.timer = setInterval(() => void this.tick(), this.user.config.mode === 'dry-run' ? 60_000 : 60_000);

    notify(this.user.chatId,
      `Agent started!\n\n` +
      `Mode: ${this.user.config.mode.toUpperCase()}\n` +
      `Edge: ${(this.user.config.minEdge * 100).toFixed(1)}%\n` +
      `Max trade: $${this.user.config.maxTradeSize}\n` +
      `Open positions: ${this.user.config.maxOpenPositions}\n` +
      `Symbols: ${this.user.config.symbols.join(', ')}\n\n` +
      `I'll notify you on every trade.\n` +
      `Stop anytime with /stop`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.user.loopRunning = false;
    saveUser(this.user);
    notify(this.user.chatId, 'Agent stopped.');
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.cycle();
    } catch (err) {
      warn(`user ${this.user.chatId}: cycle error`, (err as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private async cycle(): Promise<void> {
    this.cycles++;

    // Reload markets periodically
    try {
      await this.exchange.loadMarkets(true);
    } catch {
      return; // indexer flaky
    }

    const assets = [...new Set(this.user.config.symbols.map((s) => s.toUpperCase()))];
    const ctx = await buildSignalContext(assets);

    const rows = await listEventMarketRows();
    const byAsset = assets.length > 0 ? rows.filter((r) => assets.includes(r.asset.toUpperCase())) : rows;

    const nowSec = Math.floor(Date.now() / 1000);
    let traded = false;
    for (const row of byAsset.slice(0, 8)) {
      try {
        const left = row.expiry === undefined ? Number.NaN : row.expiry - nowSec;
        const policy = horizonPolicy(row.intervalSec, left);
        if (policy.tier === 'blocked') continue;

        const book = await eventBook(row.symbol, 5);
        if (book.bid === undefined && book.ask === undefined) continue;

        // Real, independent probability from the shared GBM signal — NOT the book
        // mid, which treated every spread as free alpha and lost money on average.
        const modelled = estimateFair(row, ctx);
        if (!modelled) continue;

        const maxSize = this.user.config.maxTradeSize * policy.sizeMultiplier;
        const decide = decideFromFair(modelled.fair, book, {
          minEdge: this.user.config.minEdge * policy.edgeMultiplier,
          maxSize,
        });
        if (decide.action === 'PASS') continue;

        const isUp = decide.action === 'BUY_YES';
        const quoted = isUp ? decide.ask : decide.bid;
        const fairForSide = isUp ? modelled.fair : 1 - modelled.fair;
        const price = crossingPrice(quoted, fairForSide);
        if (price === undefined) continue;

        let symbol = row.symbol;
        if (!isUp) {
          if (!row.noSymbol) continue;
          symbol = row.noSymbol;
        }
        // Cost per contract is the price paid for the outcome bought (YES price
        // when Up, NO price when Down); size on that basis so the notional gate
        // and the broker's agree.
        const costPerContract = price;
        const size = Math.floor(maxSize / Math.max(costPerContract, 0.001));
        if (size < 1) continue;

        const decision: Decision = {
          id: randomUUID().slice(0, 8),
          ts: Date.now(),
          symbol: row.symbol,
          fair: round4(modelled.fair),
          mid: decide.mid,
          ask: decide.ask,
          bid: decide.bid,
          edge: decide.edge,
          action: decide.action,
          size,
          horizon: policy.label,
          horizonTier: policy.tier,
          pricedNote: decide.pricedNote,
          reason: `${decide.reason} — ${modelled.note} — ${policy.note} [user ${this.user.chatId}]`,
          dryRun: this.user.config.mode !== 'live',
        };
        // Every user-agent decision and order is written to the SAME proof chain
        // as the main agent, so "auditable" holds for Agent Studio too.
        await appendEntry({ kind: 'decision', payload: { ...decision, userId: this.user.chatId } });

        if (this.user.config.mode !== 'live') {
          const sim: OrderLog = buildUserOrder(decision, 'simulated', 'DRY_RUN (user agent)', false, symbol, price, size);
          await appendEntry({ kind: 'order', payload: { ...sim } });
          traded = true;
          break;
        }

        // Live: ensure the user's own wallet has native gas before spending it.
        const addr = privateKeyToAccount(this.user.privateKey as `0x${string}`).address;
        const gas = await nativeGasBalance(addr);
        if (gas !== undefined && Number(gas) / 1e18 < 0.02) {
          notify(this.user.chatId, `Trade skipped: native gas too low (${(Number(gas) / 1e18).toFixed(4)} STT). Fund your wallet.`);
          continue;
        }

        const result = await placeLiveOrderOn(this.exchange, { symbol, price, size });
        const live: OrderLog = buildUserOrder(decision, 'submitted', result.reason, false, symbol, price, size, result.txHash);
        await appendEntry({ kind: 'order', payload: { ...live } });
        if (row.marketId) {
          const idx: 0 | 1 = isUp ? 0 : 1;
          recordFill(row.marketId, idx, size, price * size, { userId: this.user.chatId, symbol: row.symbol });
        }
        this.user.totalTrades++;
        this.user.lastActivityAt = Date.now();
        saveUser(this.user);

        const sym = row.asset;
        const side = isUp ? 'YES' : 'NO';
        notify(
          this.user.chatId,
          `Trade: ${sym} ${side} @${(price * 100).toFixed(1)}% x${size}\n` +
            `Cost: $${(costPerContract * size).toFixed(2)}\n` +
            `Edge: ${(decide.edge * 100).toFixed(1)}%\n` +
            `Tx: ${result.txHash?.slice(0, 16) ?? 'pending'}...`,
        );
        traded = true;
        break; // one trade per cycle
      } catch (err) {
        debug(`user ${this.user.chatId}: trade error`, (err as Error).message);
      }
    }

    if (!traded && this.cycles % 10 === 0) {
      // Periodic heartbeat
      debug(`user ${this.user.chatId}: cycle ${this.cycles}, no trades`);
    }
  }

  async getStatus(): Promise<string> {
    const address = privateKeyToAccount(this.user.privateKey as `0x${string}`).address;
    const lines = [
      `Wallet: ${address.slice(0, 6)}...${address.slice(-4)}`,
      `Mode: ${this.user.config.mode}`,
      `Loop: ${this.isRunning ? 'running' : 'stopped'}`,
      `Cycles: ${this.cycles}`,
      `Trades: ${this.user.totalTrades} (${this.user.totalWins} wins)`,
      `Edge: ${(this.user.config.minEdge * 100).toFixed(1)}%`,
      `Size: $${this.user.config.maxTradeSize}`,
      `Symbols: ${this.user.config.symbols.join(', ')}`,
    ];
    return lines.join('\n');
  }
}

/** Build an OrderLog for a user-agent trade so it matches the main agent's proof
 *  shape (and therefore the same verifier). `marketId` is omitted here because the
 *  user-agent resolves the outcome symbol directly; the decision already carries
 *  the window symbol for attribution. */
function buildUserOrder(
  d: Decision,
  status: OrderLog['status'],
  reason: string,
  dryRun: boolean,
  symbol: string,
  price: number,
  size: number,
  txHash?: string,
): OrderLog {
  return {
    id: d.id,
    ts: Date.now(),
    decisionId: d.id,
    symbol,
    marketId: undefined,
    side: 'buy',
    price,
    size,
    timeInForce: 'IOC',
    dryRun,
    status,
    reason,
    txHash,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Global manager for all user agents. */
const agents = new Map<number, UserAgent>();

export function getOrCreateAgent(user: SomnusUser): UserAgent {
  let agent = agents.get(user.chatId);
  if (!agent) {
    agent = new UserAgent(user);
    agents.set(user.chatId, agent);
  }
  return agent;
}

export function getAgent(chatId: number): UserAgent | undefined {
  return agents.get(chatId);
}

export function stopAllAgents(): void {
  for (const agent of agents.values()) agent.stop();
}

export function activeAgentCount(): number {
  let n = 0;
  for (const agent of agents.values()) if (agent.isRunning) n++;
  return n;
}
