import { createHash } from 'node:crypto';

/** A sliding-window rate limiter, in process, with no dependency.
 *
 *  Somnus already had one of these for per-user TRADES (`userRateCheck`), which bounds the
 *  path that spends money. This bounds the paths that spend the SERVER: `/mcp` accepts any
 *  tool call, and `somnus_my_quote` alone reads an order book per window — eight by
 *  default. Nothing metered how often that could be asked, and a token costs nothing to
 *  mint, so "authenticated" was not a limit on anything.
 *
 *  Deliberately NOT applied to `/health`, `/metrics` or the market reads. Those exist to
 *  be polled — `/metrics` is a Prometheus scrape target — and rate-limiting them would
 *  break their intended use to defend against something cheap. The asymmetric case (a tiny
 *  request costing 78 seconds of CPU on `/proof/verify`) was fixed by bounding the work
 *  itself, which is a better fix than counting requests.
 *
 *  Generous on purpose. The failure this must never cause is a 429 in front of somebody
 *  legitimately trying the service; that is a worse outcome than the load it prevents. */

export interface RateVerdict {
  ok: boolean;
  used: number;
  limit: number;
  /** Seconds until the oldest hit leaves the window. Only set when `ok` is false. */
  retryAfterSec?: number;
}

/** Buckets tracked at once. Bounded because a Map keyed on caller identity is otherwise a
 *  memory leak with a friendly name — a flood of one-shot tokens would grow it without
 *  limit. Oldest evicted first, which at worst forgives a limit rather than enforcing a
 *  phantom one. */
const MAX_BUCKETS = Number(process.env.SOMNUS_RATE_BUCKETS ?? 5_000);

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record a hit and say whether it is allowed. */
  check(key: string, now = Date.now()): RateVerdict {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      this.hits.set(key, recent);
      return {
        ok: false,
        used: recent.length,
        limit: this.limit,
        retryAfterSec: Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000)),
      };
    }
    recent.push(now);
    // Evict before inserting a NEW key, so the cap is on distinct callers rather than on
    // callers who happen to arrive after it is reached.
    if (!this.hits.has(key) && this.hits.size >= MAX_BUCKETS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    this.hits.set(key, recent);
    return { ok: true, used: recent.length, limit: this.limit };
  }

  /** Live bucket count, for /health and for tests. */
  size(): number {
    return this.hits.size;
  }

  /** For tests. */
  reset(): void {
    this.hits.clear();
  }
}

/** Who to count against, for an MCP request.
 *
 *  Prefers the caller's own token over their IP, because the token IS the identity here —
 *  two people behind one NAT are two callers, and one caller rotating IPs is still one
 *  caller. Hashed rather than stored raw: the map outlives the request, and a token is the
 *  only thing protecting a wallet, so it should not sit in a long-lived structure in
 *  recoverable form.
 *
 *  Falls back to IP for anonymous callers. That fallback is only meaningful if Express is
 *  told to trust the proxy — otherwise every request on a hosted deployment reports the
 *  proxy's address and one shared bucket rate-limits the entire world at once. See
 *  `trust proxy` in server.ts. */
export function rateKeyFor(token: string | undefined, ip: string | undefined): string {
  if (typeof token === 'string' && token.trim().length > 0) {
    return `t:${createHash('sha256').update(token.trim()).digest('hex').slice(0, 16)}`;
  }
  return `ip:${ip ?? 'unknown'}`;
}
