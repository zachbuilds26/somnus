import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFill, tradeBudget } from '../src/services/broker';
import { openNotional, recordFill, recordSettlement } from '../src/services/pnl';

/** REGRESSION (2026-08-30). Both suites below pin bugs found in the real ledger,
 *  not hypotheticals. The evidence is in each case's comment so a later reader can
 *  tell a deliberate rule from an accident. */

describe('broker.resolveFill: cost basis comes from the venue, not from us', () => {
  // The order that exposed it: 1976 contracts requested at 0.506, 990 filled,
  // remainder canceled. Recorded as 1976 x 0.506 = $999.86 against a position
  // that paid out $990 — so a ~$489 winner was booked as a $10 loser.
  it('bills a partial fill for what filled, not for what was requested', () => {
    const r = resolveFill(
      { filled: 990, placedPrice: 0.506, status: 'canceled' },
      { size: 1976, price: 0.506 },
    );
    assert.equal(r.filled, 990);
    assert.equal(r.cost, 500.94);
    // The bug: charging the requested size.
    assert.notEqual(r.cost, 999.856);
  });

  it('bills a full fill for the whole request', () => {
    const r = resolveFill(
      { filled: 20, placedPrice: 0.25, status: 'closed' },
      { size: 20, price: 0.25 },
    );
    assert.equal(r.filled, 20);
    assert.equal(r.cost, 5);
  });

  // A zero-fill IOC normally reverts `ImmediateOrCancelNoFill` and never reaches
  // here. If one ever does, writing a cost basis invents a loss the wallet never
  // took, so there must be no ledger row at all.
  it('reports no cost for an order that filled nothing', () => {
    const r = resolveFill({ filled: 0, placedPrice: 0.4, status: 'canceled' }, { size: 50, price: 0.4 });
    assert.equal(r.filled, 0);
    assert.equal(r.cost, undefined);
  });

  // An unknown fill quantity is exactly the case where we cannot show a position
  // exists. Assuming the full request here is how the original bug generalises.
  it('treats an unreported fill quantity as unknown, not as filled', () => {
    const r = resolveFill({ placedPrice: 0.4, status: 'canceled' }, { size: 50, price: 0.4 });
    assert.equal(r.filled, undefined);
    assert.equal(r.cost, undefined);
  });

  // `status: 'closed'` is set by the SDK precisely when remaining <= 0, so it is
  // the one signal that licenses assuming the whole request traded.
  it('infers a full fill from status closed when the quantity is missing', () => {
    const r = resolveFill({ placedPrice: 0.5, status: 'closed' }, { size: 10, price: 0.5 });
    assert.equal(r.filled, 10);
    assert.equal(r.cost, 5);
  });

  // createOrder snaps a buy's limit DOWN onto the tick grid, so the price paid can
  // be better than the one we sent. Billing our own number overstates the cost.
  it('prices at the snapped limit the venue actually placed', () => {
    const r = resolveFill(
      { filled: 10, placedPrice: 0.498, status: 'closed' },
      { size: 10, price: 0.5 },
    );
    assert.equal(r.paidPrice, 0.498);
    assert.equal(r.cost, 4.98);
  });

  it('falls back to the requested price when the venue reports an impossible one', () => {
    for (const bad of [0, 1, 1.5, -0.2]) {
      const r = resolveFill({ filled: 10, placedPrice: bad, status: 'closed' }, { size: 10, price: 0.5 });
      assert.equal(r.paidPrice, 0.5, `placedPrice ${bad} should not be trusted`);
    }
  });
});

describe('broker.tradeBudget: open exposure bounds a batch', () => {
  // The gap this closes: maxDailyLoss bounds REALISED loss, and a binary only
  // realises at settlement. Four ~$1000 orders went out between 18:41 and 18:46
  // and settled together at 19:17, so a $1000 daily-loss limit had nothing to read
  // until all four had resolved — $4000 at risk under a $1000 limit.
  it('lets the per-trade cap bind while exposure is low', () => {
    assert.equal(tradeBudget(25, 1000, 0), 25);
    assert.equal(tradeBudget(25, 1000, 900), 25);
  });

  it('sizes down to what is left of the ceiling', () => {
    assert.equal(tradeBudget(25, 1000, 990), 10);
  });

  it('reaches zero once the ceiling is met, so no new risk is added', () => {
    assert.equal(tradeBudget(25, 1000, 1000), 0);
    assert.equal(tradeBudget(25, 1000, 1200), 0);
  });

  it('would have stopped the 2026-08-30 batch after the first order', () => {
    // maxTradeSize was 1000 and maxOpenNotional defaults to maxDailyLoss (1000).
    assert.equal(tradeBudget(1000, 1000, 0), 1000); // first order: allowed
    assert.equal(tradeBudget(1000, 1000, 1000), 0); // second: refused
  });

  it('collapses to the per-trade cap when the ceiling is switched off', () => {
    assert.equal(tradeBudget(25, 0, 5000), 25);
  });

  it('never returns a negative budget', () => {
    assert.ok(tradeBudget(25, 10, 999) >= 0);
    assert.ok(tradeBudget(-5, 1000, 0) >= 0);
  });
});

describe('pnl.openNotional: what is still at risk', () => {
  // Runs against the temp DATA_DIR set by test/env.ts, so it never touches the
  // real ledger. Market ids are unique per case because the ledger is append-only
  // and shared across cases in this file.
  it('counts a fill until its settlement lands, then stops', () => {
    const before = openNotional();
    recordFill('0xopen1', 0, 10, 4);
    assert.equal(openNotional(), before + 4);
    recordSettlement('0xopen1', 0, 0, false);
    assert.equal(openNotional(), before);
  });

  it('sums several open positions', () => {
    const before = openNotional();
    recordFill('0xopen2', 0, 10, 5);
    recordFill('0xopen3', 1, 10, 7.5);
    assert.equal(openNotional(), before + 12.5);
    recordSettlement('0xopen2', 0, 10, true);
    assert.equal(openNotional(), before + 7.5);
    recordSettlement('0xopen3', 1, 0, false);
    assert.equal(openNotional(), before);
  });

  it('adds repeat fills on one window together', () => {
    const before = openNotional();
    recordFill('0xopen4', 0, 5, 2);
    recordFill('0xopen4', 0, 5, 3);
    assert.equal(openNotional(), before + 5);
    recordSettlement('0xopen4', 0, 0, false);
    assert.equal(openNotional(), before);
  });

  it('never goes negative', () => {
    assert.ok(openNotional() >= 0);
  });
});
