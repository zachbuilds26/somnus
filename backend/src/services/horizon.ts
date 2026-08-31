/** Per-horizon trading policy.
 *
 *  DreamDEX offers window classes from ~1m to 24h. The agent's probability model
 *  is not equally trustworthy across all of them, and `npm run horizon-study`
 *  measures exactly how much. Rather than a single hard cap — which refused every
 *  window over 15m and made "trades all markets" a lie — each class gets a tier,
 *  and the tier scales the two things that actually bound damage: the edge the
 *  agent demands before paying, and the size it pays with.
 *
 *      tier          when                                        edge   size
 *      validated     beats the base rate AND is calibrated        1x     1x
 *      provisional   too few samples, or directionally useful     2x    0.5x
 *                    but miscalibrated
 *      blocked       measured to be no better than the base rate   -      0
 *
 *  The tier table is NOT hardcoded here. `npm run horizon-study` writes
 *  `data/horizon-calibration.json` and this module reads it, so a class graduates
 *  (or gets demoted) from evidence rather than from someone remembering to edit a
 *  constant. That is the "train it over time" loop: trade provisionally, settle,
 *  re-run the study, and the classes that earn it move up on their own.
 *
 *  With no calibration file — a fresh clone — the fallback is deliberately
 *  conservative: 15m only. Run the study and the rest of the ladder opens up
 *  according to what it actually measures.
 *
 *  Every tier decision is folded into the decision's `reason`, so the proof chain
 *  records which regime a trade was placed under and a later study can split on
 *  it instead of pooling regimes together.                                      */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, debug } from '../config';

export type HorizonTier = 'validated' | 'provisional' | 'blocked';

/** A tier the agent is allowed to act on. */
export type TradeableTier = Exclude<HorizonTier, 'blocked'>;

export interface HorizonPolicy {
  tier: HorizonTier;
  /** Window class in seconds, rounded to the nearest minute above 60s. */
  classSec: number;
  /** Human label, e.g. `15m`. */
  label: string;
  /** Multiplier on the operator's `minEdge`. >1 means "demand more before betting". */
  edgeMultiplier: number;
  /** Multiplier on the operator's `maxTradeSize`. <1 means "stake less". */
  sizeMultiplier: number;
  /** Why this tier — recorded in the proof entry. */
  note: string;
}

/** A policy that has already been filtered down to an actionable tier. */
export interface TradeablePolicy extends Omit<HorizonPolicy, 'tier'> {
  tier: TradeableTier;
}

/** Minimum seconds a window must have left to be worth trading. A cycle takes
 *  tens of seconds, so a window with seconds left locks between the book read and
 *  the order, the pool reverts `TradingNotActive`, and the gas is wasted. */
export const MIN_EXPIRY_HEADROOM_SEC = Number(process.env.AGENT_MIN_EXPIRY_SEC ?? 75);

/** Hard ceiling on window class. Defaults to 24h so every class DreamDEX lists is
 *  reachable; tiering — not this number — is what keeps the unmeasured ones cheap.
 *  Set `AGENT_MAX_HORIZON_SEC=900` to go back to validated-classes-only. */
export const MAX_HORIZON_SEC = Number(process.env.AGENT_MAX_HORIZON_SEC ?? 86_400);

const PROVISIONAL_EDGE_MULT = Number(process.env.AGENT_PROVISIONAL_EDGE_MULT ?? 2);
const PROVISIONAL_SIZE_MULT = Number(process.env.AGENT_PROVISIONAL_SIZE_MULT ?? 0.5);

/** One measured class, as written by `npm run horizon-study`. */
export interface CalibrationRow {
  classSec: number;
  n: number;
  brier: number;
  base: number;
  /** Mean |predicted - realised| across populated probability bands. NaN when no
   *  band held enough samples to measure. */
  calErr: number;
  tier: HorizonTier;
  note: string;
}

export interface CalibrationFile {
  generatedAt: string;
  leadFraction: number;
  minSamples: number;
  windowsScored: number;
  classes: CalibrationRow[];
}

export const CALIBRATION_PATH = join(DATA_DIR, 'horizon-calibration.json');

/** Fallback when no study has been run. Deliberately cautious: only the class
 *  whose verdict every run has reproduced is trusted. Run `npm run horizon-study`
 *  and the real measurements replace all of this. */
const FALLBACK: Array<[number, HorizonTier, string]> = [
  [60, 'blocked', 'measured at the base rate in every run so far (built-in default)'],
  [300, 'provisional', 'beats the base rate but calibration is unstable run-to-run (built-in default)'],
  [900, 'validated', 'beats the base rate with stable calibration (built-in default)'],
];

/** How far a window's time-remaining may sit from the nearest measured class
 *  before the measurement stops applying. Horizons scale multiplicatively, so
 *  this is a ratio, not a difference: 600s left is close enough to the measured
 *  900s regime to inherit its verdict; 14000s is not close to anything measured
 *  and therefore unknown, which means provisional. */
const MAX_EXTRAPOLATION_RATIO = Number(process.env.AGENT_HORIZON_EXTRAPOLATION ?? 3);

let cache: { at: number; rows: Map<number, CalibrationRow> } | undefined;
const CACHE_MS = 60_000;

function calibration(): Map<number, CalibrationRow> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = new Map<number, CalibrationRow>();
  try {
    const doc = JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8')) as CalibrationFile;
    for (const r of doc.classes ?? []) {
      if (!Number.isFinite(r.classSec) || r.classSec <= 0) continue;
      if (r.tier !== 'validated' && r.tier !== 'provisional' && r.tier !== 'blocked') continue;
      rows.set(r.classSec, r);
    }
    debug(`horizon: loaded ${rows.size} measured class(es) from ${CALIBRATION_PATH}`);
  } catch {
    // No study run yet, or the file is unreadable. Fall back rather than throw —
    // a missing measurement must not stop the agent, only make it cautious.
    for (const [classSec, tier, note] of FALLBACK) {
      rows.set(classSec, {
        classSec,
        n: 0,
        brier: Number.NaN,
        base: Number.NaN,
        calErr: Number.NaN,
        tier,
        note,
      });
    }
  }
  cache = { at: Date.now(), rows };
  return rows;
}

/** Drop the cached calibration table. For tests and for the study script, which
 *  rewrites the file in-process. */
export function resetCalibrationCache(): void {
  cache = undefined;
}

/** The tier table as data, for the API and the doctor. Reports whether the
 *  verdicts are measured or the built-in fallback, so nobody mistakes a default
 *  for evidence. */
export function calibrationSummary(): {
  source: 'measured' | 'built-in default';
  generatedAt?: string;
  windowsScored?: number;
  minSamples?: number;
  minExpiryHeadroomSec: number;
  maxHorizonSec: number;
  provisionalEdgeMultiplier: number;
  provisionalSizeMultiplier: number;
  provisionalSlotsPerCycle: number;
  classes: Array<{ class: string; classSec: number; tier: HorizonTier; n: number; note: string }>;
} {
  let doc: CalibrationFile | undefined;
  try {
    doc = JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8')) as CalibrationFile;
  } catch {
    doc = undefined;
  }
  const rows = [...calibration().values()].sort((a, b) => a.classSec - b.classSec);
  return {
    source: doc ? 'measured' : 'built-in default',
    generatedAt: doc?.generatedAt,
    windowsScored: doc?.windowsScored,
    minSamples: doc?.minSamples,
    minExpiryHeadroomSec: MIN_EXPIRY_HEADROOM_SEC,
    maxHorizonSec: MAX_HORIZON_SEC,
    provisionalEdgeMultiplier: PROVISIONAL_EDGE_MULT,
    provisionalSizeMultiplier: PROVISIONAL_SIZE_MULT,
    provisionalSlotsPerCycle: PROVISIONAL_SLOTS,
    classes: rows.map((r) => ({
      class: horizonLabel(r.classSec),
      classSec: r.classSec,
      tier: r.tier,
      n: r.n,
      note: r.note,
    })),
  };
}

/** What the measurements say about a class, if anything. Exact-key lookup. */
export function measuredTier(classSec: number): CalibrationRow | undefined {
  return calibration().get(classSec);
}

/** Which measured regime governs a window with `effectiveSec` of variance left.
 *
 *  The measured ladder is discrete (60s, 300s, 900s, ...) but time-remaining is
 *  continuous, so an exact-key lookup would miss almost every window. Pick the
 *  nearest measured class by RATIO — horizons scale multiplicatively — and refuse
 *  to extrapolate further than MAX_EXTRAPOLATION_RATIO. Returning undefined means
 *  "nothing measured applies here", which the caller treats as provisional. */
export function governingRegime(effectiveSec: number): CalibrationRow | undefined {
  if (!Number.isFinite(effectiveSec) || effectiveSec <= 0) return undefined;
  let best: CalibrationRow | undefined;
  let bestRatio = Number.POSITIVE_INFINITY;
  for (const row of calibration().values()) {
    if (row.classSec <= 0) continue;
    const ratio = row.classSec > effectiveSec ? row.classSec / effectiveSec : effectiveSec / row.classSec;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = row;
    }
  }
  return bestRatio <= MAX_EXTRAPOLATION_RATIO ? best : undefined;
}

/** How many of a cycle's market slots are reserved for provisional (long) classes.
 *  Without a reservation the agent would fill every slot with 15m windows — there
 *  are always hundreds live — and never sample 1h/4h/24h at all, so those classes
 *  could never graduate to validated. */
export const PROVISIONAL_SLOTS = Number(process.env.AGENT_PROVISIONAL_SLOTS ?? 4);

/** Round a raw interval to its class. Some indexer rows carry fractional
 *  intervals (14.97m, 59s) from clock skew at window creation; rounding stops one
 *  logical class fragmenting into six. */
export function windowClass(intervalSec: number | undefined, secondsLeft: number): number {
  const raw = Number.isFinite(intervalSec) && (intervalSec as number) > 0 ? (intervalSec as number) : secondsLeft;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 60 ? Math.round(raw) : Math.round(raw / 60) * 60;
}

export function horizonLabel(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return 'unknown';
  if (sec % 86_400 === 0) return `${sec / 86_400}d`;
  if (sec % 3_600 === 0) return `${sec / 3_600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/** Classify a window. `secondsLeft` gates execution timing; `intervalSec` gates
 *  which measured regime the model is being asked to work in. Both matter and they
 *  are not the same number — a 24h window with 80s left is a near-expiry coin flip
 *  wearing a long-horizon label, so the binding constraint is whichever is
 *  smaller. */
export function horizonPolicy(intervalSec: number | undefined, secondsLeft: number): HorizonPolicy {
  const classSec = windowClass(intervalSec, secondsLeft);
  const label = horizonLabel(classSec);
  const blocked = (note: string): HorizonPolicy => ({
    tier: 'blocked',
    classSec,
    label,
    edgeMultiplier: 1,
    sizeMultiplier: 0,
    note,
  });

  if (!Number.isFinite(secondsLeft)) return blocked('no expiry on this window');
  if (secondsLeft < MIN_EXPIRY_HEADROOM_SEC) {
    return blocked(`only ${Math.max(0, Math.round(secondsLeft))}s left (< ${MIN_EXPIRY_HEADROOM_SEC}s headroom)`);
  }
  if (classSec <= 0) return blocked('window class unknown');
  if (classSec > MAX_HORIZON_SEC) {
    return blocked(`${label} class exceeds AGENT_MAX_HORIZON_SEC (${horizonLabel(MAX_HORIZON_SEC)})`);
  }

  // A long window in its final minutes is a near-expiry bet, not a long-horizon
  // one: the variance term in the model scales with time actually remaining, not
  // with the name on the window. Judge by whichever regime is tighter.
  const effective = Math.min(classSec, secondsLeft);
  const regime = governingRegime(effective);
  const regimeLabel = regime ? horizonLabel(regime.classSec) : horizonLabel(windowClass(effective, effective));

  if (regime?.tier === 'blocked') {
    return blocked(`${label} window sits in the ${regimeLabel} regime: ${regime.note}`);
  }
  if (regime?.tier === 'validated') {
    return {
      tier: 'validated',
      classSec,
      label,
      edgeMultiplier: 1,
      sizeMultiplier: 1,
      note: `${label} window in the validated ${regimeLabel} regime — ${regime.note}`,
    };
  }

  return {
    tier: 'provisional',
    classSec,
    label,
    edgeMultiplier: PROVISIONAL_EDGE_MULT,
    sizeMultiplier: PROVISIONAL_SIZE_MULT,
    note:
      `${label} window is unvalidated (${regime ? `${regimeLabel} regime: ${regime.note}` : 'no measured regime covers this horizon'}) ` +
      `— demanding ${PROVISIONAL_EDGE_MULT}x edge at ${PROVISIONAL_SIZE_MULT}x size`,
  };
}
