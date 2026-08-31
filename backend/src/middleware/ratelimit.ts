import type { Request, Response, NextFunction } from 'express';

interface Hit {
  count: number;
  reset: number;
}

export interface RateLimitOpts {
  /** Window length in ms. */
  windowMs?: number;
  /** Max requests per window. */
  max?: number;
  /** How to bucket a request (default: client IP). Per-user keys are stronger. */
  key?: (req: Request) => string;
  message?: string;
}

/** Minimal fixed-window in-memory rate limiter. No dependency, good enough to
 *  blunt brute-force / abuse on a demo backend. Swap for redis-backed in prod. */
export function rateLimit(opts: RateLimitOpts = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 20;
  const keyOf = opts.key ?? ((r: Request) => r.ip ?? 'unknown');
  const hits = new Map<string, Hit>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const k = keyOf(req);
    const now = Date.now();
    const rec = hits.get(k);
    if (!rec || now > rec.reset) {
      hits.set(k, { count: 1, reset: now + windowMs });
      next();
      return;
    }
    if (rec.count >= max) {
      res.status(429).json({ ok: false, error: opts.message ?? 'rate limited — slow down' });
      return;
    }
    rec.count++;
    next();
  };
}
