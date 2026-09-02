import { config } from '../config';
import { fetchWithTimeout } from '../http';
import type { NormalizedMarket } from '../types';

/** The REST indexer is a third party and /health probes it on a 10s cache, so an
 *  unbounded read here would turn their outage into our hung liveness check. */
const REST_TIMEOUT_MS = Number(process.env.REST_TIMEOUT_MS ?? 10_000);

interface RawSpotMarket {
  base: string;
  baseDecimals: number;
  contract: string;
  kind?: string;
  lotSize: string;
  minQuantity: string;
  quote: string;
  quoteDecimals: number;
  symbol: string;
  tickSize: string;
}

/** GET {restUrl}/markets — the spot market registry (live-verified on testnet).
 *  Spot only: the HTTP API has no event-contract endpoints, so Event Contract
 *  windows come from the SDK (`sdk.ts`) instead.                              */
export async function fetchSpotMarkets(): Promise<NormalizedMarket[]> {
  const url = `${config.restUrl}/markets`;
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, REST_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`indexer ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { markets?: RawSpotMarket[] };
  const rows = body.markets ?? [];
  return rows.map((r) => ({
    symbol: r.symbol,
    kind: 'spot' as const,
    base: r.base,
    quote: r.quote,
    contract: r.contract,
    lotSize: r.lotSize,
    tickSize: r.tickSize,
    minQuantity: r.minQuantity,
    baseDecimals: r.baseDecimals,
    quoteDecimals: r.quoteDecimals,
  }));
}

export { unifyEventMarkets } from './sdk';