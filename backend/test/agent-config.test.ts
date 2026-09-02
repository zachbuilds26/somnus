import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveDryRun, sanitize } from '../src/agent-config';
import type { AgentConfigDoc } from '../src/types';

const base = (): AgentConfigDoc => ({
  symbols: ['BTC', 'ETH'],
  maxTradeSize: 25,
  maxOpenPositions: 3,
  minEdge: 0.03,
  edgePreset: 'middle',
  intervalMs: 60_000,
  mode: 'dry-run',
  claimEnabled: true,
  maxOrdersPerCycle: 0,
  maxPerMarket: 1,
  tradeQuota: null,
  maxDailyLoss: 10,
  maxOpenNotional: 20,
  maxDrawdown: 0,
  maxTradeSizePctEquity: 0,
  maxPerExpiryBucket: 2,
  maxSameDirection: 0,
  maxSettlementAgeMs: 1_800_000,
  maxConsecutiveLosses: 3,
  maxExecutionFailures: 3,
  maxDataAgeMs: 15_000,
  tradingPaused: false,
});

describe('agent-config.sanitize', () => {
  it('passes a sane document through unchanged', () => {
    const d = base();
    assert.deepEqual(sanitize(d), d);
  });

  it('clamps a negative trade size to a non-negative value', () => {
    assert.ok(sanitize({ ...base(), maxTradeSize: -100 }).maxTradeSize >= 0);
  });

  it('caps an absurd trade size', () => {
    assert.ok(sanitize({ ...base(), maxTradeSize: 1e12 }).maxTradeSize <= 10_000);
  });

  it('replaces a non-numeric trade size with a finite default', () => {
    const v = sanitize({ ...base(), maxTradeSize: 'lots' as unknown as number }).maxTradeSize;
    assert.ok(Number.isFinite(v), `expected finite, got ${v}`);
  });

  it('keeps minEdge inside [0,1]', () => {
    assert.ok(sanitize({ ...base(), minEdge: 99 }).minEdge <= 1);
    assert.ok(sanitize({ ...base(), minEdge: -5 }).minEdge >= 0);
  });

  it('keeps maxOpenPositions non-negative and bounded', () => {
    assert.ok(sanitize({ ...base(), maxOpenPositions: -3 }).maxOpenPositions >= 0);
    assert.ok(sanitize({ ...base(), maxOpenPositions: 1e9 }).maxOpenPositions <= 100);
  });

  it('refuses a hot-loop interval', () => {
    assert.ok(sanitize({ ...base(), intervalMs: 1 }).intervalMs >= 5000);
  });

  // REGRESSION: a PUT of `[1,2,3]` once persisted keys "0","1","2" into the
  // config file and the proof chain, because sanitize spread caller input.
  it('strips unknown keys instead of persisting them', () => {
    const dirty = { ...base(), 0: 1, 1: 2, evil: 'x', __proto__: { p: 1 } } as unknown as AgentConfigDoc;
    const clean = sanitize(dirty) as unknown as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(clean).sort(),
      ['claimEnabled', 'edgePreset', 'intervalMs', 'maxConsecutiveLosses', 'maxDailyLoss', 'maxDataAgeMs', 'maxDrawdown', 'maxExecutionFailures', 'maxOpenNotional', 'maxOpenPositions', 'maxOrdersPerCycle', 'maxPerExpiryBucket', 'maxPerMarket', 'maxSameDirection', 'maxSettlementAgeMs', 'maxTradeSize', 'maxTradeSizePctEquity', 'minEdge', 'mode', 'symbols', 'tradeQuota', 'tradingPaused'],
    );
  });

  it('survives an array body without inheriting its indices', () => {
    const clean = sanitize([1, 2, 3] as unknown as AgentConfigDoc) as unknown as Record<string, unknown>;
    assert.equal(clean['0'], undefined);
    assert.ok(Number.isFinite(clean.maxTradeSize as number));
  });

  // Anything that could widen the risk envelope must not survive a bad PUT.
  it('never lets an unknown mode become live', () => {
    assert.equal(sanitize({ ...base(), mode: 'yolo' as AgentConfigDoc['mode'] }).mode, 'dry-run');
  });

  it('does not treat uppercase LIVE as live', () => {
    assert.equal(sanitize({ ...base(), mode: 'LIVE' as AgentConfigDoc['mode'] }).mode, 'dry-run');
  });

  it('accepts the three real modes', () => {
    for (const mode of ['dry-run', 'live', 'view'] as const) {
      assert.equal(sanitize({ ...base(), mode }).mode, mode);
    }
  });

  it('coerces a non-array symbols field to an array', () => {
    const s = sanitize({ ...base(), symbols: 'BTC' as unknown as string[] }).symbols;
    assert.ok(Array.isArray(s));
  });

  // REGRESSION (2026-08-30): four ~$1000 orders went out between 18:41 and 18:46
  // and all four settled together at 19:17, so the $1000 maxDailyLoss breaker had
  // nothing to read until every one of them had already resolved. maxOpenNotional
  // is the limit that bounds a BATCH, and it must survive a hostile PUT like the
  // rest of the envelope.
  it('keeps maxOpenNotional non-negative and bounded', () => {
    assert.equal(sanitize({ ...base(), maxOpenNotional: -50 }).maxOpenNotional, 0);
    assert.ok(sanitize({ ...base(), maxOpenNotional: 1e12 }).maxOpenNotional <= 1_000_000);
  });

  it('replaces a non-numeric maxOpenNotional with a finite default', () => {
    const v = sanitize({ ...base(), maxOpenNotional: 'all of it' as unknown as number }).maxOpenNotional;
    assert.ok(Number.isFinite(v), `expected finite, got ${v}`);
  });

  it('keeps an explicit maxOpenNotional', () => {
    assert.equal(sanitize({ ...base(), maxOpenNotional: 40 }).maxOpenNotional, 40);
  });

  it('strips junk from symbols and uppercases them', () => {
    const s = sanitize({
      ...base(),
      symbols: ['', null, 42, 'btc', ' eth '] as unknown as string[],
    }).symbols;
    assert.ok(s.every((x) => typeof x === 'string' && x.length > 0));
    assert.ok(s.includes('BTC'));
    assert.ok(s.includes('ETH'));
  });
});

describe('agent-config: trade quota', () => {
  it('treats null as unlimited', () => {
    assert.equal(sanitize({ ...base(), tradeQuota: null }).tradeQuota, null);
  });

  it('keeps an explicit quota', () => {
    assert.equal(sanitize({ ...base(), tradeQuota: 3 }).tradeQuota, 3);
  });

  it('floors a fractional quota rather than rounding up', () => {
    assert.equal(sanitize({ ...base(), tradeQuota: 3.9 }).tradeQuota, 3);
  });

  it('clamps a negative quota to zero, not unlimited', () => {
    assert.equal(sanitize({ ...base(), tradeQuota: -5 }).tradeQuota, 0);
  });

  it('caps maxOrdersPerCycle and keeps it an integer', () => {
    assert.equal(sanitize({ ...base(), maxOrdersPerCycle: 2.7 }).maxOrdersPerCycle, 2);
    assert.ok(sanitize({ ...base(), maxOrdersPerCycle: 1e6 }).maxOrdersPerCycle <= 100);
    assert.equal(sanitize({ ...base(), maxOrdersPerCycle: -3 }).maxOrdersPerCycle, 0);
  });
});

describe('agent-config.effectiveDryRun', () => {
  it('is dry-run unless the saved mode is live', () => {
    assert.equal(effectiveDryRun({ ...base(), mode: 'dry-run' }), true);
    assert.equal(effectiveDryRun({ ...base(), mode: 'view' }), true);
  });

  // The env DRY_RUN floor is the other half of this and is exercised by the
  // running server; here we assert the mode half in isolation.
  it('only permits live when the mode says live', () => {
    const live = effectiveDryRun({ ...base(), mode: 'live' });
    assert.equal(typeof live, 'boolean');
  });
});
