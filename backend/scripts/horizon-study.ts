#!/usr/bin/env tsx
/** Per-interval calibration study.
 *
 *  The earlier "no skill beyond 5 minutes" conclusion rested on n=8 at 900s.
 *  That is unmeasured, not unskilled — and a user WILL want longer-horizon
 *  trades. This scores each window class (1m / 5m / 15m / 1h / 4h / 24h)
 *  separately, at a lead proportional to its own length, over a large sample,
 *  so the horizon cap is set by evidence rather than by a shrug.
 *
 *  For each class it reports the Brier score against the base rate, and — more
 *  importantly for trading — whether the model's probabilities are CALIBRATED
 *  (predicted 0.3 should happen ~30% of the time).
 */
import { writeFileSync } from 'node:fs';
import { closeAndExit, getExchange, recentCandles } from '../src/services/sdk';
import { horizonVolatility, normalCdf } from '../src/services/signal';
import {
  CALIBRATION_PATH,
  horizonLabel,
  resetCalibrationCache,
  windowClass,
  type CalibrationFile,
  type CalibrationRow,
  type HorizonTier,
} from '../src/services/horizon';

const LIMIT = Number(process.env.BT_LIMIT ?? 1000);
/** Decide at this fraction of the window's own length before expiry. */
const LEAD_FRACTION = Number(process.env.BT_LEAD_FRAC ?? 0.5);
/** Settled windows a class needs before its verdict is allowed to promote it out
 *  of `provisional`. At n=40 a genuinely useless model has roughly a 1-in-6 shot
 *  at beating the base rate by chance; below that a verdict is noise wearing a
 *  number. The 1h class already produced a Brier reading on n=11 — small enough
 *  that either direction was meaningless. */
const MIN_SAMPLES = Number(process.env.BT_MIN_SAMPLES ?? 40);
/** Minutes of 1m-candle history loaded per asset. The DEFAULT (1000 ≈ 17h)
 *  silently starved long classes: a 24h window's decision point sits ~12h
 *  before its expiry, so anything older than a day was skipped as stale and
 *  1h/4h/24h could never accumulate the samples needed to graduate. Deep
 *  training runs raise this via BT_CANDLES. */
const CANDLE_DEPTH = Number(process.env.BT_CANDLES ?? 1000);

interface Candle {
  ts: number;
  close: number;
}

function closeAsOf(candles: Candle[], tsSec: number, maxStaleSec = 180): number | undefined {
  const target = tsSec * 1000;
  let best: Candle | undefined;
  for (const c of candles) {
    if (c.ts + 60_000 <= target) best = c;
    else break;
  }
  if (!best) return undefined;
  if (target - (best.ts + 60_000) > maxStaleSec * 1000) return undefined;
  return best.close;
}

function scaleReference(raw: string, spot: number): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  let best: number | undefined;
  let bestRatio = Infinity;
  for (const exp of [0, 1, 2, 3, 4, 6, 8, 18]) {
    const c = n / 10 ** exp;
    const r = Math.abs(Math.log(c / spot));
    if (r < bestRatio) {
      bestRatio = r;
      best = c;
    }
  }
  return best !== undefined && bestRatio <= Math.log(5) ? best : undefined;
}

async function main(): Promise<void> {
  const ex = getExchange();
  const rows = (await ex.client.listBinaryMarkets({
    status: 'Finalized',
    limit: LIMIT,
  } as never)) as Array<Record<string, any>>;

  const usable = rows.filter(
    (r) => r.winningOutcome !== null && r.winningOutcome !== undefined && !r.voided && r.expiry,
  );
  console.log(`finalized windows: ${rows.length}, usable: ${usable.length}`);

  const counts = new Map<number, number>();
  for (const r of usable) {
    const s = windowClass(Number(r.intervalSec ?? 0), 0);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  console.log('available by interval:');
  [...counts.entries()].sort((a, b) => a[0] - b[0]).forEach(([s, n]) => console.log(`   ${horizonLabel(s).padStart(5)}: ${n}`));

  const needOpening = usable.filter((r) => String(r.strike) === '0');
  const opens: Record<string, string | null> = {};
  // Batch: the indexer chokes on very large id lists.
  for (let i = 0; i < needOpening.length; i += 100) {
    const chunk = needOpening.slice(i, i + 100).map((r) => String(r.marketId));
    Object.assign(opens, await ex.client.getOpeningPrices(chunk));
  }

  const candles = new Map<string, Candle[]>();
  for (const asset of [...new Set(usable.map((r) => String(r.asset)))]) {
    candles.set(asset, await recentCandles(asset, CANDLE_DEPTH));
    console.log(`  ${asset}: ${candles.get(asset)!.length} x 1m candles loaded (depth ${CANDLE_DEPTH})`);
  }

  const byInterval = new Map<number, Array<{ p: number; won: boolean }>>();

  for (const r of usable) {
    // Group by the SAME class definition the agent uses, or clock-skewed rows
    // (a 15m window recorded as 14.97m) fragment into singleton classes that can
    // never reach MIN_SAMPLES and so can never graduate out of `provisional`.
    const interval = windowClass(Number(r.intervalSec ?? 0), 0);
    if (interval <= 0) continue;
    const asset = String(r.asset);
    const cs = candles.get(asset) ?? [];
    const expiry = Number(r.expiry);
    const isOpen = String(r.strike) === '0';
    const rawRef = isOpen ? opens[String(r.marketId)] : String(r.strike);
    if (!rawRef) continue;

    const lead = Math.max(60, Math.round(interval * LEAD_FRACTION));
    const decideAt = expiry - lead;
    const tradingStart = Number(r.tradingStart ?? 0);
    if (tradingStart > 0 && decideAt < tradingStart) continue; // window not open yet

    const spot = closeAsOf(cs, decideAt);
    if (spot === undefined) continue;
    const prior = cs.filter((c) => c.ts + 60_000 <= decideAt * 1000).map((c) => c.close);
    if (prior.length < 20) continue;
    const vol = horizonVolatility(prior, lead / 60);
    if (!vol) continue;
    const ref = scaleReference(String(rawRef), spot);
    if (ref === undefined) continue;

    const sigma = vol.sigma;
    const p = normalCdf((Math.log(spot / ref) - 0.5 * sigma * sigma) / sigma);
    const arr = byInterval.get(interval) ?? [];
    arr.push({ p, won: Number(r.winningOutcome) === 0 });
    byInterval.set(interval, arr);
  }

  console.log(`\n== calibration by window class (lead = ${LEAD_FRACTION} x interval) ==`);
  console.log('  class    n     Brier    base    verdict            mean|p-actual| by band');
  const verdicts: Array<{ interval: number; ok: boolean; n: number }> = [];
  const measured: CalibrationRow[] = [];
  const row = (
    classSec: number,
    n: number,
    brier: number,
    base: number,
    calErr: number,
    tier: HorizonTier,
    note: string,
  ): void => {
    measured.push({ classSec, n, brier, base, calErr, tier, note });
  };

  for (const [interval, preds] of [...byInterval.entries()].sort((a, b) => a[0] - b[0])) {
    if (preds.length < 10) {
      console.log(`  ${horizonLabel(interval).padStart(5)} ${String(preds.length).padStart(5)}     (too few samples to judge)`);
      verdicts.push({ interval, ok: false, n: preds.length });
      row(interval, preds.length, Number.NaN, Number.NaN, Number.NaN, 'provisional',
        `only ${preds.length} settled window(s) scored - not enough to judge either way`);
      continue;
    }
    const brier = preds.reduce((a, x) => a + (x.p - (x.won ? 1 : 0)) ** 2, 0) / preds.length;
    const base = preds.filter((x) => x.won).length / preds.length;
    const brierBase = preds.reduce((a, x) => a + (base - (x.won ? 1 : 0)) ** 2, 0) / preds.length;

    // Calibration error: average |predicted - actual| across populated bands.
    const bands = [0, 0.15, 0.35, 0.65, 0.85, 1.001];
    let errSum = 0;
    let errN = 0;
    for (let i = 0; i < bands.length - 1; i++) {
      const inBand = preds.filter((x) => x.p >= bands[i]! && x.p < bands[i + 1]!);
      if (inBand.length < 5) continue;
      const avgP = inBand.reduce((a, b) => a + b.p, 0) / inBand.length;
      const rate = inBand.filter((x) => x.won).length / inBand.length;
      errSum += Math.abs(avgP - rate);
      errN++;
    }
    const calErr = errN ? errSum / errN : NaN;
    // Graduation gate. This verdict is what promotes a class out of `provisional`
    // in services/horizon.ts, so it has to require evidence and not just a
    // favourable coin sequence. Three conditions, all necessary:
    //   n >= MIN_SAMPLES  — a class that beats baseline on 11 windows has told us
    //                       nothing; the 1h class did exactly that at n=11.
    //   brier < base      — the model must beat simply predicting the base rate.
    //   calErr < 0.15     — and its stated probabilities must mean something, or
    //                       a good Brier is just a lucky directional call.
    const enoughData = preds.length >= MIN_SAMPLES;
    const ok = enoughData && brier < brierBase && (Number.isNaN(calErr) || calErr < 0.15);
    verdicts.push({ interval, ok, n: preds.length });
    const verdict = ok
      ? 'VALIDATED     '
      : !enoughData
        ? `need ${MIN_SAMPLES - preds.length} more  `
        : 'not tradeable ';

    // Write the tier the agent will actually load. Note the middle case: a class
    // that BEATS the base rate but is poorly calibrated is not thrown away, it is
    // demoted to provisional. Its direction is informative even though its stated
    // probabilities are not, and 2x edge / 0.5x size is the right way to hold that.
    const tier: HorizonTier = ok
      ? 'validated'
      : !enoughData
        ? 'provisional'
        : brier >= brierBase
          ? 'blocked'
          : 'provisional';
    const why = ok
      ? `Brier ${brier.toFixed(4)} vs ${brierBase.toFixed(4)} base rate, calibration error ${calErr.toFixed(3)}, n=${preds.length}`
      : !enoughData
        ? `n=${preds.length} of ${MIN_SAMPLES} needed to judge`
        : brier >= brierBase
          ? `Brier ${brier.toFixed(4)} is no better than the ${brierBase.toFixed(4)} base rate over n=${preds.length}`
          : `beats the base rate (${brier.toFixed(4)} vs ${brierBase.toFixed(4)}) but calibration error ${calErr.toFixed(3)} exceeds 0.15, n=${preds.length}`;
    row(interval, preds.length, brier, brierBase, calErr, tier, why);
    console.log(
      `  ${horizonLabel(interval).padStart(5)} ${String(preds.length).padStart(5)}   ${brier.toFixed(4)}  ${brierBase.toFixed(4)}   ` +
        `${verdict}     ${Number.isNaN(calErr) ? 'n/a' : calErr.toFixed(3)}`,
    );
  }

  const good = verdicts.filter((v) => v.ok).map((v) => v.interval);
  console.log('\nverdict:');
  if (good.length === 0) console.log('  no window class is currently validated');
  else {
    console.log(`  validated classes: ${good.map(horizonLabel).join(', ')}`);
    console.log(
      `  every other class still trades PROVISIONALLY (2x edge bar, 0.5x stake) — ` +
        `see src/services/horizon.ts`,
    );
    const near = verdicts.filter((v) => !v.ok && v.n > 0 && v.n < MIN_SAMPLES);
    if (near.length > 0) {
      console.log(
        `  awaiting samples : ${near.map((v) => `${horizonLabel(v.interval)} (n=${v.n}/${MIN_SAMPLES})`).join(', ')}`,
      );
    }
  }

  const doc: CalibrationFile = {
    generatedAt: new Date().toISOString(),
    leadFraction: LEAD_FRACTION,
    minSamples: MIN_SAMPLES,
    windowsScored: usable.length,
    classes: measured.sort((a, b) => a.classSec - b.classSec),
  };
  writeFileSync(CALIBRATION_PATH, `${JSON.stringify(doc, null, 2)}
`);
  resetCalibrationCache();
  console.log(`
wrote ${measured.length} class verdict(s) to ${CALIBRATION_PATH}`);
  console.log('  the agent reads this file on its next cycle - no restart needed');
  for (const m of doc.classes) {
    console.log(`  ${horizonLabel(m.classSec).padStart(5)}  ${m.tier.padEnd(11)}  ${m.note}`);
  }

  await closeAndExit(0);
}

main().catch(async (e) => {
  console.error('failed:', (e as Error).message);
  await closeAndExit(1);
});
