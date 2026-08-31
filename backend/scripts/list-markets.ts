import { listEventMarketRows } from '../src/services/sdk';
async function main() {
  const rows = await listEventMarketRows();
  console.log(`${rows.length} markets total\n`);
  console.log('Interval  Asset  Expiry    Bid       Ask       Symbol');
  console.log('--------  -----  --------  --------  --------  ------');
  rows.forEach((r) => {
    const exp = r.expiry ? new Date(r.expiry * 1000).toISOString().replace('T',' ').slice(0,16) : '?';
    const interval = (r.interval ?? '?').padEnd(8);
    const asset = (r.asset ?? '?').padEnd(5);
    const bid = String(r.bid ?? '-').padEnd(8);
    const ask = String(r.ask ?? '-').padEnd(8);
    console.log(`${interval}  ${asset}  ${exp}  ${bid}  ${ask}  ${r.symbol}`);
  });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
