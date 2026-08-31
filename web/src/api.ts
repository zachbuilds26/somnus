import type {
  AgentConfigDoc,
  BookTicker,
  HealthResponse,
  NormalizedMarket,
  ProofEntry,
  RunResult,
} from './types';

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const err = (body?.error as string | undefined) ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return body as T;
}

export const getHealth = () => request<HealthResponse>('/health');

export const getMarkets = () => request<{ ok: boolean; markets: NormalizedMarket[] }>('/markets');

export const getBinaryMarkets = () =>
  request<{ ok: boolean; markets: NormalizedMarket[] }>('/markets/binary');

export const getBook = (symbol: string) =>
  request<{ ok: boolean; book: BookTicker }>(`/markets/${encodeURIComponent(symbol)}/book`);

export const getAgentConfig = () =>
  request<{ ok: boolean; config: AgentConfigDoc; effectiveDryRun: boolean; mode: string }>('/agent/config');

export const putAgentConfig = (cfg: Partial<AgentConfigDoc>) =>
  request<{ ok: boolean; config: AgentConfigDoc }>('/agent/config', {
    method: 'PUT',
    body: JSON.stringify(cfg),
  });

export const runAgent = () => request<RunResult>('/agent/run', { method: 'POST' });

export const getProof = (limit = 25) =>
  request<{ ok: boolean; anchor: string; total: number; entries: ProofEntry[] }>(
    `/proof?limit=${limit}`,
  );

export const verifyProof = () =>
  request<{ ok: boolean; anchor: string; checked: number; total: number }>('/proof/verify', {
    method: 'POST',
    body: '{}',
  });
