import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideFromFair, momentumBreak } from '../src/services/pricing';
import type { BookTicker } from '../src/types';

const book = (bid?: number, ask?: number): BookTicker => ({
  symbol: 'X',
  ts: 0,
  bid,
  ask,
  mid: bid !== undefined && ask !== undefined ? (bid + ask) / 2 : (bid ?? ask),
});

describe('pricing.decideFromFair', () => {
  it('passes when fair sits inside the book', () => {
    const r = decideFromFair(0.5, book(0.48, 0.52), { minEdge: 0.03, maxSize: 25 });
    assert.equal(r.action, 'PASS');
    assert.equal(r.size, 0);
  });

  it('buys Up when fair clears the ask by more than minEdge', () => {
    const r = decideFromFair(0.7, book(0.4, 0.5), { minEdge: 0.03, maxSize: 25 });
    assert.equal(r.action, 'BUY_YES');
    assert.ok(r.edge > 0.03);
  });

  it('buys Down when fair is below the bid by more than minEdge', () => {
    const r = decideFromFair(0.3, book(0.6, 0.7), { minEdge: 0.03, maxSize: 25 });
    assert.equal(r.action, 'BUY_NO');
    assert.ok(r.edge > 0.03);
  });

  it('respects minEdge exactly at the boundary', () => {
    // fair == ask + minEdge should trade; a hair under should not.
    assert.equal(decideFromFair(0.53, book(0.4, 0.5), { minEdge: 0.03, maxSize: 25 }).action, 'BUY_YES');
    assert.equal(decideFromFair(0.5299, book(0.4, 0.5), { minEdge: 0.03, maxSize: 25 }).action, 'PASS');
  });

  // REGRESSION: sizing and the broker's notional gate must agree on the cost
  // basis. Sizing a Down leg off `fair` while the gate charged `bid` rejected
  // every single Down order on a phantom notional.
  it('sizes an Up leg so notional never exceeds the budget', () => {
    const r = decideFromFair(0.9, book(0.1, 0.2), { minEdge: 0.03, maxSize: 25 });
    assert.equal(r.action, 'BUY_YES');
    assert.ok(r.ask * r.size <= 25 + 1e-9, `notional ${r.ask * r.size} exceeded 25`);
  });

  it('sizes a Down leg on (1 - bid), the real cash outlay', () => {
    const r = decideFromFair(0.1, book(0.9, 0.95), { minEdge: 0.03, maxSize: 25 });
    assert.equal(r.action, 'BUY_NO');
    const cost = (1 - r.bid) * r.size;
    assert.ok(cost <= 25 + 1e-9, `Down notional ${cost} exceeded 25`);
    // And it should be a meaningful size, not 1 contract.
    assert.ok(r.size > 10, `expected a real size, got ${r.size}`);
  });

  it('never trades on a one-sided book with no ask', () => {
    const r = decideFromFair(0.99, book(0.5, undefined), { minEdge: 0.03, maxSize: 25 });
    assert.notEqual(r.action, 'BUY_YES');
  });

  it('never trades when bid is zero', () => {
    const r = decideFromFair(0.01, book(0, 0.9), { minEdge: 0.03, maxSize: 25 });
    assert.notEqual(r.action, 'BUY_NO');
  });

  it('produces size 0 when the budget cannot buy one contract', () => {
    const r = decideFromFair(0.9, book(0.1, 0.8), { minEdge: 0.03, maxSize: 0.5 });
    assert.equal(r.size, 0);
  });

  // REGRESSION (2026-08-25 training pass): cheap YES tails underperformed
  // systematically in live trading — 0/4 settled vs ~1.2 expected wins, while
  // NO legs and high-probability YES ran at/above market odds. Crash risk is
  // priced above a lognormal, so a driftless-GBM model sees phantom bargains
  // below ~0.35. The band demands extra edge rather than banning the trade.
  it('demands extra edge for YES legs inside the cheap-tail band', () => {
    // ask 0.30 < floor: base minEdge 0.03 would trade fair 0.335; x1.5 needs 0.045.
    assert.equal(decideFromFair(0.335, book(0.28, 0.3), { minEdge: 0.03, maxSize: 25 }).action, 'PASS');
    const r = decideFromFair(0.36, book(0.28, 0.3), { minEdge: 0.03, maxSize: 25 });
    assert.equal(r.action, 'BUY_YES');
    assert.match(r.pricedNote, /tail surcharge/);
  });

  it('does not apply the tail surcharge above the floor', () => {
    // ask 0.50 sits outside the band: plain minEdge still trades at the boundary.
    assert.equal(decideFromFair(0.53, book(0.4, 0.5), { minEdge: 0.03, maxSize: 25 }).action, 'BUY_YES');
  });
});

// REGRESSION (2026-08-26): a 5m book collapsed 33c -> 8c against our side while
// the GBM model — blind to order flow — kept rating it a bargain; we bought
// into the falling knife and lost. Hard moves AGAINST an intended side are now
// treated as market information, not as free money.
describe('pricing.momentumBreak', () => {
  const opts = { moveThreshold: 0.08 };

  it('breaks a BUY_YES into a collapsing book', () => {
    assert.equal(momentumBreak(0.33, 0.2, 'BUY_YES', opts), true);
  });

  it('breaks a BUY_NO into a surging book', () => {
    assert.equal(momentumBreak(0.6, 0.72, 'BUY_NO', opts), true);
  });

  it('allows small adverse moves and favorable moves', () => {
    assert.equal(momentumBreak(0.33, 0.3, 'BUY_YES', opts), false); // 3pp drop < 8pp bar
    assert.equal(momentumBreak(0.33, 0.4, 'BUY_YES', opts), false); // rising = fine for YES
    assert.equal(momentumBreak(0.6, 0.55, 'BUY_NO', opts), false); // falling = fine for NO
  });

  it('never breaks without history', () => {
    assert.equal(momentumBreak(undefined, 0.01, 'BUY_YES', opts), false);
  });
});
