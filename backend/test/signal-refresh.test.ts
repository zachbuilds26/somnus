import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signalRefreshThresholdMs } from '../src/services/agent';

/** A cycle must not reject its own decisions for holding a price it chose not to re-read.
 *
 *  The cycle reads spot and volatility once per asset, then walks a shortlist of windows
 *  and judges each decision against `maxDataAgeMs`. A cycle is not instantaneous: every
 *  order that reaches the chain waits ~10s for confirmation, and before the balance read
 *  was moved out of the loop the first one also cost 14-20s. So the reading the cycle was
 *  judging against went stale mid-flight and later decisions were refused no matter how
 *  much edge they carried — `maxOrdersPerCycle: 5` meant 1, then 2.
 *
 *  Measured on the live venue, same wallet, minutes apart:
 *
 *    before   #1  691ms pass · #2 10984ms pass · #3 22750ms STALE · #4 22912 STALE · #5 23138 STALE
 *    after    #1  608ms pass · #2   841ms pass · #3   710ms pass  — 2 filled, 0 stale
 *
 *  The threshold is the whole mechanism, so it gets the test. Everything else about a
 *  cycle needs the venue. */

describe('signalRefreshThresholdMs: refresh before the gate, not after', () => {
  it('stays strictly below the limit it protects', () => {
    // The property that makes the refresh worth anything. At or above the limit, a cycle
    // would pay to re-read and still reject the decision it re-read for.
    for (const limit of [4_000, 10_000, 15_000, 30_000, 60_000, 300_000]) {
      const t = signalRefreshThresholdMs(limit);
      assert.ok(t < limit, `threshold ${t}ms is not below maxDataAgeMs ${limit}ms`);
    }
  });

  it('leaves real headroom rather than shaving the deadline', () => {
    // Half, so the remaining half covers the book read and the gates after it. A decision
    // priced at 14.9s against a 15s limit passes on luck.
    assert.equal(signalRefreshThresholdMs(15_000), 7_500);
    assert.equal(signalRefreshThresholdMs(30_000), 15_000);
  });

  it('will not refresh so often that every window costs its own feed reads', () => {
    // An operator setting a very tight limit should get a slower agent, not one that
    // re-reads spot before each of a dozen windows.
    assert.equal(signalRefreshThresholdMs(1_000), 2_000);
    assert.equal(signalRefreshThresholdMs(0), 2_000);
    assert.ok(signalRefreshThresholdMs(3_000) >= 2_000);
  });

  it('returns whole milliseconds', () => {
    // Compared against `Date.now()` differences, so a fraction is meaningless noise.
    assert.equal(signalRefreshThresholdMs(15_001), Math.floor(signalRefreshThresholdMs(15_001)));
    assert.ok(Number.isInteger(signalRefreshThresholdMs(7_777)));
  });
});
