#!/usr/bin/env tsx
/** Calibration backtest on SETTLED windows.
 *
 *  Reconstructs what the model would have said at a fixed lead time before
 *  expiry, using only candles that had closed by then, and compares the
 *  predicted probability against what actually happened.
 *
 *  This is the only test that matters. Agreement with the order book (which I
 *  previously treated as validation) says nothing about whether the predictions
 *  are true. A calibration curve says exactly where and how they are wrong.
 */
import { closeAndExit, getExchange, recentCandles } from '../src/services/sdk';
import { horizonVolatility, normalCdf } from '../src/services/signal';

const LEAD_SEC = Number(process.env.BT_LEAD ?? 60); // decide this long before expiry
const LIMIT = Number(process.env.BT_LIMIT ?? 200);

interface Candle {
  ts: number;
  close: number;
}

/** Close of the candle bucket that ENDS at or before `tsSec`, requiring the
 *  bucket to be recent enough that it isn't stale. Buckets are [ts, ts+60). */
function closeAsOf(candles: Candle[], tsSec: number, maxStaleSec = 120): number | undefined {
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

  const needOpening = usable.filter((r) => String(r.strike) === '0');
  const opens: Record<string, string | null> = needOpening.length
    ? ((await ex.client.getOpeningPrices(needOpening.map((r) => String(r.marketId)))) as Record<string, string | null>)
    : {};

  const candles = new Map<string, Candle[]>();
  for (const asset of [...new Set(usable.map((r) => String(r.asset)))]) {
    candles.set(asset, await recentCandles(asset, 1000));
  }

  // --- Part 1: hindsight. Does our settlement rule pick the real winner? ---
  let hRight = 0;
  let hWrong = 0;
  const byKind = { strike: { r: 0, w: 0 }, open: { r: 0, w: 0 } };

  // --- Part 2: calibration of the forecast ---
  const preds: Array<{ p: number; won: boolean; kind: string }> = [];
  let skippedNotOpen = 0;

  for (const r of usable) {
    const asset = String(r.asset);
    const cs = candles.get(asset) ?? [];
    const expiry = Number(r.expiry);
    const isOpen = String(r.strike) === '0';
    const rawRef = isOpen ? opens[String(r.marketId)] : String(r.strike);
    if (!rawRef) continue;

    const final = closeAsOf(cs, expiry, 90);
    if (final === undefined) continue;
    const reference = scaleReference(String(rawRef), final);
    if (reference === undefined) continue;

    const actual = Number(r.winningOutcome); // 0 = YES
    const hindsight = final >= reference ? 0 : 1;
    const bucket = isOpen ? byKind.open : byKind.strike;
    if (hindsight === actual) {
      hRight++;
      bucket.r++;
    } else {
      hWrong++;
      bucket.w++;
    }

    // Forecast as of LEAD_SEC before expiry, using only prior candles.
    const decideAt = expiry - LEAD_SEC;

    // The window must actually EXIST at the decision time. For a 15-minute
    // window, "decide an hour before expiry" means comparing spot against an
    // opening price that had not been set yet — which fabricates
    // miscalibration out of nothing. Skip rather than score it.
    const tradingStart = Number(r.tradingStart ?? 0);
    if (tradingStart > 0 && decideAt < tradingStart) {
      skippedNotOpen++;
      continue;
    }

    const spot = closeAsOf(cs, decideAt, 120);
    if (spot === undefined) continue;
    const prior = cs.filter((c) => c.ts + 60_000 <= decideAt * 1000).map((c) => c.close);
    if (prior.length < 20) continue;
    const vol = horizonVolatility(prior, LEAD_SEC / 60);
    if (!vol) continue;
    const refAtDecision = scaleReference(String(rawRef), spot);
    if (refAtDecision === undefined) continue;

    const sigma = vol.sigma;
    const p = normalCdf((Math.log(spot / refAtDecision) - 0.5 * sigma * sigma) / sigma);
    preds.push({ p, won: actual === 0, kind: isOpen ? 'vs-open' : 'strike' });
  }

  const hTotal = hRight + hWrong;
  console.log('== HINDSIGHT (actual final price -> actual winner) ==');
  console.log(`  ${hRight}/${hTotal} correct (${hTotal ? ((hRight / hTotal) * 100).toFixed(1) : '0'}%)`);
  console.log(`  strike ${byKind.strike.r}/${byKind.strike.r + byKind.strike.w}  |  vs-open ${byKind.open.r}/${byKind.open.r + byKind.open.w}`);

  console.log(`\n== FORECAST CALIBRATION (${LEAD_SEC}s before expiry, n=${preds.length}) ==`);
  if (preds.length === 0) {
    console.log('  no usable samples');
    await closeAndExit(0);
    return;
  }
  const bands = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.001];
  console.log('  predicted band     n    predicted   actual YES rate');
  for (let i = 0; i < bands.length - 1; i++) {
    const inBand = preds.filter((x) => x.p >= bands[i]! && x.p < bands[i + 1]!);
    if (!inBand.length) continue;
    const avgP = inBand.reduce((a, b) => a + b.p, 0) / inBand.length;
    const rate = inBand.filter((x) => x.won).length / inBand.length;
    const flag = Math.abs(avgP - rate) > 0.2 ? '  <-- MISCALIBRATED' : '';
    console.log(
      `  ${bands[i]!.toFixed(2)}-${bands[i + 1]! > 1 ? '1.00' : bands[i + 1]!.toFixed(2)}      ${String(inBand.length).padStart(4)}     ${avgP.toFixed(3)}        ${rate.toFixed(3)}${flag}`,
    );
  }
  const brier = preds.reduce((a, x) => a + (x.p - (x.won ? 1 : 0)) ** 2, 0) / preds.length;
  const base = preds.filter((x) => x.won).length / preds.length;
  const brierBase = preds.reduce((a, x) => a + (base - (x.won ? 1 : 0)) ** 2, 0) / preds.length;
  console.log(`\n  Brier score: ${brier.toFixed(4)}  (always-guess-base-rate = ${brierBase.toFixed(4)})`);
  console.log(`  ${brier < brierBase ? '-> model beats the base rate' : '-> MODEL IS WORSE THAN GUESSING THE BASE RATE'}`);

  await closeAndExit(0);
}

main().catch(async (e) => {
  console.error('failed:', (e as Error).message);
  await closeAndExit(1);
});
