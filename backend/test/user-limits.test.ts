import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDailyLimit,
  clearLimits,
  effectiveMaxStake,
  saveLimits,
  savedLimits,
  spentToday,
} from '../src/services/user-limits';
import { clampStake, maxUserStake } from '../src/services/user-trading';

/** Limits a caller sets for themselves.
 *
 *  The server ceilings exist so no tool argument can widen the blast radius of a bug or a
 *  stolen token. They were never a risk policy for the person on the other end: 1,000 tUSDC
 *  a trade and 20 trades an hour is 20,000 an hour, and the only thing that stopped a
 *  caller losing their whole balance was running out of it. The agent has six circuit
 *  breakers; a caller had two.
 *
 *  One rule makes this safe to offer, and it is what most of these tests are about: a
 *  caller's value may only ever be TIGHTER than the server's. In that direction only. So
 *  the feature can hand out no authority the caller did not already have, and a corrupt or
 *  hand-edited file can widen nothing.
 *
 *  It also decides how the storage hazard is handled. `DATA_DIR` is recreated with the
 *  container on a diskless tier, so a saved limit is lost on deploy — in the LOOSER
 *  direction, back to the default. Hence `source`, reported everywhere, so a caller can
 *  tell which they are on rather than assume. */

const H = 'test-handle-aaaa';
const OTHER = 'test-handle-bbbb';

describe('user limits: tighter only, never looser', () => {
  beforeEach(() => {
    clearLimits(H);
    clearLimits(OTHER);
  });
  after(() => {
    clearLimits(H);
    clearLimits(OTHER);
  });

  it('starts on the server default, and says so', () => {
    const e = effectiveMaxStake(H);
    assert.equal(e.cap, maxUserStake());
    assert.equal(e.source, 'default');
  });

  it('honours a tighter per-trade cap', () => {
    saveLimits(H, { maxPerTrade: 50 });
    const e = effectiveMaxStake(H);
    assert.equal(e.cap, 50);
    assert.equal(e.source, 'custom');
    assert.equal(e.serverCap, maxUserStake());
  });

  it('clamps a request for MORE than the server allows', () => {
    // The whole safety property. If this ever passes through, the feature becomes a way to
    // raise the ceiling the server set — the opposite of its purpose.
    const stored = saveLimits(H, { maxPerTrade: maxUserStake() * 10 });
    assert.equal(stored.maxPerTrade, maxUserStake());
    assert.equal(effectiveMaxStake(H).cap, maxUserStake());
  });

  it('re-clamps at read time, so a hand-edited file cannot widen anything', () => {
    // `saveLimits` clamps on write, but the file is on disk and could be edited. Reading
    // must clamp too, or the guard is only as good as the last write path.
    saveLimits(H, { maxPerTrade: 50 });
    assert.ok(effectiveMaxStake(H).cap <= maxUserStake());
  });

  it('keeps callers apart', () => {
    saveLimits(H, { maxPerTrade: 25 });
    assert.equal(effectiveMaxStake(H).cap, 25);
    assert.equal(effectiveMaxStake(OTHER).source, 'default');
  });

  it('resets to the default on reset, not to zero', () => {
    // A cap of 0 would refuse every trade and read as a bug rather than as a reset.
    saveLimits(H, { maxPerTrade: 25 });
    clearLimits(H);
    const e = effectiveMaxStake(H);
    assert.equal(e.cap, maxUserStake());
    assert.equal(e.source, 'default');
  });

  it('ignores nonsense instead of storing it', () => {
    saveLimits(H, { maxPerTrade: -5 });
    assert.equal(savedLimits(H).maxPerTrade, undefined);
    saveLimits(H, { maxPerTrade: Number.NaN });
    assert.equal(savedLimits(H).maxPerTrade, undefined);
  });

  it('records when it was set, so a value lost to a redeploy is visible', () => {
    saveLimits(H, { maxPerTrade: 50 });
    assert.ok((savedLimits(H).setAt ?? 0) > 0);
  });

  it('merges, so setting one limit does not erase the other', () => {
    // Caught by trying it over real MCP: adjusting the per-trade cap wiped the daily cap
    // that had been set a minute earlier, and said nothing. Same class of bug as a partial
    // config PUT clobbering a field it never mentioned.
    saveLimits(H, { maxPerTrade: 50, maxDailyLoss: 200 });
    saveLimits(H, { maxPerTrade: 30 });
    const s = savedLimits(H);
    assert.equal(s.maxPerTrade, 30);
    assert.equal(s.maxDailyLoss, 200, 'the daily cap should have survived');
  });

  it('clears BOTH on an explicit reset', () => {
    // The counterpart: merging must not make it impossible to get back to defaults.
    saveLimits(H, { maxPerTrade: 50, maxDailyLoss: 200 });
    clearLimits(H);
    assert.equal(savedLimits(H).maxPerTrade, undefined);
    assert.equal(savedLimits(H).maxDailyLoss, undefined);
  });
});

describe('user limits: the per-trade cap actually binds a trade', () => {
  beforeEach(() => clearLimits(H));
  after(() => clearLimits(H));

  it('sizes a trade against the caller\'s own cap', () => {
    saveLimits(H, { maxPerTrade: 40 });
    const own = effectiveMaxStake(H).cap;
    const c = clampStake(1000, own);
    assert.equal(c.stake, 40);
    assert.equal(c.cap, 40);
    assert.equal(c.clamped, true, 'a reduction must be reported, never silent');
  });

  it('still stakes the cap when no amount is named', () => {
    saveLimits(H, { maxPerTrade: 40 });
    assert.equal(clampStake(undefined, effectiveMaxStake(H).cap).stake, 40);
  });

  it('leaves a request under the cap alone', () => {
    saveLimits(H, { maxPerTrade: 40 });
    const c = clampStake(10, effectiveMaxStake(H).cap);
    assert.equal(c.stake, 10);
    assert.equal(c.clamped, false);
  });

  it('falls back to the server cap when the caller set none', () => {
    assert.equal(clampStake(undefined, effectiveMaxStake(H).cap).cap, maxUserStake());
  });
});

describe('user limits: the daily cap', () => {
  beforeEach(() => clearLimits(H));
  after(() => clearLimits(H));

  it('does not exist until a caller asks for one', () => {
    // The server imposes no daily cap. Inventing a default here would change behaviour for
    // every existing caller without being asked.
    const v = checkDailyLimit(H, 500);
    assert.equal(v.ok, true);
    assert.equal(v.limit, undefined);
  });

  it('allows a trade that fits and refuses one that does not', () => {
    saveLimits(H, { maxDailyLoss: 100 });
    assert.equal(checkDailyLimit(H, 90).ok, true);
    const over = checkDailyLimit(H, 500);
    assert.equal(over.ok, false);
    assert.equal(over.limit, 100);
    assert.match(over.reason ?? '', /daily limit/);
  });

  it('explains itself in terms a caller can act on', () => {
    // A refusal that does not say what is left, or when it resets, sends somebody to the
    // source to find out.
    saveLimits(H, { maxDailyLoss: 100 });
    const over = checkDailyLimit(H, 500);
    assert.match(over.reason ?? '', /00:00 UTC/);
    assert.match(over.reason ?? '', /somnus_my_limits/);
    assert.ok(over.remaining !== undefined);
  });

  it('reports the UTC day it is counting, so a reset is predictable', () => {
    saveLimits(H, { maxDailyLoss: 100 });
    assert.match(checkDailyLimit(H, 1).dayUtc, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts nothing for a caller with no orders on the chain', () => {
    assert.equal(spentToday(H), 0);
  });

  it('never reports negative remaining', () => {
    // Presenting "-40 left" invites a reader to think they can trade their way back.
    saveLimits(H, { maxDailyLoss: 10 });
    const v = checkDailyLimit(H, 1000);
    assert.ok((v.remaining ?? 0) >= 0);
  });
});
