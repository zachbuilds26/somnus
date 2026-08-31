import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { crossingPrice } from '../src/services/broker';

test('never pays through its own fair value', () => {
  // Whatever the edge, the price must stay strictly below fair — crossing past
  // fair converts a positive-edge trade into a negative one.
  for (const [quoted, fair] of [
    [0.285, 0.371],
    [0.582, 0.636],
    [0.02, 0.99],
    [0.5, 0.503],
  ] as const) {
    const p = crossingPrice(quoted, fair);
    assert.ok(p !== undefined, `expected a price for quoted=${quoted} fair=${fair}`);
    assert.ok(p < fair, `price ${p} must be below fair ${fair}`);
    assert.ok(p >= quoted, `price ${p} must be at or above the touch ${quoted}`);
  }
});

test('spends half the edge on the cross, not a fixed penny', () => {
  // The exact case that reverted on-chain: BTC YES, touch 0.285, fair 0.371.
  // A fixed 1pp cross put the order at 0.295 and the ladder moved past it. Half
  // the 8.6pp edge crosses ~4pp and still keeps ~4pp of expected profit.
  const p = crossingPrice(0.285, 0.371);
  assert.ok(p !== undefined);
  assert.ok(p > 0.32, `expected a deeper cross than the old fixed 1pp, got ${p}`);
  assert.ok(p < 0.371);
});

test('still crosses at least a penny when the edge is razor thin', () => {
  // Edge of 2pp: half of it is under the 1pp floor, so the floor applies.
  const p = crossingPrice(0.5, 0.52);
  assert.ok(p !== undefined);
  assert.ok(p >= 0.51 - 1e-9, `expected at least the 1pp floor, got ${p}`);
  assert.ok(p < 0.52);
});

test('refuses to cross when the touch is already at or above fair', () => {
  assert.equal(crossingPrice(0.6, 0.6), undefined);
  assert.equal(crossingPrice(0.7, 0.6), undefined);
});

test('never returns a price outside (0,1)', () => {
  const high = crossingPrice(0.995, 0.999);
  if (high !== undefined) assert.ok(high < 1, `got ${high}`);
  assert.equal(crossingPrice(0.999, 0.9995), undefined, 'no usable room this close to 1');
});
