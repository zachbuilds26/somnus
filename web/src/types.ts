// Mirrors backend/src/types.ts (kept deliberately in sync by hand — no codegen).

export interface NormalizedMarket {
  symbol: string;
  kind: 'spot' | 'event';
  base: string;
  quote: string;
  contract: string;
  lotSize: string;
  tickSize: string;
  minQuantity: string;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface BookTicker {
  symbol: string;
  ts: number;
  bid?: number;
  ask?: number;
  mid?: number;
  raw?: unknown;
}

export type DecisionAction = 'BUY_YES' | 'BUY_NO' | 'PASS' | 'CLAIM';

export interface Decision {
  id: string;
  ts: number;
  symbol: string;
  fair: number;
  mid: number;
  ask: number;
  bid: number;
  edge: number;
  action: DecisionAction;
  size: number;
  pricedNote?: string;
  reason: string;
  dryRun: boolean;
}

export type OrderSide = 'buy' | 'sell';

export interface OrderLog {
  id: string;
  ts: number;
  decisionId: string;
  symbol: string;
  side: OrderSide;
  price: number;
  size: number;
  timeInForce: 'IOC' | 'GTC' | 'FOK';
  dryRun: boolean;
  txHash?: string;
  status: 'simulated' | 'submitted' | 'rejected';
  reason?: string;
}

export interface AgentConfigDoc {
  symbols: string[];
  maxTradeSize: number;
  maxOpenPositions: number;
  minEdge: number;
  intervalMs: number;
  mode: 'dry-run' | 'live' | 'view';
  claimEnabled: boolean;
}

export interface ProofEntry {
  id: string;
  ts: number;
  prevHash: string;
  payloadHash: string;
  signature?: string;
  kind: 'decision' | 'order' | 'claim' | 'config';
  payload: Record<string, unknown>;
}

export interface HealthResponse {
  ok: true;
  name: string;
  network: string;
  chainId: number;
  rpcUrl: string;
  dryRun: boolean;
  agentMode: string;
  indexer: 'ok' | 'down' | 'idle';
  proofAnchor: string;
  proofEntries: number;
  ts: number;
}

export interface RunResult {
  ok: boolean;
  dryRun: boolean;
  decisions: Decision[];
  orders: OrderLog[];
  books: BookTicker[];
  errors: string[];
  anchor: string;
  ts: number;
}
