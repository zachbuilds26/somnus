import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A fresh deploy should show what this agent has measured, not constants.
 *
 *  `data/` is gitignored — correctly, it holds the proof chain and the P&L ledger — so a
 *  hosted deploy had no calibration file and fell back to three hardcoded tiers while the
 *  real 4,000-window study sat on the operator's laptop. On the public demo that is the
 *  difference between "here is what this agent measured about itself" and "here are some
 *  numbers somebody picked", and the second undersells the one mechanism the project is
 *  actually built around.
 *
 *  `calibration.seed.json` is that study, committed. It is a SEED: `data/` still wins when
 *  present, so a running agent's own measurements always override it.
 *
 *  These tests guard the file rather than the loader — the loader needs a filesystem the
 *  suite should not be reaching into. What breaks silently is the seed going stale, empty,
 *  or malformed, in which case a deploy quietly drops back to constants and reports it
 *  honestly but uselessly. */

interface SeedRow {
  classSec: number;
  tier: string;
  n: number;
  note?: string;
}

/** Read the real file, not `CALIBRATION_SEED_PATH`.
 *
 *  `test/env.ts` deliberately points that constant at a path that cannot exist, so tests
 *  written against the built-in fallback keep testing the fallback. This suite is about
 *  the shipped artefact, so it goes to the artefact. */
const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration.seed.json');

const seed = JSON.parse(readFileSync(SEED, 'utf8')) as {
  generatedAt?: string;
  windowsScored?: number;
  classes?: SeedRow[];
};

describe('calibration seed: shipped so a fresh deploy has evidence', () => {
  it('exists and carries classes', () => {
    assert.ok(Array.isArray(seed.classes) && seed.classes.length > 0, 'seed has no classes');
  });

  it('every row is loadable by the same rules the loader applies', () => {
    // Mirrors `readCalibrationFrom`: a row with a bad classSec or an unknown tier is
    // silently skipped, so a seed of all-bad rows would load as empty and fall through
    // to constants while looking fine on disk.
    for (const r of seed.classes ?? []) {
      assert.ok(Number.isFinite(r.classSec) && r.classSec > 0, `bad classSec ${r.classSec}`);
      assert.ok(
        ['validated', 'provisional', 'blocked'].includes(r.tier),
        `tier "${r.tier}" would be skipped by the loader`,
      );
    }
  });

  it('carries real sample counts, not zeros', () => {
    // n=0 everywhere is the signature of a seed generated from an empty ledger. It would
    // load, report `source: "seeded"`, and mean nothing.
    const total = (seed.classes ?? []).reduce((s, r) => s + (r.n ?? 0), 0);
    assert.ok(total > 100, `seed totals only ${total} scored windows — regenerate it`);
  });

  it('records when it was generated, so staleness is visible', () => {
    // Surfaced as `generatedAt` on /agent/horizons. A seed with no date cannot be judged
    // stale by anyone reading it.
    assert.ok(seed.generatedAt, 'seed has no generatedAt');
    assert.ok(!Number.isNaN(Date.parse(seed.generatedAt)), 'generatedAt is not a date');
  });

  it('still blocks the class that measured no better than chance', () => {
    // 1m scored a Brier of 0.2503 against a 0.2500 base rate over 3,110 windows — no
    // skill at all. A seed that promoted it would have the agent trading coin flips.
    const oneMinute = (seed.classes ?? []).find((r) => r.classSec === 60);
    assert.ok(oneMinute, 'seed says nothing about the 1m class');
    assert.equal(oneMinute.tier, 'blocked');
  });
});
