import { strict as assert } from 'node:assert';
import { writeFileSync, rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import {
  CALIBRATION_PATH,
  governingRegime,
  horizonLabel,
  horizonPolicy,
  resetCalibrationCache,
  windowClass,
  MIN_EXPIRY_HEADROOM_SEC,
  type CalibrationFile,
} from '../src/services/horizon';

/** test/env.ts points DATA_DIR at a temp directory, so by default no calibration
 *  file exists and the built-in fallback table applies. Tests that need measured
 *  verdicts write the file themselves and reset the cache. */
function writeCalibration(classes: CalibrationFile['classes']): void {
  const doc: CalibrationFile = {
    generatedAt: '2026-08-25T00:00:00.000Z',
    leadFraction: 0.5,
    minSamples: 40,
    windowsScored: 1000,
    classes,
  };
  writeFileSync(CALIBRATION_PATH, JSON.stringify(doc, null, 2));
  resetCalibrationCache();
}

afterEach(() => {
  rmSync(CALIBRATION_PATH, { force: true });
  resetCalibrationCache();
});

test('labels each window class the way DreamDEX names it', () => {
  assert.equal(horizonLabel(60), '1m');
  assert.equal(horizonLabel(300), '5m');
  assert.equal(horizonLabel(900), '15m');
  assert.equal(horizonLabel(3600), '1h');
  assert.equal(horizonLabel(14400), '4h');
  assert.equal(horizonLabel(86400), '1d');
  assert.equal(horizonLabel(0), 'unknown');
});

test('collapses clock-skewed intervals into one class', () => {
  // Real indexer rows: a 15m window recorded as 898s, a 1h one as 3598s. Left
  // unrounded these fragment into singleton classes that can never accumulate the
  // samples needed to graduate — which is exactly what the study used to do.
  assert.equal(windowClass(898, 800), 900);
  assert.equal(windowClass(302, 300), 300);
  assert.equal(windowClass(3598, 3000), 3600);
  assert.equal(windowClass(14400 * 0.999, 14000), 14400);
  // Sub-minute rows keep their raw value; they are blocked either way.
  assert.equal(windowClass(52, 52), 52);
});

test('with no study run, only the built-in default class is traded at full size', () => {
  const validated = horizonPolicy(900, 890);
  assert.equal(validated.tier, 'validated');
  assert.equal(validated.edgeMultiplier, 1);
  assert.equal(validated.sizeMultiplier, 1);
  assert.match(validated.note, /built-in default/);

  // Everything the fallback does not vouch for is traded cautiously, not refused.
  for (const sec of [3600, 14400, 86400]) {
    const p = horizonPolicy(sec, sec - 60);
    assert.equal(p.tier, 'provisional', `${horizonLabel(sec)} should be provisional, not blocked`);
    assert.ok(p.edgeMultiplier > 1, 'must demand more edge where calibration is unmeasured');
    assert.ok(p.sizeMultiplier < 1, 'must stake less where calibration is unmeasured');
  }
});

test('trades every class on the ladder — nothing above 15m is refused outright', () => {
  const ladder = [300, 900, 3600, 14400, 86400];
  const tiers = ladder.map((sec) => horizonPolicy(sec, sec - 60).tier);
  assert.ok(
    tiers.every((t) => t !== 'blocked'),
    `the whole ladder must be reachable, got ${JSON.stringify(tiers)}`,
  );
});

test('a measured verdict overrides the fallback — the graduation path works', () => {
  writeCalibration([
    { classSec: 60, n: 786, brier: 0.25, base: 0.2496, calErr: 0.019, tier: 'blocked', note: 'no better than base rate' },
    { classSec: 300, n: 154, brier: 0.1944, base: 0.25, calErr: 0.1, tier: 'validated', note: 'beats base rate' },
    { classSec: 3600, n: 10, brier: 0.2228, base: 0.24, calErr: 0.266, tier: 'provisional', note: 'n=10 of 40' },
  ]);

  // 5m is now validated on evidence, where the fallback had it provisional.
  const fiveMin = horizonPolicy(300, 290);
  assert.equal(fiveMin.tier, 'validated');
  assert.equal(fiveMin.sizeMultiplier, 1);
  assert.match(fiveMin.note, /beats base rate/);

  // 1h stays provisional until it reaches the sample floor.
  const oneHour = horizonPolicy(3600, 3540);
  assert.equal(oneHour.tier, 'provisional');
  assert.match(oneHour.note, /n=10 of 40/);
});

test('a measured no-edge verdict blocks the class outright', () => {
  writeCalibration([
    {
      classSec: 60,
      n: 786,
      brier: 0.25,
      base: 0.2496,
      calErr: 0.019,
      tier: 'blocked',
      note: 'Brier 0.2500 is no better than the 0.2496 base rate',
    },
  ]);
  // Enough headroom to place the order, but the regime itself is disproven.
  const p = horizonPolicy(75, 80);
  assert.equal(p.classSec, 60, 'a 75s window rounds into the 1m class');
  assert.equal(p.tier, 'blocked');
  assert.match(p.note, /base rate/);
  assert.equal(p.sizeMultiplier, 0);
});

test('a long window in its final minutes is priced by time left, not by its label', () => {
  writeCalibration([
    { classSec: 900, n: 50, brier: 0.1534, base: 0.2484, calErr: 0.098, tier: 'validated', note: 'measured' },
  ]);
  // A 4h window with 10 minutes left carries 10m of variance, not 4h of it, so it
  // belongs to the measured 15m regime and is traded on the measured rules.
  const near = horizonPolicy(14400, 600);
  assert.equal(near.tier, 'validated');
  assert.equal(near.edgeMultiplier, 1);
  assert.equal(near.label, '4h', 'label still reports the real class for the audit trail');

  // The same window with 4h left is far outside anything measured: unknown.
  const far = horizonPolicy(14400, 14000);
  assert.equal(far.tier, 'provisional');
});

test('refuses to extrapolate a measurement across an implausible gap', () => {
  writeCalibration([
    { classSec: 900, n: 50, brier: 0.15, base: 0.25, calErr: 0.09, tier: 'validated', note: 'measured' },
  ]);
  // 15m measured, 15m asked: applies.
  assert.ok(governingRegime(900));
  // 20m asked: close enough to inherit the 15m verdict.
  assert.ok(governingRegime(1200));
  // 24h asked against a 15m measurement: 96x apart, tells us nothing.
  assert.equal(governingRegime(86400), undefined);
});

test('drops windows without enough headroom to place an order', () => {
  const p = horizonPolicy(900, MIN_EXPIRY_HEADROOM_SEC - 1);
  assert.equal(p.tier, 'blocked');
  assert.match(p.note, /headroom/);
  assert.equal(p.sizeMultiplier, 0);
});

test('drops windows with no expiry at all', () => {
  assert.equal(horizonPolicy(900, Number.NaN).tier, 'blocked');
});

test('survives a corrupt calibration file instead of refusing to trade', () => {
  writeFileSync(CALIBRATION_PATH, '{ this is not json');
  resetCalibrationCache();
  const p = horizonPolicy(900, 890);
  assert.equal(p.tier, 'validated', 'must fall back, not throw or block everything');
});
