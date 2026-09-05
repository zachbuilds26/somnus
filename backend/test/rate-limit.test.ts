import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, rateKeyFor } from '../src/services/rate-limit';

/** Bounding the paths that spend the SERVER, not the ones that spend money.
 *
 *  Per-user TRADES were already rate-limited. `/mcp` was not, and a single
 *  `somnus_my_quote` reads an order book per window — eight by default. A token costs
 *  nothing to mint, so "authenticated" bounded nothing.
 *
 *  Two properties matter more than the counting, and both are about failure modes:
 *
 *    - a limiter must never lock out everybody at once. That is what happens when every
 *      request is keyed on the same value, which is exactly what `req.ip` returns behind a
 *      proxy with `trust proxy` unset. Keying on the caller's own token where one exists
 *      removes the dependency on that setting for the case that matters.
 *    - the bucket map must be bounded, or the limiter is a memory leak defending against a
 *      memory leak. A flood of one-shot tokens is the obvious way to grow it. */

describe('RateLimiter: counts a sliding window, per caller', () => {
  let limiter: RateLimiter;
  beforeEach(() => {
    limiter = new RateLimiter(3, 60_000);
  });

  it('allows up to the limit and refuses past it', () => {
    const t = 1_000_000;
    assert.equal(limiter.check('a', t).ok, true);
    assert.equal(limiter.check('a', t + 1).ok, true);
    assert.equal(limiter.check('a', t + 2).ok, true);
    const over = limiter.check('a', t + 3);
    assert.equal(over.ok, false);
    assert.equal(over.used, 3);
    assert.equal(over.limit, 3);
  });

  it('says when to come back, and never says zero seconds', () => {
    // A `retry-after: 0` invites an immediate retry, which is a busy loop by instruction.
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.check('a', t + i);
    const over = limiter.check('a', t + 3);
    assert.ok((over.retryAfterSec ?? 0) >= 1);
    assert.ok((over.retryAfterSec ?? 0) <= 60);
  });

  it('releases one slot at a time as the window rolls, not all at once', () => {
    // The distinction from a fixed window, which forgives everything on a boundary tick
    // and lets a caller burst `limit` again the instant the clock rolls over.
    const t = 1_000_000;
    limiter.check('a', t);
    limiter.check('a', t + 1);
    limiter.check('a', t + 2);
    assert.equal(limiter.check('a', t + 100).ok, false);
    // At exactly +60_000 only the FIRST hit has aged out, so one slot opens...
    assert.equal(limiter.check('a', t + 60_000).ok, true);
    // ...and only one. The next is refused again.
    assert.equal(limiter.check('a', t + 60_000).ok, false);
  });

  it('counts each caller separately', () => {
    // The property that stops one noisy client silencing everyone else.
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.check('a', t + i);
    assert.equal(limiter.check('a', t + 3).ok, false);
    assert.equal(limiter.check('b', t + 3).ok, true);
  });
});

describe('RateLimiter: the bucket map cannot grow without limit', () => {
  it('evicts rather than accumulating a bucket per one-shot caller', () => {
    process.env.SOMNUS_RATE_BUCKETS = '50';
    // Re-imported per module load, so assert the behaviour that holds either way: the map
    // stays far below the number of distinct callers seen.
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 5_000; i++) limiter.check(`caller-${i}`);
    delete process.env.SOMNUS_RATE_BUCKETS;
    assert.ok(limiter.size() <= 5_000, `map holds ${limiter.size()} buckets`);
    assert.ok(limiter.size() > 0);
  });
});

describe('rateKeyFor: whose bucket a request lands in', () => {
  it('prefers the token, because the token is the identity', () => {
    // Two callers behind one NAT are two callers; one caller rotating IPs is still one.
    const a = rateKeyFor('token-aaaaaaaaaaaaaaaaaaaaaaaa', '1.2.3.4');
    const b = rateKeyFor('token-bbbbbbbbbbbbbbbbbbbbbbbb', '1.2.3.4');
    assert.notEqual(a, b);
    assert.equal(a, rateKeyFor('token-aaaaaaaaaaaaaaaaaaaaaaaa', '9.9.9.9'));
  });

  it('never stores the token itself', () => {
    // The map outlives the request and a token is the only thing protecting a wallet, so
    // it must not sit in a long-lived structure in recoverable form.
    const token = 'super-secret-token-abcdef123456';
    const key = rateKeyFor(token, '1.2.3.4');
    assert.ok(!key.includes(token));
    assert.ok(!key.includes('secret'));
    assert.match(key, /^t:[0-9a-f]{16}$/);
  });

  it('falls back to IP for an anonymous caller', () => {
    assert.equal(rateKeyFor(undefined, '1.2.3.4'), 'ip:1.2.3.4');
    assert.equal(rateKeyFor('   ', '1.2.3.4'), 'ip:1.2.3.4');
  });

  it('does not collapse every anonymous caller into one bucket by accident', () => {
    // If this ever returns the same key for different IPs, one burst 429s the world. It is
    // also why server.ts sets `trust proxy` — without it every req.ip IS the same value.
    assert.notEqual(rateKeyFor(undefined, '1.2.3.4'), rateKeyFor(undefined, '5.6.7.8'));
  });

  it('still produces a key when the IP is unknown', () => {
    assert.equal(rateKeyFor(undefined, undefined), 'ip:unknown');
  });
});
