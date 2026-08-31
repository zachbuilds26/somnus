import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateFair,
  horizonVolatility,
  normalCdf,
  referenceLevel,
  volatilityPerMinute,
  type SignalContext,
} from '../src/services/signal';
import type { EventMarketRow } from '../src/services/sdk';

const row = (over: Partial<EventMarketRow> = {}): EventMarketRow => ({
  symbol: 'BTC-1/tUSDC#YES',
  yesSymbol: 'BTC-1/tUSDC#YES',
  noSymbol: 'BTC-1/tUSDC#NO',
  marketId: '0x01',
  asset: 'BTC',
  quote: 'tUSDC',
  baseDecimals: 6,
  quoteDecimals: 6,
  ...over,
});

describe('signal.normalCdf', () => {
  it('is 0.5 at zero', () => assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6));
  it('matches known quantiles', () => {
    assert.ok(Math.abs(normalCdf(1.281552) - 0.9) < 1e-4);
    assert.ok(Math.abs(normalCdf(1.644854) - 0.95) < 1e-4);
    assert.ok(Math.abs(normalCdf(-1.959964) - 0.025) < 1e-4);
  });
  it('is monotonic and bounded', () => {
    let prev = 0;
    for (let z = -5; z <= 5; z += 0.25) {
      const p = normalCdf(z);
      assert.ok(p >= prev - 1e-12, `not monotonic at ${z}`);
      assert.ok(p >= 0 && p <= 1);
      prev = p;
    }
  });
});

describe('signal.volatility', () => {
  it('returns undefined without enough samples', () => {
    assert.equal(volatilityPerMinute([100, 101]), undefined);
    assert.equal(horizonVolatility([100, 101, 102], 5), undefined);
  });

  it('is zero-ish/undefined for a flat series', () => {
    const flat = Array.from({ length: 40 }, () => 100);
    assert.equal(volatilityPerMinute(flat), undefined); // sd 0 -> undefined
  });

  it('grows with dispersion', () => {
    const calm = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 0.01 : -0.01));
    const wild = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1.5 : -1.5));
    const a = volatilityPerMinute(calm)!;
    const b = volatilityPerMinute(wild)!;
    assert.ok(b > a, `expected wild ${b} > calm ${a}`);
  });

  // This test previously asserted the OPPOSITE — that the direct k-step estimate
  // should come in below the sqrt-scaled one on a mean-reverting series. That
  // encoded a real bug: backtesting 200 settled windows showed the direct
  // estimate is far too LOW at long horizons, the model claimed 3% for events
  // that happened ~50% of the time, and 28 of 29 live trades lost. Too-high vol
  // costs opportunities; too-low vol costs money. So the estimator is now
  // deliberately CONSERVATIVE.
  it('never reports less volatility than sqrt-scaling implies', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    const mean = 100;
    let x = mean;
    const series: number[] = [];
    for (let i = 0; i < 400; i++) {
      x = mean + 0.25 * (x - mean) + rand() * 2;
      series.push(x);
    }
    const perMin = volatilityPerMinute(series)!;
    for (const horizon of [5, 30, 60, 120]) {
      const h = horizonVolatility(series, horizon)!;
      const scaled = perMin * Math.sqrt(horizon);
      assert.ok(
        h.sigma >= scaled - 1e-12,
        `at ${horizon}m: sigma ${h.sigma} fell below sqrt-scaled ${scaled} — that is the bug that lost money`,
      );
    }
  });

  it('still grows with the horizon', () => {
    const series = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 7) * 2 + i * 0.001);
    const a = horizonVolatility(series, 5)!.sigma;
    const b = horizonVolatility(series, 60)!.sigma;
    assert.ok(b > a, `60m vol ${b} should exceed 5m vol ${a}`);
  });

  it('labels the estimator it actually used', () => {
    const series = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3));
    assert.match(horizonVolatility(series, 10)!.method, /10m direct/);
    // Horizon far beyond the history must fall back and say so.
    assert.match(horizonVolatility(series, 5000)!.method, /scaled to/);
  });
});

describe('signal.referenceLevel', () => {
  it('scales an integer strike to spot magnitude', () => {
    // 7873985 with spot ~78700 means the stored value is x100.
    assert.ok(Math.abs(referenceLevel(row({ strikeRaw: '7873985' }), 78700)! - 78739.85) < 0.01);
  });

  it('handles ETH scale independently', () => {
    assert.ok(Math.abs(referenceLevel(row({ asset: 'ETH', strikeRaw: '246960' }), 2469)! - 2469.6) < 0.01);
  });

  it('uses the opening price when strike is 0', () => {
    const r = row({ strikeRaw: '0', openingRaw: '7887036' });
    assert.ok(Math.abs(referenceLevel(r, 78700)! - 78870.36) < 0.01);
  });

  // Guards against silently trading a 100x-wrong level if upstream rescales.
  it('refuses a level implausibly far from spot', () => {
    assert.equal(referenceLevel(row({ strikeRaw: '1' }), 78700), undefined);
  });

  it('returns undefined with no strike and no opening price', () => {
    assert.equal(referenceLevel(row({ strikeRaw: '0' }), 78700), undefined);
  });
});

describe('signal.estimateFair', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 78000 + Math.sin(i / 5) * 60);
  const ctx = (): SignalContext => ({
    spot: new Map([['BTC', 78000]]),
    closes: new Map([['BTC', closes]]),
  });
  const nowSec = 1_800_000_000;
  const nowMs = nowSec * 1000;

  it('is high when spot is far above the reference', () => {
    const r = row({ strikeRaw: '7700000', expiry: nowSec + 600 }); // 77000
    const est = estimateFair(r, ctx(), nowMs)!;
    assert.ok(est.fair > 0.9, `expected confident YES, got ${est.fair}`);
  });

  it('is low when spot is far below the reference', () => {
    const r = row({ strikeRaw: '7900000', expiry: nowSec + 600 }); // 79000
    const est = estimateFair(r, ctx(), nowMs)!;
    assert.ok(est.fair < 0.1, `expected confident NO, got ${est.fair}`);
  });

  it('is near 0.5 at the money', () => {
    const r = row({ strikeRaw: '7800000', expiry: nowSec + 600 });
    const est = estimateFair(r, ctx(), nowMs)!;
    assert.ok(Math.abs(est.fair - 0.5) < 0.15, `expected ~0.5, got ${est.fair}`);
  });

  it('never returns 0 or 1 — the pool rejects those', () => {
    const r = row({ strikeRaw: '7000000', expiry: nowSec + 10 });
    const est = estimateFair(r, ctx(), nowMs)!;
    assert.ok(est.fair > 0 && est.fair < 1, `got ${est.fair}`);
  });

  it('declines to estimate an expired window', () => {
    const r = row({ strikeRaw: '7800000', expiry: nowSec - 1 });
    assert.equal(estimateFair(r, ctx(), nowMs), undefined);
  });

  it('declines without spot or candles', () => {
    const r = row({ strikeRaw: '7800000', expiry: nowSec + 600 });
    assert.equal(estimateFair(r, { spot: new Map(), closes: new Map() }, nowMs), undefined);
  });

  it('reports the horizon sigma, not a per-minute figure', () => {
    const r = row({ strikeRaw: '7800000', expiry: nowSec + 3600 });
    const est = estimateFair(r, ctx(), nowMs)!;
    assert.ok(est.sigmaHorizon > 0);
    assert.match(est.note, /sigma .* \[/);
  });
});
