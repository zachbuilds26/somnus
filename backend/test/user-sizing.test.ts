import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sizingNote } from '../src/services/user-trading';
import type { TradeablePolicy } from '../src/services/horizon';

/** Say out loud why a trade cost less than the caller asked to risk.
 *
 *  Two things shrink a stake and neither was ever stated. The horizon tier halves the
 *  budget on a window class the model has not proven itself on — 0.5x by default,
 *  `AGENT_PROVISIONAL_SIZE_MULT` — and contracts are whole units, so whatever is left
 *  after the last one cannot be spent. Ask to risk 10 on an hourly window and about 5
 *  leaves your wallet.
 *
 *  The behaviour is deliberate and stays. What was wrong is that the response reported
 *  `stake: 10` next to `cost: 5` and put the explanation inside a `reason` string
 *  ending "0.5x size", which nobody reads. A number the caller did not choose has to
 *  be stated in words. These tests pin those words, because a sizing explanation that
 *  drifts out of step with the arithmetic is worse than none. */

const policy = (over: Partial<TradeablePolicy> = {}): TradeablePolicy => ({
  tier: 'validated',
  classSec: 300,
  label: '5m',
  edgeMultiplier: 1,
  sizeMultiplier: 1,
  note: 'Brier 0.1887 vs 0.2494 base rate, calibration error 0.056, n=622',
  ...over,
});

const provisional = (): TradeablePolicy =>
  policy({
    tier: 'provisional',
    classSec: 3600,
    label: '1h',
    edgeMultiplier: 2,
    sizeMultiplier: 0.5,
    note: 'beats the base rate (0.1435 vs 0.2400) but calibration error 0.215 exceeds 0.15, n=50',
  });

describe('user-trading: the sizing explanation a caller actually reads', () => {
  it('states both the amount asked for and the amount used', () => {
    // The exact complaint: asked for 10, charged ~5, nothing said why.
    const note = sizingNote(10, 5, 4.62, provisional());
    assert.match(note, /10\.00/);
    assert.match(note, /5\.00/);
    assert.match(note, /50%/);
  });

  it('names the window class and its tier as the reason', () => {
    const note = sizingNote(10, 5, 5, provisional());
    assert.match(note, /1h/);
    assert.match(note, /provisional/);
    // The evidence, not just the verdict — "unproven" is a claim, the Brier score is
    // the reason to believe it.
    assert.match(note, /calibration error 0\.215/);
    assert.match(note, /validated/i);
  });

  it('does not restate the multipliers twice in one sentence', () => {
    // `policy.note` ends "— demanding 2x edge at 0.5x size" for the proof entry. The
    // percentage is already stated in the caller's own numbers, so the trailing clause
    // is stripped; keeping both reads like a machine wrote it.
    const note = sizingNote(10, 5, 5, provisional());
    assert.doesNotMatch(note, /demanding/i);
    assert.doesNotMatch(note, /0\.5x size/);
    // The evidence before that clause must survive the strip.
    assert.match(note, /n=50/);
  });

  it('explains the round-down to whole contracts separately', () => {
    // A distinct cause from the tier multiplier, so it gets its own sentence — and
    // only when it actually cost something worth mentioning.
    const note = sizingNote(10, 5, 4.62, provisional());
    assert.match(note, /whole units/);
    assert.match(note, /4\.62/);
    assert.match(note, /0\.38/);
  });

  it('stays quiet about rounding when a cent or less was left', () => {
    const note = sizingNote(10, 5, 4.995, provisional());
    assert.doesNotMatch(note, /whole units/);
  });

  it('confirms full sizing on a validated class rather than saying nothing', () => {
    // Silence would be ambiguous: a caller cannot tell "full stake" from "no note
    // written yet". Say it either way.
    const note = sizingNote(10, 10, 10, policy());
    assert.match(note, /full 10\.00/);
    assert.match(note, /5m/);
    assert.match(note, /validated/);
    assert.doesNotMatch(note, /50%/);
  });

  it('reports a percentage that matches the multiplier it was given', () => {
    // Guards the one thing a hand-written sentence gets wrong: drifting from the
    // number it describes when the env var is changed.
    assert.match(sizingNote(20, 5, 5, policy({ tier: 'provisional', sizeMultiplier: 0.25 })), /25%/);
    assert.match(sizingNote(20, 15, 15, policy({ tier: 'provisional', sizeMultiplier: 0.75 })), /75%/);
  });
});
