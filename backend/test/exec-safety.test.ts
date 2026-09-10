import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginCycle,
  clampRunOverrides,
  executeDecision,
  executeStandaloneDecision,
  runWithExecutionLock,
  __brokerInternals,
} from '../src/services/broker';
import { loadAgentConfig, saveAgentConfig } from '../src/agent-config';
import { config } from '../src/config';
import { __resetWalletCacheForTests } from '../src/services/wallet';
import type { Decision } from '../src/types';

/** Execution-safety regressions (H1/H2/H3/H6 + M2/M4 choke point).
 *
 *  These run against the temp DATA_DIR set by test/env.ts and never place
 *  anything: PASS decisions reject before any market read, the freshness gate
 *  sits before routing, and DRY_RUN is forced for the whole suite — so a
 *  "fresh" BUY can only end as `simulated` (indexer reachable) or `cannot route
 *  order` (offline), and the suite asserts exactly that disjunction rather than
 *  either arm. The one test that needs live MODE flips only in-memory config
 *  with the keys detached, so `beginCycle(false)` answers everything locally. */

function buyDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    symbol: 'TEST-5M-XXXX',
    fair: 0.6,
    mid: 0.5,
    ask: 0.5,
    bid: 0.48,
    edge: 0.1,
    action: 'BUY_YES',
    size: 10,
    freshness: { spotAgeMs: 100, candleAgeMs: 100, bookAgeMs: 100 },
    reason: 'exec-safety test',
    dryRun: true,
    ...overrides,
  };
}

function passDecision(): Decision {
  return { ...buyDecision(), action: 'PASS', size: 0, edge: 0 };
}

/** Pinned limits, so the freshness/edge assertions below do not depend on
 *  whatever the operator's .env seeds as defaults. */
function saveTestConfig(): void {
  saveAgentConfig({
    ...loadAgentConfig(),
    mode: 'dry-run',
    maxDataAgeMs: 15_000,
    minEdge: 0.03,
    maxTradeSize: 25,
    maxOpenPositions: 10,
    maxOpenNotional: 1000,
    tradeQuota: null,
    tradingPaused: false,
  });
}

describe('clampRunOverrides: per-run overrides may only tighten (H3)', () => {
  const saved = { maxTradeSize: 25 };

  it('caps size at the saved maxTradeSize, never above', () => {
    assert.equal(clampRunOverrides({ maxTradeSize: 10_000 }, saved).maxTradeSize, 25);
    assert.equal(clampRunOverrides({ maxTradeSize: 10 }, saved).maxTradeSize, 10);
    assert.equal(clampRunOverrides({ maxTradeSize: 25 }, saved).maxTradeSize, 25);
  });

  it('drops invalid sizes and leaves the saved rule governing', () => {
    for (const bad of [0, -5, Number.NaN, 'lots', undefined, null]) {
      assert.equal(
        clampRunOverrides({ maxTradeSize: bad }, saved).maxTradeSize,
        undefined,
        `size ${String(bad)} should be dropped`,
      );
    }
  });

  it('caps the per-run trade count at 25 and floors fractions', () => {
    assert.equal(clampRunOverrides({ maxTrades: 100 }, saved).maxTrades, 25);
    assert.equal(clampRunOverrides({ maxTrades: 3 }, saved).maxTrades, 3);
    assert.equal(clampRunOverrides({ maxTrades: 2.9 }, saved).maxTrades, 2);
    assert.equal(clampRunOverrides({ maxTrades: -1 }, saved).maxTrades, undefined);
  });

  it('bounds the symbol filter at 20 entries of 128 chars, dropping non-strings', () => {
    const many = [...Array(30).keys()].map((i) => `SYM${i}`);
    assert.equal(clampRunOverrides({ symbols: many }, saved).symbols?.length, 20);
    assert.deepEqual(clampRunOverrides({ symbols: ['btc', 42, null, '', 'x'.repeat(200)] }, saved).symbols, [
      'btc',
      'x'.repeat(128),
    ]);
  });

  it('omits symbols entirely when nothing usable remains', () => {
    assert.equal(clampRunOverrides({ symbols: [42, null, ''] }, saved).symbols, undefined);
    assert.equal(clampRunOverrides({ symbols: 'BTC' }, saved).symbols, undefined);
    assert.equal(clampRunOverrides({}, saved).symbols, undefined);
  });

  it('passes a positive per-run edge bar through, drops zero/negative', () => {
    assert.equal(clampRunOverrides({ minEdge: 0.05 }, saved).minEdge, 0.05);
    assert.equal(clampRunOverrides({ minEdge: 0 }, saved).minEdge, undefined);
    assert.equal(clampRunOverrides({ minEdge: -0.1 }, saved).minEdge, undefined);
  });

  it('clamps widening overrides at the beginCycle choke point', async () => {
    saveTestConfig(); // saved maxTradeSize is 25 here
    const symbols = [...Array(27).keys()].map((i) => `SYM${i}`);
    await beginCycle(true, {
      maxTradeSize: 10_000,
      maxTrades: 100,
      symbols: ['BTC', 42 as unknown as string, ...symbols],
    });
    const o = __brokerInternals.cycleOverrides();
    assert.equal(o.rules.maxTradeSize, 25);
    assert.equal(o.requestedTrades, 25);
    assert.equal(o.rules.symbols?.length, 20);
    assert.ok(o.rules.symbols?.every((s) => typeof s === 'string'));
  });
});

describe('shared execution lock: cycle and confirm never interleave (H1+M2)', () => {
  beforeEach(async () => {
    saveTestConfig();
    await beginCycle(true);
  });

  it('runs lock holders one at a time, in FIFO order', async () => {
    const events: string[] = [];
    const first = runWithExecutionLock(async () => {
      events.push('first-start');
      await new Promise((r) => setTimeout(r, 30));
      events.push('first-end');
    });
    const second = runWithExecutionLock(async () => {
      events.push('second-start');
      events.push('second-end');
    });
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('keeps the queue alive when a holder rejects', async () => {
    await assert.rejects(
      runWithExecutionLock(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(
      await runWithExecutionLock(async () => 42),
      42,
    );
  });

  it('a confirm waits for an in-flight cycle instead of wiping its counters', async () => {
    const events: string[] = [];
    const cycle = runWithExecutionLock(async () => {
      events.push('cycle-start');
      await beginCycle(true);
      // One order accepted mid-cycle: the counters a confirm used to wipe with
      // its own beginCycle.
      __brokerInternals.simulateAcceptedOrder(10);
      // Still working while the confirm arrives...
      await new Promise((r) => setTimeout(r, 50));
      // ...so this is still 1. Before the shared lock, the confirm's beginCycle
      // ran here and reset it to 0, silently unbinding every cap for the rest
      // of the cycle.
      assert.equal(__brokerInternals.cycleSnapshot().openedThisCycle, 1);
      events.push('cycle-end');
    });
    // Wait until the cycle actually holds the lock, then confirm mid-cycle.
    for (let i = 0; i < 1000 && !events.includes('cycle-start'); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.ok(events.includes('cycle-start'), 'cycle never started holding the lock');
    const order = await executeStandaloneDecision(passDecision());
    await cycle;
    assert.deepEqual(events, ['cycle-start', 'cycle-end']);
    // PASS is not executable — but it waited its turn first.
    assert.equal(order.status, 'rejected');
    assert.match(order.reason ?? '', /action not executable/);
    // The standalone re-baselined AFTER the cycle, so its fresh counters are
    // what remains — proof it ran last, not during.
    assert.equal(__brokerInternals.cycleSnapshot().openedThisCycle, 0);
  });
});

describe('queue-delay freshness: ages include the wait (H2)', () => {
  beforeEach(async () => {
    saveTestConfig();
    await beginCycle(true);
  });

  it('rejects a decision with no timestamp (fail-closed)', async () => {
    const d = buyDecision();
    delete (d as { ts?: unknown }).ts;
    const order = await executeDecision(d);
    assert.equal(order.status, 'rejected');
    assert.match(order.reason ?? '', /no timestamp/i);
  });

  it('rejects a decision stamped in the future (fail-closed)', async () => {
    const order = await executeDecision(buyDecision({ ts: Date.now() + 120_000 }));
    assert.equal(order.status, 'rejected');
    assert.match(order.reason ?? '', /future/i);
  });

  it('adds the queue delay to scan-time ages before judging', async () => {
    // 0.1s old at scan, queued 60s: ~60.1s against a 15s limit — fresh at scan,
    // stale at execution, which is exactly what the old gate missed.
    const order = await executeDecision(buyDecision({ ts: Date.now() - 60_000 }));
    assert.equal(order.status, 'rejected');
    assert.match(order.reason ?? '', /stale market data/);
  });

  it('lets through a decision whose aged data is still inside the limit', async () => {
    // Edge 0.001 against a 0.03 bar: rejected at the EDGE gate, which sits AFTER
    // the freshness gate — so reaching it proves the queue-aged data passed.
    // Stopping here is deliberate: the next step is market routing, which needs
    // the network and would make this suite hang offline.
    const order = await executeDecision(buyDecision({ edge: 0.001 }));
    assert.equal(order.status, 'rejected');
    assert.match(order.reason ?? '', /edge 0\.001 < minEdge 0\.03/);
  });
});

describe('cycle-pinned dry-run: a mid-cycle mode flip re-baselines (H6)', () => {
  beforeEach(async () => {
    saveTestConfig();
    await beginCycle(true);
  });

  it('leaves baselines alone while the mode is steady', async () => {
    __brokerInternals.simulateAcceptedOrder(10);
    const order = await executeDecision(passDecision());
    assert.equal(order.status, 'rejected');
    // Same mode throughout: no re-baseline, the in-cycle count survives.
    assert.equal(__brokerInternals.cycleSnapshot().openedThisCycle, 1);
    assert.equal(__brokerInternals.cycleSnapshot().dryRun, true);
  });

  it('re-baselines live when dry-run flips to live mid-cycle', async () => {
    await beginCycle(true);
    __brokerInternals.simulateAcceptedOrder(10);
    assert.equal(__brokerInternals.cycleSnapshot().openedThisCycle, 1);

    // Flip the world under an in-flight dry-run cycle: the operator saved live
    // while the cycle was still executing.
    const prevDry = config.dryRun;
    const prevTrade = config.tradeKey;
    const prevPrivate = config.privateKey;
    const prevOperator = config.operatorKey;
    const prevSaved = loadAgentConfig();
    try {
      // Keys detached: beginCycle(false) then answers everything locally (empty
      // market map, missed balance cache), so this stays offline-safe even on a
      // machine whose .env holds real keys.
      config.dryRun = false;
      config.tradeKey = undefined;
      config.privateKey = undefined;
      config.operatorKey = undefined;
      saveAgentConfig({ ...loadAgentConfig(), mode: 'live' });

      // PASS rejects before any market read or live submit — but the H6 check
      // runs before every gate, so the re-baseline still has to happen first.
      const order = await executeDecision(passDecision());
      assert.equal(order.dryRun, false);
      // Fresh LIVE baselines: the dry-run zeroes are gone, and with them the
      // simulated count (simulations are not real exposure).
      const snap = __brokerInternals.cycleSnapshot();
      assert.equal(snap.dryRun, false);
      assert.equal(snap.openedThisCycle, 0);
      assert.equal(snap.openedNotionalThisCycle, 0);
    } finally {
      config.dryRun = prevDry;
      config.tradeKey = prevTrade;
      config.privateKey = prevPrivate;
      config.operatorKey = prevOperator;
      saveAgentConfig(prevSaved);
      __resetWalletCacheForTests();
      await beginCycle(true);
    }
  });
});
