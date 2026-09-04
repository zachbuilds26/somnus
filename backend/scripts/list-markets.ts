import { listEventMarketRows } from '../src/services/sdk';

/** Print the live Event Contract windows the indexer is currently returning.
 *
 *  Deliberately one network call. This used to print Bid and Ask columns, which was
 *  a lie no compiler was watching for: `EventMarketRow` has never carried a price,
 *  so both columns rendered `-` on every row, forever. Prices need a book read per
 *  market — see `market-survey.ts` for that — so this reports what a single
 *  `loadMarkets` actually knows, and reports it accurately. */
async function main(): Promise<void> {
  const rows = await listEventMarketRows();
  console.log(`${rows.length} markets total\n`);
  console.log('Interval  Asset  Expiry            Symbol');
  console.log('--------  -----  ----------------  ------');
  rows.forEach((r) => {
    const exp = r.expiry
      ? new Date(r.expiry * 1000).toISOString().replace('T', ' ').slice(0, 16)
      : '?';
    const interval = (r.intervalSec ? `${r.intervalSec}s` : '?').padEnd(8);
    const asset = (r.asset ?? '?').padEnd(5);
    console.log(`${interval}  ${asset}  ${exp.padEnd(16)}  ${r.symbol}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error((e as Error).message ?? String(e));
    process.exit(1);
  });
