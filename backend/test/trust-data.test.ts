import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, parseBoolStrict, parseDryRun } from '../src/config';
import { clockMeasured, clockState } from '../src/services/clock';
import {
  __resetLedgerCacheForTests,
  ledgerWriteFailure,
  pnlSummary,
  recordFill,
  recordSettlement,
  verifyLedgerAgainstChain,
} from '../src/services/pnl';
import { clampStake, maxUserStake, userRateCheck, userTradesPerHour } from '../src/services/user-trading';

// REGRESSION: trust/data/scripts honesty pass.
// Each block pins one fail-closed or additive-reporting behavior so a silent
// revert reintroduces a failing test instead of a silent lie:
//  - DRY_RUN parsing must fail CLOSED (a typo must not arm live trading);
//  - per-user limit envs must accept 0 (feature off) and fall back loudly on garbage;
//  - the clock must start unknown (ok:false), not healthy;
//  - the P&L summary must not double-count a duplicated settle row;
//  - the ledger/chain cross-check must stay additive (new buckets, same verdict).

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (had) process.env[name] = prev as string;
    else delete process.env[name];
  }
}

describe('config.parseDryRun: only explicit false/0 disable dry-run', () => {
  it('defaults to true when unset or empty', () => {
    assert.equal(parseDryRun(undefined), true);
    assert.equal(parseDryRun(''), true);
  });

  it('honours explicit true/1', () => {
    assert.equal(parseDryRun('true'), true);
    assert.equal(parseDryRun('TRUE'), true);
    assert.equal(parseDryRun('1'), true);
  });

  it('honours explicit false/0 only', () => {
    assert.equal(parseDryRun('false'), false);
    assert.equal(parseDryRun('FALSE'), false);
    assert.equal(parseDryRun('0'), false);
    assert.equal(parseDryRun('  false  '), false);
  });

  it('fails closed on anything unrecognized (a typo must not arm live trading)', () => {
    for (const raw of ['flase', 'no', 'off', '2', 'yes please']) {
      assert.equal(parseDryRun(raw), true, `DRY_RUN=${JSON.stringify(raw)} should fail closed to true`);
    }
  });
});

describe('config.parseBoolStrict: general strict parse', () => {
  it('parses the four explicit spellings and falls back otherwise', () => {
    assert.equal(parseBoolStrict('true', false), true);
    assert.equal(parseBoolStrict('1', false), true);
    assert.equal(parseBoolStrict('false', true), false);
    assert.equal(parseBoolStrict('0', true), false);
    assert.equal(parseBoolStrict(undefined, true), true);
    assert.equal(parseBoolStrict('', false), false);
    assert.equal(parseBoolStrict('anything-else', true), true);
    assert.equal(parseBoolStrict('anything-else', false), false);
  });
});

describe('user-trading limits: 0 is off, garbage falls back', () => {
  it('accepts 0 as a valid cap (feature off)', () => {
    withEnv('SOMNUS_USER_MAX_TRADE', '0', () => assert.equal(maxUserStake(), 0));
    withEnv('SOMNUS_USER_TRADES_PER_HOUR', '0', () => assert.equal(userTradesPerHour(), 0));
  });

  it('falls back to defaults on non-numeric or negative values', () => {
    withEnv('SOMNUS_USER_MAX_TRADE', 'not-a-number', () => assert.equal(maxUserStake(), 1000));
    withEnv('SOMNUS_USER_MAX_TRADE', '-5', () => assert.equal(maxUserStake(), 1000));
    withEnv('SOMNUS_USER_TRADES_PER_HOUR', 'lots', () => assert.equal(userTradesPerHour(), 20));
    withEnv('SOMNUS_USER_TRADES_PER_HOUR', '-1', () => assert.equal(userTradesPerHour(), 20));
  });

  it('a 0/hr rate blocks every send', () => {
    withEnv('SOMNUS_USER_TRADES_PER_HOUR', '0', () => {
      const r = userRateCheck('trust-data-probe-handle');
      assert.equal(r.ok, false);
      assert.equal(r.limit, 0);
    });
  });

  it('a 0 cap sizes every trade to nothing and reports the clamp', () => {
    const c = clampStake(10, 0);
    assert.equal(c.stake, 0);
    assert.equal(c.clamped, true);
  });
});

describe('clock: unknown until measured, never healthy-by-default', () => {
  it('starts ok:false with no measurement', () => {
    // Nothing in this file measures the clock (no network), so the module
    // initial state is what is asserted: unknown, not healthy.
    assert.equal(clockState().ok, false);
    assert.equal(clockMeasured(), false);
  });
});

describe('pnl: ledger write health and duplicate-settle dedup', () => {
  it('reports no write failure on a healthy disk', () => {
    assert.equal(ledgerWriteFailure(), undefined);
  });

  it('does not double-count a duplicated settle row', () => {
    __resetLedgerCacheForTests();
    recordFill('TRUST-DATA-M1', 0, 2, 1.0);
    recordSettlement('TRUST-DATA-M1', 0, 2, true);
    // The ledger is plain JSONL: a retried append or a hand edit can duplicate
    // a settle row, and recordSettlement's idempotence cannot stop bytes that
    // are already in the file. The summary must still count one trade.
    appendFileSync(
      join(DATA_DIR, 'pnl-ledger.jsonl'),
      `${JSON.stringify({ t: 'settle', marketId: 'TRUST-DATA-M1', outcomeIdx: 0, payout: 2, won: true, ts: Date.now() })}\n`,
      'utf8',
    );
    __resetLedgerCacheForTests();
    const s = pnlSummary();
    assert.equal(s.closedTrades, 1);
    assert.equal(s.wins, 1);
    assert.equal(s.settledPayout, 2);
  });

  it('keeps the cross-check additive: new buckets, same verdict inputs', () => {
    __resetLedgerCacheForTests();
    const v = verifyLedgerAgainstChain();
    assert.ok(Array.isArray(v.costMismatches));
    // Empty chain in the test data dir: the fixture fill is uncorroborated, and
    // the cost bucket must not itself move the verdict either way.
    assert.equal(v.ok, v.uncorroborated.length === 0 && v.missingFromLedger.length === 0);
  });
});
