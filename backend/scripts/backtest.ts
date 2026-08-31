#!/usr/bin/env tsx
/** Backtest / diagnostic against SETTLED windows.
 *
 *  Two questions, in order:
 *
 *  1. HINDSIGHT: given the ACTUAL final price, does our rule
 *     (`YES wins iff final >= reference`) pick the real winner? This tests our
 *     understanding of settlement, not our forecasting. Anything below ~95% here
 *     means the reference level or the comparison is wrong, and forecast quality
 *     is irrelevant until it's fixed.
 *
 *  2. FORECAST: what would the model have said before expiry, and how often was
 *     it right? Only meaningful once (1) passes.
 */
import { getExchange, closeAndExit } from '../src/services/sdk';
import { referenceLevel } from '../src/services/signal';
import type { EventMarketRow } from '../src/services/sdk';

const LIMIT = Number(process.env.BT_LIMIT ?? 200);

interface Candle {
  ts: number; // ms
  close: number;
}

async function candlesFor(asset: string): Promise<Candle[]> {
  const ex = getExchange();
  const rows = (await ex.fetchPriceOHLCV(asset, '1m', undefined, 1000)) as Array<
    [number, number, number, number, number, number]
  >;
  return (rows ?? []).map((r) => ({ ts: Number(r[0]), close: Number(r[4]) })).sort((a, b) => a.ts - b.ts);
}

/** Close of the candle covering `tsSec`, or the nearest earlier one. */
function priceAt(candles: Candle[], tsSec: number): number | undefined {
  const target = tsSec * 1000;
  let best: number | undefined;
  for (const c of candles) {
    if (c.ts <= target) best = c.close;
    else break;
  }
  return best;
}

async function main(): Promise<void> {
  const ex = getExchange();
  const rows = (await ex.client.listBinaryMarkets({
    status: 'Finalized',
    limit: LIMIT,
  } as never)) as Array<Record<string, any>>;

  const settled = rows.filter(
    (r) => r.winningOutcome !== null && r.winningOutcome !== undefined && !r.voided && r.expiry,
  );
  console.log(`finalized windows fetched: ${rows.length}, usable: ${settled.length}`);

  // Opening prices for the vs-open windows.
  const needOpening = settled.filter((r) => String(r.strike) === '0');
  const opens: Record<string, string | null> = needOpening.length
    ? ((await ex.client.getOpeningPrices(needOpening.map((r) => String(r.marketId)))) as Record<
        string,
        string | null
      >)
    : {};

  const candleCache = new Map<string, Candle[]>();
  for (const asset of [...new Set(settled.map((r) => String(r.asset)))]) {
    candleCache.set(asset, await candlesFor(asset));
    console.log(`  ${asset}: ${candleCache.get(asset)!.length} 1m candles`);
  }

  let hindsightRight = 0;
  let hindsightWrong = 0;
  let noData = 0;
  const wrongSamples: string[] = [];
  const byKind = { strike: { r: 0, w: 0 }, open: { r: 0, w: 0 } };

  for (const r of settled) {
    const asset = String(r.asset);
    const candles = candleCache.get(asset) ?? [];
    const expiry = Number(r.expiry);
    const final = priceAt(candles, expiry);
    if (final === undefined) {
      noData++;
      continue;
    }

    const isOpen = String(r.strike) === '0';
    const row = {
      strikeRaw: String(r.strike),
      openingRaw: opens[String(r.marketId)] ?? undefined,
    } as EventMarketRow;
    const reference = referenceLevel(row, final);
    if (reference === undefined) {
      noData++;
      continue;
    }

    // Our rule: YES (outcome 0) wins iff final >= reference.
    const predicted = final >= reference ? 0 : 1;
    const actual = Number(r.winningOutcome);
    const bucket = isOpen ? byKind.open : byKind.strike;
    if (predicted === actual) {
      hindsightRight++;
      bucket.r++;
    } else {
      hindsightWrong++;
      bucket.w++;
      if (wrongSamples.length < 8) {
        wrongSamples.push(
          `${asset} ${isOpen ? 'vs-open' : 'strike '} final=${final.toFixed(2)} ref=${reference.toFixed(2)} ` +
            `-> predicted ${predicted === 0 ? 'YES' : 'NO'}, actual ${actual === 0 ? 'YES' : 'NO'}`,
        );
      }
    }
  }

  const total = hindsightRight + hindsightWrong;
  console.log('\n== HINDSIGHT TEST (actual final price -> actual winner) ==');
  console.log(`  usable: ${total}  (skipped ${noData} for missing price/reference)`);
  if (total > 0) {
    console.log(`  correct: ${hindsightRight}  (${((hindsightRight / total) * 100).toFixed(1)}%)`);
    console.log(`  wrong  : ${hindsightWrong}`);
    console.log(`  by kind: strike ${byKind.strike.r}/${byKind.strike.r + byKind.strike.w} correct, ` +
      `vs-open ${byKind.open.r}/${byKind.open.r + byKind.open.w} correct`);
  }
  if (wrongSamples.length) {
    console.log('\n  sample mismatches:');
    wrongSamples.forEach((s) => console.log(`    ${s}`));
  }

  console.log('\ninterpretation:');
  if (total === 0) console.log('  no usable samples — cannot conclude');
  else if (hindsightRight / total > 0.95)
    console.log('  settlement rule understood correctly -> the problem is FORECAST quality');
  else if (hindsightRight / total < 0.2)
    console.log('  rule is INVERTED -> YES/NO mapping or comparison is backwards');
  else console.log('  rule is unreliable -> reference level is wrong for some window kinds');

  await closeAndExit(0);
}

main().catch(async (e) => {
  console.error('backtest failed:', (e as Error).message);
  await closeAndExit(1);
});
