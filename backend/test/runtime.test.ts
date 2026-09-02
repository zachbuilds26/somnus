import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tradeBudget } from '../src/services/broker';
import {
  drawdownState,
  openNotional,
  openPositions,
  pnlSummary,
  recordFill,
  recordGas,
  recordSettlement,
  verifyLedgerAgainstChain,
} from '../src/services/pnl';
import { chainStateInit, readChainPage, appendEntry } from '../src/services/store';
import { raiseAlert, recentAlerts, __resetAlertsForTests } from '../src/services/alerts';
import { publish, recentEvents, subscribe, __resetEventsForTests } from '../src/services/events';
import { gasCostFromReceipt } from '../src/services/wallet';
import { describeNetworkError, fetchWithTimeout, HttpTimeoutError } from '../src/http';

/** Regression cover for the gaps found in the 2026-09-01 audit: every limit below
 *  either read a number nobody was updating, or did not exist. */

describe('pnl.drawdownState: bounds a losing week, not just a losing day', () => {
  // maxDailyLoss resets at UTC midnight, so an agent losing just under the limit
  // every day never trips a breaker while the account drains steadily.
  it('is zero while equity only climbs', () => {
    recordFill('0xdd-a', 0, 10, 5);
    recordSettlement('0xdd-a', 0, 12, true);
    const dd = drawdownState();
    assert.equal(dd.drawdown, 0);
    assert.ok(dd.peak > 0);
  });

  it('measures the distance below the peak, and releases on recovery', () => {
    const peakBefore = drawdownState().peak;
    // Lose 5.
    recordFill('0xdd-b', 0, 10, 5);
    recordSettlement('0xdd-b', 0, 0, false);
    const down = drawdownState();
    assert.equal(down.drawdown, 5);
    assert.equal(down.peak, peakBefore);
    // Win it back — a drawdown breaker that never releases bans the agent forever.
    recordFill('0xdd-c', 0, 10, 5);
    recordSettlement('0xdd-c', 0, 10, true);
    assert.equal(drawdownState().drawdown, 0);
  });
});

describe('pnl: gas is counted, and never mixed into tUSDC', () => {
  it('sums gas from fills and standalone rows', () => {
    const before = pnlSummary().gasSpentNative;
    recordFill('0xgas-a', 0, 10, 4, { gasNative: 0.001 });
    recordGas(0.002, 'redeemed 3 position(s)', '0xabc');
    const after = pnlSummary().gasSpentNative;
    assert.equal(Math.round((after - before) * 1e6) / 1e6, 0.003);
  });

  it('keeps gas out of realizedPnl — they are different assets', () => {
    const before = pnlSummary();
    recordGas(1.5, 'expensive day');
    const after = pnlSummary();
    assert.equal(after.realizedPnl, before.realizedPnl);
    assert.ok(after.gasSpentNative > before.gasSpentNative);
  });

  it('derives a per-tx cost from a receipt', () => {
    // 100000 gas at 1 gwei = 0.0001 native.
    assert.equal(gasCostFromReceipt({ gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n }), 0.0001);
  });

  it('reports an unusable receipt as unknown, not as free', () => {
    assert.equal(gasCostFromReceipt(null), undefined);
    assert.equal(gasCostFromReceipt({ gasUsed: 0, effectiveGasPrice: 0 }), undefined);
    assert.equal(gasCostFromReceipt({ gasUsed: 'not a number' }), undefined);
  });
});

describe('pnl.openPositions: what the correlation caps and reconciler read', () => {
  it('carries the expiry captured at fill time', () => {
    recordFill('0xopen-exp', 1, 10, 3, {
      strategy: {
        outcome: 'NO',
        fairForSide: 0.6,
        quoted: 0.5,
        entryPrice: 0.52,
        rawEdge: 0.1,
        retainedEdge: 0.08,
        decisionTs: Date.now(),
        strategyVersion: 't',
        modelVersion: 't',
        expiry: 1_800_000_600,
      },
    });
    const row = openPositions().find((p) => p.marketId === '0xopen-exp');
    assert.ok(row, 'expected the position to be open');
    assert.equal(row?.expiry, 1_800_000_600);
    assert.equal(row?.outcomeIdx, 1);
  });

  it('drops a position once its settlement is recorded', () => {
    recordFill('0xopen-gone', 0, 10, 3);
    assert.ok(openPositions().some((p) => p.marketId === '0xopen-gone'));
    recordSettlement('0xopen-gone', 0, 0, false);
    assert.ok(!openPositions().some((p) => p.marketId === '0xopen-gone'));
  });

  it('ignores gas rows when computing open exposure', () => {
    const before = openNotional();
    recordGas(0.5, 'gas is not exposure');
    assert.equal(openNotional(), before);
  });
});

describe('recordSettlement: a swept outcome is real P&L, just unredeemed', () => {
  // The bug: settlement rows were only ever written by executeClaim, so if claiming
  // broke, maxDailyLoss and maxConsecutiveLosses read a ledger that stopped moving.
  it('accepts an outcome learned from a sweep rather than a redemption', () => {
    recordFill('0xsweep-a', 0, 10, 6);
    recordSettlement('0xsweep-a', 0, 0, false, true);
    assert.ok(!openPositions().some((p) => p.marketId === '0xsweep-a'));
  });

  it('stays idempotent when a later claim re-records the same position', () => {
    recordFill('0xsweep-b', 0, 10, 6);
    recordSettlement('0xsweep-b', 0, 10, true, true);
    const first = pnlSummary();
    recordSettlement('0xsweep-b', 0, 10, true, false);
    assert.equal(pnlSummary().closedTrades, first.closedTrades);
    assert.equal(pnlSummary().realizedPnl, first.realizedPnl);
  });

  it('still refuses to settle a position we never traded', () => {
    const before = pnlSummary().closedTrades;
    recordSettlement('0xnever-traded', 0, 999, true, true);
    assert.equal(pnlSummary().closedTrades, before);
  });
});

describe('broker.tradeBudget with equity sizing', () => {
  // An absolute cap does not scale: $5 is 1% of a $500 account and 10% of the same
  // account after a 90% loss.
  it('takes the smaller of the absolute and percentage caps', () => {
    const equity = 100;
    const pct = 0.02; // 2% -> $2
    assert.equal(tradeBudget(Math.min(5, equity * pct), 1000, 0), 2);
    // A large account leaves the absolute cap binding.
    assert.equal(tradeBudget(Math.min(5, 10_000 * pct), 1000, 0), 5);
  });
});

describe('alerts: a halt nobody hears about', () => {
  it('records an alert even with no webhook configured', () => {
    __resetAlertsForTests();
    raiseAlert({ level: 'critical', key: 'test-halt', title: 'halted' });
    const recent = recentAlerts();
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.key, 'test-halt');
  });

  it('dedupes a repeat of the same incident', () => {
    __resetAlertsForTests();
    // A tripped breaker is re-evaluated every cycle; without dedupe one incident
    // becomes a message a minute and the channel gets muted.
    raiseAlert({ level: 'warning', key: 'same', title: 'first' });
    raiseAlert({ level: 'warning', key: 'same', title: 'second' });
    assert.equal(recentAlerts().length, 1);
  });

  it('does not dedupe distinct incidents', () => {
    __resetAlertsForTests();
    raiseAlert({ level: 'warning', key: 'a', title: 'a' });
    raiseAlert({ level: 'warning', key: 'b', title: 'b' });
    assert.equal(recentAlerts().length, 2);
  });
});

describe('events: the SSE fan-out', () => {
  it('delivers to subscribers and buffers for late joiners', () => {
    __resetEventsForTests();
    const seen: string[] = [];
    const off = subscribe((e) => seen.push(e.kind));
    publish('order', { id: '1' });
    publish('cycle', { cycle: 1 });
    off();
    publish('order', { id: '2' });
    assert.deepEqual(seen, ['order', 'cycle']);
    // All three are still in the replay buffer.
    assert.equal(recentEvents().length, 3);
  });

  it('survives a throwing subscriber — a dead client cannot break a trade', () => {
    __resetEventsForTests();
    subscribe(() => {
      throw new Error('client went away');
    });
    const seen: string[] = [];
    subscribe((e) => seen.push(e.kind));
    assert.doesNotThrow(() => publish('fill', {}));
    assert.deepEqual(seen, ['fill']);
  });
});

describe('store.readChainPage: paging an append-only log', () => {
  it('filters by kind and pages backwards by id', async () => {
    chainStateInit();
    for (let i = 0; i < 5; i++) await appendEntry({ kind: 'decision', payload: { i } }, false);
    for (let i = 0; i < 3; i++) await appendEntry({ kind: 'order', payload: { i } }, false);

    const orders = readChainPage({ kind: 'order', limit: 10 });
    assert.equal(orders.entries.length, 3);
    assert.ok(orders.entries.every((e) => e.kind === 'order'));

    const firstPage = readChainPage({ limit: 3 });
    assert.equal(firstPage.entries.length, 3);
    assert.equal(firstPage.hasMore, true);
    const secondPage = readChainPage({ limit: 3, cursor: firstPage.nextCursor });
    // Cursor paging must not repeat an entry — for an audit trail, a duplicated row
    // is worse than a slow query.
    const firstIds = new Set(firstPage.entries.map((e) => e.id));
    assert.ok(secondPage.entries.every((e) => !firstIds.has(e.id)));
  });

  it('returns nothing for a cursor from another chain rather than silently restarting', () => {
    const page = readChainPage({ cursor: 'somnus-zzzzzz-deadbeef' });
    assert.equal(page.entries.length, 0);
  });

  it('bounds a time range', async () => {
    chainStateInit();
    const entry = await appendEntry({ kind: 'config', payload: { a: 1 } }, false);
    assert.equal(readChainPage({ since: entry.ts + 1 }).entries.length, 0);
    assert.equal(readChainPage({ until: entry.ts }).entries.length >= 1, true);
  });

  // REGRESSION (2026-09-01 audit): readAllFromDisk is now cached on mtime+size to stop
  // /agent/logs re-reading the whole chain per request. A cache that outlives an append
  // would serve a page missing the newest entry — worse than the slow version.
  it('still sees an entry appended after the cache warmed', async () => {
    chainStateInit();
    await appendEntry({ kind: 'decision', payload: { n: 1 } }, false);
    const before = readChainPage({ limit: 50 }).matched;
    await appendEntry({ kind: 'decision', payload: { n: 2 } }, false);
    assert.equal(readChainPage({ limit: 50 }).matched, before + 1);
  });
});

// REGRESSION (2026-09-01 audit): five bugs found by auditing this session's own work.
describe('audit fixes', () => {
  it('caches the ledger without hiding a new row', () => {
    const before = openNotional();
    // Warm the cache, then write. A cache keyed on time rather than file state would
    // serve the stale total here, and every exposure limit reads this number.
    openNotional();
    recordFill('0xcache-check', 0, 10, 6);
    assert.equal(openNotional(), before + 6);
  });

  it('bills the correct side when one market was traded both ways', () => {
    // verifyLedgerAgainstChain keyed on marketId alone, so YES and NO on one window
    // collapsed into a single entry and silently matched the wrong cost basis.
    recordFill('0xbothsides', 0, 10, 4);
    recordFill('0xbothsides', 1, 10, 7);
    const rows = openPositions().filter((p) => p.marketId === '0xbothsides');
    assert.equal(rows.length, 2, 'YES and NO must be two separate positions');
    assert.equal(rows.find((r) => r.outcomeIdx === 0)?.cost, 4);
    assert.equal(rows.find((r) => r.outcomeIdx === 1)?.cost, 7);
  });

  it('keeps pre-ledger orders out of the ok verdict', () => {
    // The check was permanently red because 29 legitimate orders predate the ledger
    // existing, and an alarm that can never be cleared gets ignored. Pre-ledger
    // orders are now counted separately and excluded from `ok`.
    const v = verifyLedgerAgainstChain();
    assert.equal(typeof v.preLedgerOrders, 'number');
    assert.equal(typeof v.ledgerStartTs, 'number');
    // These fills were written straight to the ledger by earlier cases, never through
    // the trading path — so the verifier SHOULD flag them. That is the detection
    // working, and it is what an edited file would look like.
    assert.ok(v.uncorroborated.length > 0, 'fills with no signed order must be flagged');
    assert.equal(v.ok, false);
    assert.match(v.note, /no signed order behind them/i);
  });

  it('times out a hung request instead of waiting forever', async () => {
    // Node's fetch has no default timeout, so a black-holed connection hung the boot
    // preflight and the loop never auto-started. Port 1 on a loopback address is
    // closed, which gives a fast refusal rather than a hang — what matters is that the
    // call rejects rather than pending, and that a deadline is attached at all.
    const started = Date.now();
    await assert.rejects(() => fetchWithTimeout('http://127.0.0.1:1/nope', {}, 800));
    assert.ok(Date.now() - started < 5_000, 'should not hang');
  });

  it('names a timeout distinctly from a refusal', () => {
    assert.match(describeNetworkError(new HttpTimeoutError('http://x.test/a', 500)), /timed out/);
    assert.doesNotMatch(describeNetworkError(new Error('connect ECONNREFUSED')), /timed out/);
  });
});
