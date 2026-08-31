import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { consumeTradeQuota, loadAgentConfig, saveAgentConfig } from '../src/agent-config';

/** These run against the temp DATA_DIR set by test/env.ts, so they exercise the
 *  real persisted document without touching production state. */
describe('trade quota: countdown and exhaustion', () => {
  beforeEach(() => {
    const doc = loadAgentConfig();
    saveAgentConfig({ ...doc, tradeQuota: 3, mode: 'dry-run' });
  });

  it('counts down by one per trade', () => {
    assert.equal(loadAgentConfig().tradeQuota, 3);
    assert.equal(consumeTradeQuota(), 2);
    assert.equal(consumeTradeQuota(), 1);
    assert.equal(consumeTradeQuota(), 0);
  });

  it('persists the countdown, so a restart cannot hand trades back', () => {
    consumeTradeQuota();
    // loadAgentConfig re-reads from disk, which is what a fresh process does.
    assert.equal(loadAgentConfig().tradeQuota, 2);
  });

  it('floors at zero and never goes negative', () => {
    consumeTradeQuota();
    consumeTradeQuota();
    consumeTradeQuota();
    assert.equal(consumeTradeQuota(), 0);
    assert.equal(consumeTradeQuota(), 0);
    assert.equal(loadAgentConfig().tradeQuota, 0);
  });

  it('exactly N calls leave exactly zero — "do 3 trades" means 3', () => {
    saveAgentConfig({ ...loadAgentConfig(), tradeQuota: 3 });
    let spent = 0;
    while ((loadAgentConfig().tradeQuota ?? 0) > 0) {
      consumeTradeQuota();
      spent++;
      assert.ok(spent <= 10, 'quota failed to terminate');
    }
    assert.equal(spent, 3, `expected exactly 3 trades, got ${spent}`);
  });

  it('does nothing when unlimited', () => {
    saveAgentConfig({ ...loadAgentConfig(), tradeQuota: null });
    assert.equal(consumeTradeQuota(), null);
    assert.equal(loadAgentConfig().tradeQuota, null);
  });

  it('a quota of 0 blocks immediately', () => {
    saveAgentConfig({ ...loadAgentConfig(), tradeQuota: 0 });
    const q = loadAgentConfig().tradeQuota;
    assert.equal(q, 0);
    // The broker's gate is `tradeQuota !== null && tradeQuota <= 0` -> reject.
    assert.ok(q !== null && q <= 0, 'a zero quota must be a blocking condition');
  });
});
