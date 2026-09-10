import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetUserMidHistory,
  sortCandidatesByExpiry,
  userMomentumBlocked,
} from '../src/services/user-trading';

// REGRESSION (2026-09-06): the per-user quote path kept no book history, so it
// offered the same "bargain" on every re-quote into a collapsing book while the
// operator's own cycle — which tracks mids per window in agent.ts — refused it.
// A caller asking "what would you trade for me" into a stampede bought the
// falling knife the agent itself would not touch. priceWindow now records each
// book read and applies the same momentum breaker.
//
// Second fix in the same pass: tradeableWindows documented "soonest-settling
// first" but took the first 8 rows in indexer order, so a capped scan could
// price thin far-out windows while missing the ones nearest resolution.

const SYM = 'BTC-0-05SEP26-9999/tUSDC#YES';

describe('user-trading.userMomentumBlocked', () => {
  it('never blocks on the first sighting of a window', () => {
    resetUserMidHistory();
    const r = userMomentumBlocked('alice', SYM, 0.2, 'BUY_YES', 1_000);
    assert.equal(r.blocked, false);
  });

  it('blocks a YES buy after the book collapses against it', () => {
    resetUserMidHistory();
    userMomentumBlocked('alice', SYM, 0.33, 'BUY_YES', 1_000);
    const r = userMomentumBlocked('alice', SYM, 0.2, 'BUY_YES', 2_000);
    assert.equal(r.blocked, true);
    assert.ok(r.movedPp < -8);
  });

  it('lets a YES buy through when the book drifts with it', () => {
    resetUserMidHistory();
    userMomentumBlocked('alice', SYM, 0.33, 'BUY_YES', 1_000);
    const r = userMomentumBlocked('alice', SYM, 0.4, 'BUY_YES', 2_000);
    assert.equal(r.blocked, false);
  });

  it('blocks a NO buy after the book rallies against it', () => {
    resetUserMidHistory();
    userMomentumBlocked('alice', SYM, 0.6, 'BUY_NO', 1_000);
    const r = userMomentumBlocked('alice', SYM, 0.72, 'BUY_NO', 2_000);
    assert.equal(r.blocked, true);
  });

  it('ignores small moves below the breaker bar', () => {
    resetUserMidHistory();
    userMomentumBlocked('alice', SYM, 0.33, 'BUY_YES', 1_000);
    const r = userMomentumBlocked('alice', SYM, 0.3, 'BUY_YES', 2_000);
    assert.equal(r.blocked, false);
  });

  it('forgets readings older than the window', () => {
    resetUserMidHistory();
    userMomentumBlocked('alice', SYM, 0.33, 'BUY_YES', 1_000);
    // 600s default window has fully elapsed: the old 0.33 must not count.
    const r = userMomentumBlocked('alice', SYM, 0.2, 'BUY_YES', 1_000 + 601_000);
    assert.equal(r.blocked, false);
  });

  // REGRESSION: history was keyed by window alone, so one caller's quotes drove
  // another caller's safety breaker — denying them windows, or diluting the
  // anchor their own stampede check compares against.
  it("keeps callers apart — one wallet's reads never trip another's breaker", () => {
    resetUserMidHistory();
    userMomentumBlocked('alice', SYM, 0.33, 'BUY_YES', 1_000);
    userMomentumBlocked('alice', SYM, 0.2, 'BUY_YES', 2_000);
    const r = userMomentumBlocked('bob', SYM, 0.2, 'BUY_YES', 2_000);
    assert.equal(r.blocked, false);
  });

  it('ignores non-finite mids instead of poisoning history', () => {
    resetUserMidHistory();
    userMomentumBlocked('alice', SYM, NaN, 'BUY_YES', 1_000);
    userMomentumBlocked('alice', SYM, 0.33, 'BUY_YES', 2_000);
    const r = userMomentumBlocked('alice', SYM, 0.2, 'BUY_YES', 3_000);
    assert.equal(r.blocked, true);
  });
});

describe('user-trading.sortCandidatesByExpiry', () => {
  const cand = (expiry?: number) => ({ market: { expiry } });

  it('orders soonest-settling first', () => {
    const out = sortCandidatesByExpiry([cand(300), cand(100), cand(200)]);
    assert.deepEqual(
      out.map((c) => c.market.expiry),
      [100, 200, 300],
    );
  });

  it('sorts windows with no expiry last', () => {
    const out = sortCandidatesByExpiry([cand(undefined), cand(100)]);
    assert.deepEqual(
      out.map((c) => c.market.expiry),
      [100, undefined],
    );
  });
});
