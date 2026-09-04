import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Network = 'testnet' | 'mainnet';
export type AgentMode = 'dry-run' | 'live' | 'view';

/** Two different back ends, easy to conflate — keep them apart:
 *  - `restUrl`     DreamDEX HTTP API. Spot + perp only; it has NO event-contract
 *                  endpoints (docs: /developers/event-contracts).
 *  - `indexerUrl`  Envio/Hasura **GraphQL** endpoint the markets-SDK reads for
 *                  Event Contract discovery. Passing the REST base here makes
 *                  every SDK call fail with "indexer RegistryMarkets failed".
 *  - `wsRpcUrl`    Somnia chain WebSocket for the SDK's live tail (NOT the
 *                  DreamDEX public WS, which serves the REST product).        */
const NETWORKS: Record<
  Network,
  { chainId: number; rpcUrl: string; restUrl: string; indexerUrl: string; wsRpcUrl: string }
> = {
  testnet: {
    chainId: 50312,
    rpcUrl: 'https://dream-rpc.somnia.network',
    restUrl: 'https://stg.api.dreamdex.io/v0',
    indexerUrl: 'https://dev.smk.somnia.host/v1/graphql',
    wsRpcUrl: 'wss://api.infra.testnet.somnia.network/ws',
  },
  mainnet: {
    chainId: 5031,
    rpcUrl: 'https://api.infra.mainnet.somnia.network',
    restUrl: 'https://api.dreamdex.io/v0',
    indexerUrl: 'https://prd.smk.somnia.host/v1/graphql',
    wsRpcUrl: 'wss://api.infra.mainnet.somnia.network/ws',
  },
};

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export interface SomnusConfig {
  network: Network;
  chainId: number;
  rpcUrl: string;
  restUrl: string;
  indexerUrl: string;
  wsRpcUrl: string;
  venueId: string | undefined;
  port: number;
  apiKey: string | undefined;
  dryRun: boolean;
  privateKey: string | undefined;
  operatorKey: string | undefined;
  tradeKey: string | undefined;
  logLevel: string;
  agent: {
    intervalMs: number;
    minEdge: number;
    maxTradeSize: number;
    maxOpenPositions: number;
    symbols: string[];
    mode: AgentMode;
  };
}

function readConfig(): SomnusConfig {
  const network = (process.env.NETWORK ?? 'testnet').toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
  const net = NETWORKS[network];

  const rawMode = (process.env.AGENT_MODE ?? 'dry-run').toLowerCase();
  const mode: AgentMode = rawMode === 'live' || rawMode === 'view' ? rawMode : 'dry-run';

  return {
    network,
    chainId: net.chainId,
    rpcUrl: net.rpcUrl,
    restUrl: process.env.REST_URL || net.restUrl,
    indexerUrl: process.env.INDEXER_URL || net.indexerUrl,
    wsRpcUrl: process.env.WS_RPC_URL || net.wsRpcUrl,
    venueId: process.env.VENUE_ID || undefined,
    port: Number(process.env.PORT ?? 4545),
    apiKey: process.env.SOMNUS_API_KEY || undefined,
    dryRun: bool('DRY_RUN', true) || mode === 'dry-run',
    privateKey: process.env.PRIVATE_KEY || undefined,
    operatorKey: process.env.OPERATOR_KEY || undefined,
    tradeKey: process.env.TRADE_KEY || undefined,
    logLevel: process.env.LOG_LEVEL || 'info',
    agent: {
      intervalMs: Number(process.env.AGENT_INTERVAL_MS ?? 60000),
      minEdge: Number(process.env.AGENT_MIN_EDGE ?? 0.03),
      maxTradeSize: Number(process.env.AGENT_MAX_TRADE_SIZE ?? 50),
      maxOpenPositions: Number(process.env.AGENT_MAX_OPEN_POSITIONS ?? 10),
      symbols: (process.env.AGENT_SYMBOLS ?? 'BTC,ETH')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      mode,
    },
  };
}

export const config: SomnusConfig = readConfig();

/** Stable location for the backend's runtime data (proof log, agent config)
 *  regardless of the process working directory. Resolves to backend/data.
 *
 *  Overridable via DATA_DIR so tests never touch the real audit chain — a test
 *  run that appends to production history is both a corrupted demo and a
 *  corrupted test. `npm test` sets it to a temp dir. */
export const DATA_DIR =
  process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function log(...args: unknown[]): void {
  const level = config.logLevel;
  if (level === 'silent') return;
  const line = args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
  if (level === 'debug' || level === 'info') console.log(`[somnus] ${new Date().toISOString()} ${line}`);
}

export function debug(...args: unknown[]): void {
  if (config.logLevel === 'debug') log('[debug]', ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(`[somnus:warn] ${new Date().toISOString()} ${args.join(' ')}`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** The ONE answer to "which key does this process act with".
 *
 *  There used to be two. `sdk.ts` signed orders with `TRADE_KEY ?? PRIVATE_KEY ??
 *  OPERATOR_KEY`, while the proof signer and the on-chain anchor both preferred
 *  `PRIVATE_KEY` first — so an operator who set both (which .env.example actively
 *  suggests, as "session-key mode") would have had the audit chain signed by one
 *  wallet and the trades placed by another. `somnus_proof_verify` would still pass,
 *  because it checks signatures against whichever signer it resolved, so nothing
 *  would ever have reported the split.
 *
 *  TRADE_KEY wins because it is the wallet that holds the money and places the
 *  orders: an audit trail signed by anything else is signed by a bystander.     */
export function activeKey(): `0x${string}` | undefined {
  const key = config.tradeKey ?? config.privateKey ?? config.operatorKey;
  if (!key) return undefined;
  return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
}

/** Stamped onto every live fill and order log.
 *
 *  Performance analysis is only meaningful if you can tell WHICH agent produced a
 *  trade. Without a version on the record, a threshold change and a model change
 *  pool into one indistinguishable sample and the next study measures a mixture
 *  rather than either one. Bump these deliberately when the behaviour changes. */
export const MODEL_VERSION = process.env.SOMNUS_MODEL_VERSION || 'gbm-horizon-vol-1';
export const STRATEGY_VERSION = process.env.SOMNUS_STRATEGY_VERSION || 'edge-gates-1';