import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_MAINNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
  isBinaryMarket,
} from '@somnia-chain/markets-sdk';
import { somniaShannon, somniaMainnet } from '@somnia-chain/markets-sdk/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { activeKey, config, debug, warn } from '../config';
import { rpcCall } from '../http';
import type { BookTicker, NormalizedMarket } from '../types';

const BALANCE_RPC_TIMEOUT_MS = Number(process.env.AGENT_BALANCE_RPC_TIMEOUT_MS ?? 8_000);

/** Gateway to @somnia-chain/markets-sdk (>= 0.28.1 ??? below that, unified verbs
 *  don't snap prices to the venue tick grid and orders revert `InvalidPrice`).
 *
 *  Pinned to ^0.29.0. Worth knowing why the range matters here: on a 0.x package a
 *  caret does NOT cross the minor, so `^0.28.1` meant `>=0.28.1 <0.29.0` and npm
 *  would never have picked up 0.29.0 on its own. This is the library that signs and
 *  places every order, so silently sitting on an old minor is not a safe default.
 *
 *  Reads are KEYLESS. `privateKey` is optional in the SDK and only writes need
 *  it, so market discovery and order books work with nothing configured ??? the
 *  demo shows live Event Contracts out of the box. Writes go through
 *  `getTradingExchange()`, which is the only path that demands a key.        */

type Exchange = SomniaMarkets;

const isMainnet = config.network === 'mainnet';
const ADDRESSES = isMainnet ? SOMNIA_MAINNET_ADDRESSES : SOMNIA_TESTNET_ADDRESSES;
const CHAIN = isMainnet ? somniaMainnet : somniaShannon;

let readExchange: Exchange | undefined;
let tradeExchange: Exchange | undefined;

/** Last time any live spot/book/candle read succeeded. Drives feed-staleness
 *  detection so the operator (and /health) can tell a "running but blind" agent
 *  from a healthy one, and so the loop can proactively rebuild a dead socket. */
let lastFeedSuccessTs: number | undefined;

/** Per-source feed health, keyed `spot:BTC` / `candles:ETH` / `book`.
 *
 *  The single aggregate timestamp above cannot answer the question that actually
 *  matters when the agent stops trading: WHICH input died. A healthy book read
 *  keeps the aggregate fresh while the oracle is silent, so "feed ok" was
 *  reported during exactly the outage that blocked every trade. Track each source
 *  separately, and never synthesise an ok state — an absent probe means unknown,
 *  which the risk gate treats as not-fresh rather than fine.
 *
 *  Bounded by construction: two assets x two sources plus one aggregated book
 *  key, so this cannot grow with the number of live windows. */
interface FeedProbe {
  ok: boolean;
  /** When the last SUCCESSFUL read landed. */
  okTs?: number;
  /** When the last attempt (success or failure) happened. */
  ts: number;
  failures: number;
  error?: string;
}

const feedProbes = new Map<string, FeedProbe>();
let readClientRebuiltAt: number | undefined;

function markFeed(source: string, ok: boolean, error?: string): void {
  const prev = feedProbes.get(source);
  const now = Date.now();
  feedProbes.set(source, {
    ok,
    okTs: ok ? now : prev?.okTs,
    ts: now,
    failures: ok ? 0 : (prev?.failures ?? 0) + 1,
    error: ok ? undefined : (error ?? 'unknown error').slice(0, 200),
  });
  if (ok) lastFeedSuccessTs = now;
}

export interface FeedSourceHealth {
  source: string;
  ok: boolean;
  /** Age of the last successful read, ms. undefined = never succeeded. */
  ageMs?: number;
  failures: number;
  error?: string;
}

export interface FeedHealthReport {
  sources: FeedSourceHealth[];
  /** Age of the freshest successful read across all sources, ms. */
  newestOkAgeMs?: number;
  /** How many sources are currently failing. */
  failing: number;
  /** When the read client was last rebuilt after a dead socket. */
  readClientRebuiltAt?: number;
}

/** Read-only feed health for /health and the risk gate. */
export function feedHealthReport(): FeedHealthReport {
  const now = Date.now();
  const sources: FeedSourceHealth[] = [...feedProbes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, p]) => ({
      source,
      ok: p.ok,
      ageMs: p.okTs === undefined ? undefined : now - p.okTs,
      failures: p.failures,
      error: p.error,
    }));
  const ages = sources.map((s) => s.ageMs).filter((a): a is number => a !== undefined);
  return {
    sources,
    newestOkAgeMs: ages.length > 0 ? Math.min(...ages) : undefined,
    failing: sources.filter((s) => !s.ok).length,
    readClientRebuiltAt: readClientRebuiltAt,
  };
}

/** Age of the last successful read for one source, or undefined if it has never
 *  succeeded. Undefined means UNKNOWN, not fresh — callers must treat it as
 *  stale. */
export function feedSourceAgeMs(source: string): number | undefined {
  const p = feedProbes.get(source);
  return p?.okTs === undefined ? undefined : Date.now() - p.okTs;
}

function baseConfig() {
  return {
    indexerUrl: config.indexerUrl,
    chain: CHAIN,
    wsRpcUrl: config.wsRpcUrl,
    addresses: ADDRESSES,
    // Required for fetchPrice/fetchPriceOHLCV ??? without it the signal has no
    // independent view of spot and can only echo the book.
    ...(isMainnet ? {} : { priceFeed: SOMNIA_TESTNET_PRICE_FEED }),
  };
}

/** Read-only client ??? no key, no signing. Safe to use for every GET. */
export function getExchange(): Exchange {
  if (!readExchange) {
    readExchange = new SomniaMarkets(baseConfig());
    debug('sdk: read client ready', config.network, config.indexerUrl);
  }
  return readExchange;
}

/** Address of the signing wallet, or undefined when running read-only.
 *  Neither `exchange.trader` nor the exchange exposes this, so derive it. */
export function getSignerAddress(): string | undefined {
  const key = activeKey();
  if (!key) return undefined;
  return privateKeyToAccount(key).address;
}

/** Native-gas (STT) balance for the signing wallet — or for an arbitrary
 *  address when supplied. Event Contracts settle in tUSDC, but every order still
 *  pays GAS in the native token, so a wallet funded with collateral but no STT
 *  reverts at `approve` with the misleading "Missing or invalid parameters".
 *  Call this before trading and refuse early (with a clear message) instead of
 *  burning gas on a doomed approve. Returns undefined when the RPC can't be read,
 *  so the caller can fail open rather than halting on a transient RPC error. */
export async function nativeGasBalance(address?: string): Promise<bigint | undefined> {
  const addr =
    address ??
    (() => {
      const k = activeKey();
      return k ? privateKeyToAccount(k).address : undefined;
    })();
  if (!addr) return undefined;
  try {
    // Bounded: this sits on the pre-submit path, so a hung RPC would stall an order
    // rather than fail it, and the caller has no way to tell the difference.
    const result = await rpcCall<string>(
      config.rpcUrl,
      'eth_getBalance',
      [addr, 'latest'],
      BALANCE_RPC_TIMEOUT_MS,
    );
    return BigInt(result ?? '0x0');
  } catch {
    return undefined;
  }
}

/** Signing client ??? the ONLY path that needs a key. Resolves through
 *  `activeKey()`, the single answer to "which wallet does this process act with",
 *  so orders are signed by the same wallet that signs the audit chain.        */
export function getTradingExchange(): Exchange {
  if (tradeExchange) return tradeExchange;
  const privateKey = activeKey();
  if (!privateKey) {
    throw new Error(
      'live execution needs a key (TRADE_KEY or PRIVATE_KEY) in backend/.env ??? ' +
        'reads (markets, books) work without one.',
    );
  }
  tradeExchange = new SomniaMarkets({ ...baseConfig(), privateKey });
  return tradeExchange;
}

/** The signing client is a SEPARATE SomniaMarkets instance from the read client,
 *  and each keeps its own symbol table. `loadMarkets()` on the reader does
 *  nothing for the writer, so `createOrder` fails with "unknown symbol ??? call
 *  loadMarkets() first".
 *
 *  It also can't be hydrated just once: Event Contract windows are minted
 *  continuously (1m/5m/15m intervals), so any window created after the writer's
 *  snapshot is unknown to it and every order on the freshest ??? most tradeable ???
 *  markets fails. Refresh on a TTL, and allow a forced reload so a miss can be
 *  retried immediately rather than waiting out the TTL.                       */
const TRADE_MARKETS_TTL_MS = 20_000;
let tradeMarketsLoadedAt = 0;

export async function getTradingExchangeReady(forceReload = false): Promise<Exchange> {
  const ex = getTradingExchange();
  const stale = Date.now() - tradeMarketsLoadedAt > TRADE_MARKETS_TTL_MS;
  if (forceReload || stale) {
    await withRetry('trade loadMarkets', () => ex.loadMarkets(true));
    tradeMarketsLoadedAt = Date.now();
    debug(`sdk: trade symbol table hydrated (forced=${forceReload})`);
  }
  return ex;
}

/** ── Per-user signing clients ────────────────────────────────────────────────
 *
 *  A hosted caller identifies with a token and `mcp/identity.ts` turns that token
 *  into a wallet. Signing for it needs its OWN client: the SDK binds one account
 *  at construction and exposes no per-call signer, so the agent's trade client
 *  cannot be borrowed and a key cannot be passed per order.
 *
 *  Three properties, each learned from the trade client above:
 *   - BOUNDED. Every client lazily opens a chain WebSocket and holds the event
 *     loop open. One per visitor on a public endpoint is a socket leak, so this
 *     is an LRU that closes what it evicts. Eviction costs a caller nothing but
 *     a rebuild on their next call.
 *   - keyed by ADDRESS, never by token or private key. The address is derived 1:1
 *     from the key and is safe in a log line, an error message or a heap dump;
 *     the token is the only thing protecting the wallet, so it must not become a
 *     map key that outlives the request.
 *   - its own symbol table, refreshed on the same TTL and for the same reason as
 *     the trade client's — Event Contract windows are minted continuously, and a
 *     client that hydrated a minute ago does not know the freshest ones.        */
const MAX_USER_CLIENTS = Math.max(1, Number(process.env.SOMNUS_MAX_USER_CLIENTS ?? 12));

interface UserClient {
  ex: Exchange;
  marketsLoadedAt: number;
  lastUsed: number;
}

const userClients = new Map<string, UserClient>();

/** Signing client for one derived user wallet. Cheap on a cache hit. */
export function getUserExchange(privateKey: `0x${string}`, address: string): Exchange {
  const key = address.toLowerCase();
  const cached = userClients.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.ex;
  }
  // Make room BEFORE constructing, so the cap is never briefly exceeded.
  evictUserClients(MAX_USER_CLIENTS - 1);
  const ex = new SomniaMarkets({ ...baseConfig(), privateKey });
  userClients.set(key, { ex, marketsLoadedAt: 0, lastUsed: Date.now() });
  debug(`sdk: user signing client ready for ${address} (${userClients.size} cached)`);
  return ex;
}

/** As above, with the symbol table hydrated — required before `createOrder`. */
export async function getUserExchangeReady(
  privateKey: `0x${string}`,
  address: string,
  forceReload = false,
): Promise<Exchange> {
  const ex = getUserExchange(privateKey, address);
  const entry = userClients.get(address.toLowerCase());
  const loadedAt = entry?.marketsLoadedAt ?? 0;
  if (forceReload || Date.now() - loadedAt > TRADE_MARKETS_TTL_MS) {
    await withRetry('user loadMarkets', () => ex.loadMarkets(true));
    if (entry) entry.marketsLoadedAt = Date.now();
    debug(`sdk: user symbol table hydrated for ${address} (forced=${forceReload})`);
  }
  return ex;
}

/** Close the least recently used clients until at most `keep` remain. */
function evictUserClients(keep: number): void {
  const floor = Math.max(0, keep);
  if (userClients.size <= floor) return;
  const oldestFirst = [...userClients.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [addr, client] of oldestFirst) {
    if (userClients.size <= floor) break;
    userClients.delete(addr);
    void client.ex.close().catch(() => undefined);
    debug(`sdk: evicted idle user client ${addr}`);
  }
}

/** How many per-user clients are cached. Reported by /health so a socket leak is
 *  visible rather than inferred from memory growth. */
export function userClientCount(): number {
  return userClients.size;
}

/** Drop every per-user client. Called on shutdown and by tests. */
export async function closeUserExchanges(): Promise<void> {
  const clients = [...userClients.values()];
  userClients.clear();
  await Promise.all(
    clients.map(async (c) => {
      try {
        await c.ex.close();
      } catch {
        /* already closed / never opened a socket */
      }
    }),
  );
}

/** Indexer reads go over the public internet and DNS here is not always kind:
 *  a single failed lookup surfaces as "indexer RegistryMarkets failed: fetch
 *  failed" and blanks the whole market board. The SDK does not retry, so we do
 *  ??? short exponential backoff, then let the caller decide.                  */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  baseMs = 250,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = /fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up/i.test(
        (err as Error)?.message ?? '',
      );
      if (!transient || i === attempts - 1) break;
      const waitMs = baseMs * 2 ** i;
      debug(`sdk: ${label} attempt ${i + 1} failed (${(err as Error).message}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/** Retry budget for oracle reads. The price feed runs over the shared dev
 *  indexer, whose hiccups regularly outlast the default ~750ms budget ??? and a
 *  cycle with no spot prices is a cycle that cannot trade at all. ~10s of
 *  patience rides out most of them without blocking a cycle meaningfully. */
const FEED_ATTEMPTS = 5;
const FEED_BASE_MS = 600;

/** Short-lived cache over the market registry. Two jobs: keep the UI's polling
 *  off the indexer, and serve the last good snapshot if a read fails outright,
 *  so a blip degrades to slightly-stale data instead of an empty board.      */
const MARKETS_TTL_MS = 15_000;
let marketsCache: { rows: EventMarketRow[]; ts: number } | undefined;

/** Coerce a possibly-string numeric field, dropping anything unusable. */
function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Raw SDK market rows for the active binary (Event Contract) windows.
 *  Kept internal so callers that need `poolAddress` / `marketId` / `expiry`
 *  (the broker, settlement) don't have to re-query and re-filter.            */
export interface EventMarketRow {
  symbol: string;          // YES outcome symbol ??? what fetchOrderBook wants
  marketId: string;
  poolAddress?: string;
  venueId?: string;
  asset: string;           // typed field ??? never regex the question text
  intervalSec?: number;
  expiry?: number;         // unix seconds
  tradingStart?: number;   // unix seconds
  /** Raw integer strike as stored upstream (scaled; 0 means "vs opening price"). */
  strikeRaw?: string;
  /** Raw integer opening price, present only for strike===0 windows. */
  openingRaw?: string;
  quote: string;
  baseDecimals: number;
  quoteDecimals: number;
  yesSymbol: string;
  noSymbol?: string;
}

export async function listEventMarketRows(): Promise<EventMarketRow[]> {
  const fresh = marketsCache && Date.now() - marketsCache.ts < MARKETS_TTL_MS;
  if (fresh && marketsCache) return marketsCache.rows;

  let loaded: Array<Record<string, any>>;
  try {
    const ex = getExchange();
    loaded = await withRetry('loadMarkets', async () =>
      Object.values(await ex.loadMarkets(true)) as Array<Record<string, any>>,
    );
  } catch (err) {
    if (marketsCache) {
      const ageSec = Math.round((Date.now() - marketsCache.ts) / 1000);
      warn(`indexer read failed, serving ${ageSec}s-old snapshot:`, (err as Error).message);
      return marketsCache.rows;
    }
    throw err;
  }

  const rows: EventMarketRow[] = [];

  for (const m of loaded) {
    // `info.kind` does not exist on these rows ??? the discriminator is the typed
    // helper (or `m.type`). Filtering on `info.kind` silently matches nothing.
    if (!m.active || !isBinaryMarket(m.info)) continue;

    // Outcomes live at the TOP level of the market, not under `info`.
    const outcomes = (m.outcomes ?? []) as Array<{ symbol?: string; label?: string; index?: number }>;
    const yes = outcomes.find((o) => o.label === 'YES') ?? outcomes[0];
    const no = outcomes.find((o) => o.label === 'NO') ?? outcomes[1];
    if (!yes?.symbol) continue;

    const info = m.info as Record<string, any>;
    rows.push({
      symbol: yes.symbol,
      yesSymbol: yes.symbol,
      noSymbol: no?.symbol,
      marketId: String(info.marketId ?? ''),
      poolAddress: info.poolAddress ? String(info.poolAddress) : undefined,
      venueId: info.venueId ? String(info.venueId) : undefined,
      asset: String(info.asset ?? m.base ?? ''),
      // The indexer returns intervalSec as a number on some rows and a string on
      // others; a strict typeof check silently dropped half of them.
      intervalSec: numOrUndef(info.intervalSec),
      expiry: info.expiry === undefined || info.expiry === null ? undefined : Number(info.expiry),
      tradingStart:
        info.tradingStart === undefined || info.tradingStart === null
          ? undefined
          : Number(info.tradingStart),
      strikeRaw: info.strike === undefined || info.strike === null ? undefined : String(info.strike),
      quote: String(m.quote ?? info.collateral ?? ''),
      baseDecimals: Number(info.baseDecimals ?? 18),
      quoteDecimals: Number(info.quoteDecimals ?? 6),
    });
  }

  // Scope to one venue when configured: a deployment hosts several venues
  // intermixed in the indexer.
  const venue = config.venueId;
  const scoped = venue ? rows.filter((r) => r.venueId === venue) : rows;

  // Soonest-settling first. Near-expiry windows carry the least variance, so
  // their probabilities are the most decisive and edges appear there first; the
  // MIN_EXPIRY_HEADROOM_SEC filter in horizon.ts keeps them far enough from
  // lock that an order won't land on a closed window.
  const sorted = scoped.sort((a, b) => (a.expiry ?? 0) - (b.expiry ?? 0));

  // Most live windows are "closes at or above its OPENING price" (strike === 0),
  // so the reference level has to be fetched separately or the signal has
  // nothing to compare spot against. One batched call for all of them.
  const needOpening = sorted.filter((r) => r.strikeRaw === '0' || r.strikeRaw === undefined);
  if (needOpening.length > 0) {
    try {
      const ex = getExchange();
      const opens = await withRetry('getOpeningPrices', () =>
        ex.client.getOpeningPrices(needOpening.map((r) => r.marketId)),
      );
      for (const row of needOpening) {
        const v = opens[row.marketId];
        if (v !== null && v !== undefined) row.openingRaw = String(v);
      }
    } catch (err) {
      // Non-fatal: windows without a reference level are simply skipped by the
      // signal rather than traded blind.
      warn('opening-price lookup failed:', (err as Error).message);
    }
  }

  marketsCache = { rows: sorted, ts: Date.now() };
  return sorted;
}

/** Discover live Event Contract (binary Up/Down) markets, in our own shape. */
export async function listEventMarkets(): Promise<NormalizedMarket[]> {
  const rows = await listEventMarketRows();
  return rows.map((r) => ({
    symbol: r.symbol,
    kind: 'event' as const,
    base: r.asset,
    quote: r.quote,
    contract: r.marketId,
    lotSize: '1',
    tickSize: '0.001',
    minQuantity: '1',
    baseDecimals: r.baseDecimals,
    quoteDecimals: r.quoteDecimals,
  }));
}

export const unifyEventMarkets = listEventMarkets;

/** Look up one Event Contract window by its YES symbol. Served from the same
 *  short-lived cache as the market list, so the execution path can resolve the
 *  paired NO symbol without another indexer round-trip.                       */
export async function findEventMarket(yesSymbol: string): Promise<EventMarketRow | undefined> {
  const rows = await listEventMarketRows();
  return rows.find((r) => r.yesSymbol === yesSymbol || r.symbol === yesSymbol);
}

/** Live spot for an asset ("BTC", "ETH") from Somnia's oracle price feed.
 *  Returns undefined when the feed has nothing for that asset.
 *
 *  fetchPrice rides the same chain WebSocket as the book reads, so it needs the
 *  same dead-socket healing: without it a silent WS death empties the signal's
 *  spot map, the agent falls back to consensus, and ??? looking healthy ??? simply
 *  never trades again. */
export async function spotPrice(asset: string): Promise<number | undefined> {
  const source = `spot:${asset.toUpperCase()}`;
  const read = async (): Promise<number | undefined> => {
    const ex = getExchange();
    const p = (await withRetry(`fetchPrice ${asset}`, () => ex.fetchPrice(asset), FEED_ATTEMPTS, FEED_BASE_MS)) as
      | { price?: number; timestamp?: number }
      | null;
    const price = p?.price;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      markFeed(source, true);
      return price;
    }
    // The feed answered but had nothing usable. That is a failed read, not a
    // healthy one — recording it as ok is how a blind agent looks fine.
    markFeed(source, false, 'oracle returned no usable price');
    return undefined;
  };
  try {
    return await read();
  } catch (err) {
    if (!isWebSocketFailure(err)) {
      markFeed(source, false, (err as Error).message);
      throw err;
    }
    debug('spotPrice: websocket dead ??? rebuilding read client');
    resetReadExchange();
    try {
      return await read();
    } catch (retryErr) {
      markFeed(source, false, (retryErr as Error).message);
      throw retryErr;
    }
  }
}

/** Recent 1-minute candles for an asset, oldest first, with timestamps.
 *  OHLCV rows are [tsMs, open, high, low, close, volume]. Timestamps matter for
 *  backtesting: you must not use a candle that closed after the decision time. */
export async function recentCandles(
  asset: string,
  limit = 40,
): Promise<Array<{ ts: number; close: number }>> {
  const source = `candles:${asset.toUpperCase()}`;
  const read = async (): Promise<Array<{ ts: number; close: number }>> => {
    const ex = getExchange();
    const rows = (await withRetry(`fetchPriceOHLCV ${asset}`, () =>
      ex.fetchPriceOHLCV(asset, '1m', undefined, limit),
    FEED_ATTEMPTS, FEED_BASE_MS)) as Array<[number, number, number, number, number, number]>;
    const out = (rows ?? [])
      .map((r) => ({ ts: Number(r[0]), close: Number(r[4]) }))
      .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.close) && c.close > 0)
      .sort((a, b) => a.ts - b.ts);
    if (out.length > 0) markFeed(source, true);
    else markFeed(source, false, 'candle feed returned no usable rows');
    return out;
  };
  try {
    return await read();
  } catch (err) {
    if (!isWebSocketFailure(err)) {
      markFeed(source, false, (err as Error).message);
      throw err;
    }
    debug('recentCandles: websocket dead ??? rebuilding read client');
    resetReadExchange();
    try {
      return await read();
    } catch (retryErr) {
      markFeed(source, false, (retryErr as Error).message);
      throw retryErr;
    }
  }
}

/** Recent 1-minute closes for an asset, oldest first ??? the input to the
 *  volatility estimate. OHLCV rows are [ts, open, high, low, close, volume]. */
export async function recentCloses(asset: string, limit = 40): Promise<number[]> {
  return (await recentCandles(asset, limit)).map((c) => c.close);
}

/** Close any open SDK clients. CLI scripts must call this before exiting: the
 *  SDK opens a chain WebSocket lazily and holds the event loop, and calling
 *  process.exit() while libuv is tearing that socket down aborts the process
 *  natively on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"). */
export async function closeExchanges(): Promise<void> {
  const clients = [readExchange, tradeExchange].filter(Boolean) as Exchange[];
  readExchange = undefined;
  tradeExchange = undefined;
  tradeMarketsLoadedAt = 0;
  await Promise.all([
    ...clients.map(async (c) => {
      try {
        await c.close();
      } catch {
        /* already closed / never opened a socket */
      }
    }),
    // Per-user clients hold a socket each, so they have to go the same way. A
    // script that exits with one still open hangs on Windows exactly as the read
    // client used to.
    closeUserExchanges(),
  ]);
}

/** Graceful shutdown for CLI scripts: close the clients, let libuv finish
 *  tearing the socket down, then exit.
 *
 *  Both halves matter. Calling process.exit() straight away aborts natively on
 *  Windows mid-teardown ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"),
 *  while close() alone doesn't always release the loop, so the script hangs. */
export async function closeAndExit(code = 0): Promise<void> {
  try {
    await closeExchanges();
  } catch {
    /* nothing to close */
  }
  await new Promise((r) => setTimeout(r, 250));
  process.exit(code);
}

/** Is this market still accepting orders, according to CHAIN state?
 *
 *  The indexer trails the chain by seconds, so a window it still lists as active
 *  may already be locked ??? the pool then reverts `TradingNotActive` and the gas
 *  is gone. Status 1 = Trading. Returns true when the check can't be made, so a
 *  transient RPC failure degrades to "attempt the order" rather than halting
 *  trading entirely.                                                          */
export async function isMarketTrading(marketId: string): Promise<boolean> {
  if (!marketId) return true;
  try {
    const ex = getExchange();
    const onchain = (await ex.client.getMarketOnchain(marketId as `0x${string}`)) as {
      status?: number;
    };
    if (typeof onchain?.status !== 'number') return true;
    return onchain.status === 1;
  } catch (err) {
    debug('isMarketTrading check failed, proceeding:', (err as Error).message);
    return true;
  }
}

/** Discard the read client. The SDK's chain WebSocket does not reliably recover
 *  when the remote drops it ??? every later book read fails with
 *  "rpc readContract getBookLevels failed: WebSocket request failed" for the
 *  rest of the process's life, leaving a "running" agent permanently blind.
 *  Dropping the client forces the next call to build a fresh one with a fresh
 *  socket. */
export function resetReadExchange(): void {
  const stale = readExchange;
  readExchange = undefined;
  readClientRebuiltAt = Date.now();
  if (stale) void stale.close().catch(() => undefined);
}

/** True when an error is the dead-chain-socket signature. */
function isWebSocketFailure(err: unknown): boolean {
  return /websocket/i.test((err as Error)?.message ?? '');
}

/** True when the SDK could not resolve a symbol it is being asked about.
 *
 *  The read client keeps its own symbol table, and new Event Contract windows are
 *  minted continuously — so a window discovered in one call can be unknown to the
 *  resolver in the next. `sdk-live.ts` already reloads and retries once on exactly
 *  this error for the WRITE client; the read path had no equivalent, so a stale
 *  table meant every book read threw and the cycle produced no decisions at all.
 *  That is what left the agent reporting "0 decisions, 10 errors" for hours. */
function isStaleSymbolTable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /unknown symbol/i.test(msg) || /missing or invalid parameters/i.test(msg);
}

/** Force the read client's symbol table to rebuild, and drop the market cache with
 *  it so the next discovery call cannot re-serve rows the resolver just rejected. */
async function reloadReadMarkets(): Promise<void> {
  marketsCache = undefined;
  const ex = getExchange();
  await withRetry('read loadMarkets', () => ex.loadMarkets(true));
  debug('sdk: read symbol table rebuilt after an unresolved symbol');
}

/** Top-of-book for a YES symbol (price = Up probability, strictly 0 < p < 1). */
export async function eventBook(symbol: string, depth = 5): Promise<BookTicker> {
  try {
    return await eventBookOnce(symbol, depth);
  } catch (err) {
    // A symbol the resolver does not know is usually a stale table, not a bad
    // market. Rebuild it and try once more before giving up on the window.
    if (isStaleSymbolTable(err)) {
      try {
        await reloadReadMarkets();
        return await eventBookOnce(symbol, depth);
      } catch (retryErr) {
        markFeed('book', false, (retryErr as Error).message);
        throw retryErr;
      }
    }
    if (!isWebSocketFailure(err)) {
      markFeed('book', false, (err as Error).message);
      throw err;
    }
    debug('eventBook: websocket dead ??? rebuilding read client');
    resetReadExchange();
    try {
      return await eventBookOnce(symbol, depth);
    } catch (retryErr) {
      markFeed('book', false, (retryErr as Error).message);
      throw retryErr;
    }
  }
}

async function eventBookOnce(symbol: string, depth: number): Promise<BookTicker> {
  const ex = getExchange();
  const book = (await withRetry(`fetchOrderBook ${symbol}`, () =>
    ex.fetchOrderBook(symbol, depth),
  )) as {
    bids?: Array<[number, number]>;
    asks?: Array<[number, number]>;
  };
  const bids = (book?.bids ?? []).map((b) => [Number(b[0]), Number(b[1])] as [number, number]);
  const asks = (book?.asks ?? []).map((a) => [Number(a[0]), Number(a[1])] as [number, number]);
  const bid = bids[0]?.[0];
  const ask = asks[0]?.[0];
  const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : bid ?? ask;
  markFeed('book', true);
  return {
    symbol,
    ts: Date.now(),
    bid,
    ask,
    mid,
    raw: { bids: bids.slice(0, depth), asks: asks.slice(0, depth) },
  };
}

/** Milliseconds since the last successful feed read, or undefined if none yet. */
export function feedStaleMs(): number | undefined {
  return lastFeedSuccessTs === undefined ? undefined : Date.now() - lastFeedSuccessTs;
}

/** One cheap read whose only job is to refresh feed health.
 *
 *  Exists so the loop can wait out a dead order-book feed instead of stopping: a
 *  scheduler that skips the cycle also skips every book read, so the staleness that
 *  caused the wait could never clear and the agent would sit blocked forever on a
 *  condition it had stopped measuring. One market list plus one book read is the
 *  smallest thing that answers "can we see the market yet". */
export async function probeFeeds(): Promise<{ ok: boolean; error?: string }> {
  try {
    const rows = await listEventMarketRows();
    const first = rows[0];
    if (!first) return { ok: false, error: 'indexer listed no live windows' };
    await eventBook(first.symbol, 1);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

/** Rebuild the read client if the feed has been silent too long. Call from the
 *  agent loop and/or /health so a silently-dead chain socket heals itself
 *  instead of leaving a "running" agent permanently blind. */
export function tickFeedHealth(staleMs = 45_000): void {
  const stale = feedStaleMs();
  if (stale !== undefined && stale > staleMs) {
    warn(`price feed silent ${Math.round(stale / 1000)}s — rebuilding read client`);
    resetReadExchange();
  }
}
