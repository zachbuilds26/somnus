import { warn } from './config';

/** Outbound HTTP with a deadline.
 *
 *  Node's global `fetch` has NO default timeout. A connection that is accepted and
 *  then black-holed — a hung RPC node, a captive portal, a firewall that drops
 *  instead of rejecting — leaves the promise pending forever. Nothing here retries
 *  its way out of that, because there is no error to retry.
 *
 *  That was live in four places, and the worst one was the boot preflight: the
 *  clock check gated `maybeAutostart()`, so a hung request meant the process
 *  started, served health checks, reported itself fine, and silently never began
 *  trading. No error, no log line, no clue.
 *
 *  Timeouts are per-call rather than global because the right deadline differs: an
 *  eth_call is sub-second when healthy, an indexer page can legitimately take
 *  seconds. Every caller states its own.                                        */

export const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS ?? 10_000);

export class HttpTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`request to ${hostOf(url)} exceeded ${ms}ms`);
    this.name = 'HttpTimeoutError';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // An abort surfaces as a bare `AbortError`, which tells a caller nothing about
    // what timed out or for how long. Translate it into something a log line can
    // be read from.
    if ((err as Error)?.name === 'AbortError') throw new HttpTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** One JSON-RPC call, with a deadline. Throws on transport failure, timeout, or an
 *  `error` member in the response — a caller that wants to degrade rather than fail
 *  catches it, which is what every caller here does. */
export async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const res = await fetchWithTimeout(
    rpcUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? 'unknown error'}`);
  return body.result as T;
}

/** Log a timeout distinctly from a refusal. "Connection refused" means the endpoint
 *  is down and you should look at it; a timeout often means DNS or a middlebox, and
 *  conflating the two sends people to the wrong place. */
export function describeNetworkError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (err instanceof HttpTimeoutError) return `${msg} (timed out — DNS, proxy or a dropped connection)`;
  return msg;
}

export function warnNetwork(label: string, err: unknown): void {
  warn(`${label}: ${describeNetworkError(err)}`);
}
