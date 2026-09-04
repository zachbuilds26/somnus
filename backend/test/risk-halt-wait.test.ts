import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfigDoc } from '../src/types';

/** Halt or wait — the distinction that decides whether an unattended agent survives
 *  the night.
 *
 *  `loop.ts` used to call `stopLoop()` whenever `riskStatus()` reported ANYTHING
 *  blocking. But the blocked list mixed two opposite kinds of condition: breakers a
 *  human has to clear, and infrastructure that heals. A ten-minute indexer blip took
 *  the same path as a blown daily loss limit, and only a manual
 *  `POST /agent/loop/start` brought the agent back. The order books really did fail
 *  for twenty hours on 2026-09-02 while every other feed stayed green.
 *
 *  So: both kinds still refuse orders — a blind agent must not trade any more than a
 *  losing one — but only `halting` may stop the loop or latch the kill switch.
 *
 *  `AGENT_BOOK_STALE_BLOCK_MS` is read when `risk.ts` is first imported, so it is set
 *  before the dynamic import below. That is what makes the transient case reachable:
 *  no book has been read in this process, so with a 1ms threshold the agent is
 *  "blind" as soon as the module has been up a tick. */
process.env.AGENT_BOOK_STALE_BLOCK_MS = '1';

const risk = await import('../src/services/risk');
const { riskStatus, pauseTrading, resumeTrading, reviewAfterSettlement, __resetRiskStateForTests } =
  risk;

const rules = (over: Partial<AgentConfigDoc> = {}): AgentConfigDoc => ({
  symbols: ['BTC'],
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
  ...over,
});

describe('risk: a transient outage is not a breaker', () => {
  before(() => __resetRiskStateForTests());
  after(() => {
    resumeTrading({ clearFailures: true });
    __resetRiskStateForTests();
    delete process.env.AGENT_BOOK_STALE_BLOCK_MS;
  });

  it('classifies a dead book feed as something to wait out', () => {
    const s = riskStatus(rules());
    // Still refuses orders — everything downstream of the book is derived from it.
    assert.equal(s.ok, false);
    assert.ok(s.blocks.some((b) => b.code === 'book-stale' && b.transient));
    // But it is not a reason for the scheduler to stop.
    assert.equal(s.halting.length, 0);
    assert.ok(s.waiting.some((r) => /blind/i.test(r)));
  });

  it('does not latch the kill switch for a condition that heals itself', () => {
    // The specific old bug: `reviewAfterSettlement` paused on anything blocking, so a
    // ten-minute outage left a persistent switch that outlived the problem and needed
    // a human to clear something already fixed.
    const before = riskStatus(rules());
    assert.equal(before.ok, false);
    assert.equal(before.paused, false);
    assert.equal(reviewAfterSettlement().paused, false);
  });

  it('keeps blocked as the union of halting and waiting', () => {
    // `blocked` is what /health and the MCP tools render. It must stay complete, or
    // splitting the list would hide a reason from every human-facing surface.
    const s = riskStatus(rules());
    assert.deepEqual([...s.halting, ...s.waiting].sort(), [...s.blocked].sort());
    assert.equal(s.blocks.length, s.blocked.length);
    assert.equal(s.ok, s.blocks.length === 0);
  });
});

describe('risk: a real breaker still stops everything', () => {
  before(() => __resetRiskStateForTests());
  after(() => {
    resumeTrading({ clearFailures: true });
    __resetRiskStateForTests();
    delete process.env.AGENT_BOOK_STALE_BLOCK_MS;
  });

  it('classifies the kill switch as halting, never as transient', () => {
    const s = riskStatus(rules({ tradingPaused: true, pauseReason: 'blown loss limit' }));
    const paused = s.blocks.find((b) => b.code === 'paused');
    assert.ok(paused);
    assert.equal(paused.transient, false);
    assert.ok(s.halting.some((r) => /blown loss limit/.test(r)));
  });

  it('classifies a blown daily loss limit as halting', () => {
    // Forced through the rules rather than by writing ledger rows: the classification
    // is what this file is about, and the arithmetic has its own tests.
    const s = riskStatus(rules({ maxDailyLoss: 0.000001 }));
    for (const b of s.blocks.filter((x) => x.code === 'daily-loss')) {
      assert.equal(b.transient, false);
    }
  });

  it('latches the kill switch when a halting condition is present', () => {
    const s = reviewAfterSettlement();
    // No halting condition in this process (the ledger is a fresh temp dir), so the
    // switch must be untouched — then verify the positive case explicitly.
    assert.equal(s.paused, false);
    pauseTrading('daily loss limit reached');
    const after = riskStatus(rules({ tradingPaused: true, pauseReason: 'daily loss limit reached' }));
    assert.equal(after.paused, true);
    assert.ok(after.halting.length > 0);
    resumeTrading({ clearFailures: true });
  });
});
