#!/usr/bin/env tsx
/** Settlement-rule audit v2 for absolute-strike windows.
 *
 *  v1 tried the indexer `lastPrice` field as the oracle settlement print —
 *  it is NOT one (values are inconsistent with spot magnitude), so that path
 *  is abandoned.
 *
 *  This version measures the DISTANCE PROFILE of errors: apply the rule
 *  "YES iff candle-final >= question-strike" and bucket correctness by how
 *  far the final sat from the strike.
 *    - errors clustered within ~0.10% of the strike -> the RULE is right and
 *      the candle feed diverges from the settling oracle near the money;
 *    - errors spread across all distances -> we genuinely misunderstand what
 *      the window settles against.
 *  Read-only. */
import { closeAndExit, getExchange } from '../src/services/sdk';

const LIMIT = Number(process.env.BT_LIMIT ?? 200);

interface Candle {
  ts: number;
  close: number;
}

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

  const strikeRows = rows.filter(
    (r) =>
      String(r.strike) !== '0' &&
      r.winningOutcome !== null &&
      r.winningOutcome !== undefined &&
      !r.voided &&
      r.expiry,
  );

  const assets = [...new Set(strikeRows.map((r) => String(r.asset)))];
  const candleCache = new Map<string, Candle[]>();
  for (const asset of assets) {
    const ohlcv = (await ex.fetchPriceOHLCV(asset, '1m', undefined, 1000)) as Array<
      [number, number, number, number, number, number]
    >;
    candleCache.set(
      asset,
      (ohlcv ?? [])
        .map((c) => ({ ts: Number(c[0]), close: Number(c[4]) }))
        .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.close) && c.close > 0)
        .sort((a, b) => a.ts - b.ts),
    );
  }

  const bands = [
    { label: '<=0.02%', max: 0.0002 },
    { label: '0.02-0.05%', max: 0.0005 },
    { label: '0.05-0.10%', max: 0.001 },
    { label: '0.10-0.30%', max: 0.003 },
    { label: '>0.30%', max: Infinity },
  ];
  const stats = bands.map((b) => ({ ...b, right: 0, wrong: 0 }));
  let skipped = 0;
  const samples: string[] = [];

  for (const r of strikeRows) {
    const q = String(r.question ?? r.info?.question ?? '');
    const m = /at or above\s([\d,.]+)\s+at unix/i.exec(q);
    if (!m) {
      skipped++;
      continue;
    }
    const reference = Number(m[1]!.replace(/,/g, ''));
    const final = priceAt(candleCache.get(String(r.asset)) ?? [], Number(r.expiry));
    if (final === undefined || !(reference > 0)) {
      skipped++;
      continue;
    }

    const delta = Math.abs(final - reference) / reference;
    const predicted = final >= reference ? 0 : 1;
    const actual = Number(r.winningOutcome);
    const ok = predicted === actual;
    const band = stats.find((b) => delta <= b.max)!;
    if (ok) band.right++;
    else {
      band.wrong++;
      if (samples.length < 8)
        samples.push(
          `${String(r.asset)} final=${final.toFixed(2)} strike=${reference.toFixed(2)} d=${(delta * 100).toFixed(3)}% -> predicted ${predicted === 0 ? 'YES' : 'NO'} actual ${actual === 0 ? 'YES' : 'NO'}`,
        );
    }
  }

  console.log('== strike-window hindsight by |candle-final - question-strike| ==\n');
  let totR = 0;
  let totW = 0;
  for (const b of stats) {
    const t = b.right + b.wrong;
    if (t === 0) {
      console.log(`  ${b.label.padEnd(12)}  n=0`);
      continue;
    }
    totR += b.right;
    totW += b.wrong;
    console.log(
      `  ${b.label.padEnd(12)}  n=${String(t).padStart(3)}  correct=${((b.right / t) * 100).toFixed(1)}%`,
    );
  }
  if (totR + totW > 0)
    console.log(`\n  overall: ${((totR / (totR + totW)) * 100).toFixed(1)}% correct on ${totR + totW}`);
  if (skipped) console.log(`  (${skipped} rows skipped: no question text / no candle cover)`);
  if (samples.length) {
    console.log('\n  sample mismatches:');
    samples.forEach((s) => console.log(`    ${s}`));
  }
  console.log('\ninterpretation:');
  console.log('  clustered <=0.05-0.10% -> rule correct; candle-vs-oracle divergence');
  console.log('    flips near-the-money windows (backtest artifact, live agent uses');
  console.log('    oracle spot so is unaffected).');
  console.log('  spread across all bands -> settlement semantics genuinely misunderstood.');
}

void main()
  .then(() => closeAndExit(0))
  .catch(async (err) => {
    console.error('settle-audit failed:', (err as Error).message);
    await closeAndExit(1);
  });
