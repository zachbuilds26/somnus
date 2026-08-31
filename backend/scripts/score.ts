#!/usr/bin/env tsx
/** Score simulated (dry-run) trades against actual settlement.
 *
 *  The real test of a signal: compare wins against EXPECTED wins from the prices
 *  paid. In a fair market the price IS the probability, so sum(price) is what a
 *  coin-flipping bettor would achieve. Beating it is edge; missing it is bias.
 *
 *  Usage: npm run score            # all simulated trades
 *         BT_SINCE=<iso> npm run score
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/config';
import { closeAndExit, getExchange } from '../src/services/sdk';

const SINCE = process.env.BT_SINCE ? Date.parse(process.env.BT_SINCE) : 0;

interface Ord {
  symbol: string;
  marketId?: string;
  price: number;
  size: number;
  ts: number;
  status: string;
  dryRun: boolean;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Recover (asset, strike, expirySec, side) from an outcome symbol such as
 *  `BTC-7898146-25AUG26-0005/tUSDC#YES` or `ETH-0-25AUG26-0400-88CD/tUSDC#NO`. */
function parseSymbol(sym: string): { asset: string; strike: string; expiry: number; side: 0 | 1 } | undefined {
  const side: 0 | 1 = sym.toUpperCase().endsWith('#YES') ? 0 : 1;
  const head = sym.split('/')[0] ?? '';
  const parts = head.split('-');
  if (parts.length < 4) return undefined;
  const [asset, strike, date, time] = parts;
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(String(date).toUpperCase());
  if (!m || !time || !/^\d{4}$/.test(time)) return undefined;
  const day = Number(m[1]);
  const mon = MONTHS[m[2]!];
  const year = 2000 + Number(m[3]);
  if (mon === undefined) return undefined;
  const expiry = Math.floor(
    Date.UTC(year, mon, day, Number(time.slice(0, 2)), Number(time.slice(2, 4))) / 1000,
  );
  return { asset: String(asset), strike: String(strike), expiry, side };
}

async function main(): Promise<void> {
  const file = join(DATA_DIR, 'proof-chain.jsonl');
  const orders: Ord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind !== 'order') continue;
      const p = e.payload;
      if (p?.status !== 'simulated' && p?.status !== 'submitted') continue;
      if (p.ts < SINCE) continue;
      orders.push(p as Ord);
    } catch {
      /* torn line */
    }
  }
  console.log(`orders considered: ${orders.length} (simulated + submitted)`);

  const ex = getExchange();
  const rows = (await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 1000 } as never)) as Array<
    Record<string, any>
  >;
  const byId = new Map<string, Record<string, any>>();
  const byKey = new Map<string, Record<string, any>>();
  for (const r of rows) {
    byId.set(String(r.marketId), r);
    byKey.set(`${r.asset}|${r.strike}|${r.expiry}`, r);
  }

  let won = 0;
  let lost = 0;
  let unsettled = 0;
  let unmatched = 0;
  const prices: number[] = [];
  const detail: string[] = [];

  for (const o of orders) {
    let mkt = o.marketId ? byId.get(o.marketId) : undefined;
    let side: 0 | 1 | undefined;
    const parsed = parseSymbol(o.symbol);
    if (parsed) side = parsed.side;
    if (!mkt && parsed) mkt = byKey.get(`${parsed.asset}|${parsed.strike}|${parsed.expiry}`);
    if (!mkt || side === undefined) {
      if (parsed && parsed.expiry * 1000 > Date.now()) unsettled++;
      else unmatched++;
      continue;
    }
    if (mkt.winningOutcome === null || mkt.winningOutcome === undefined) {
      unsettled++;
      continue;
    }
    const isWin = Number(mkt.winningOutcome) === side;
    prices.push(o.price);
    if (isWin) won++;
    else lost++;
    if (detail.length < 14) {
      detail.push(
        `  ${String(mkt.asset).padEnd(4)} ${side === 0 ? 'YES' : 'NO '} @ ${o.price.toFixed(3)}  ` +
          `${isWin ? 'WON ' : 'lost'}  interval=${mkt.intervalSec}s`,
      );
    }
  }

  console.log(`\nmatched & settled: ${won + lost}   (unsettled ${unsettled}, unmatched ${unmatched})`);
  detail.forEach((d) => console.log(d));

  const n = prices.length;
  if (n === 0) {
    console.log('\nnothing settled yet — re-run later');
    await closeAndExit(0);
    return;
  }
  const expected = prices.reduce((a, b) => a + b, 0);
  const variance = prices.reduce((a, q) => a + q * (1 - q), 0);
  const sd = Math.sqrt(variance);
  const z = sd > 0 ? (won - expected) / sd : 0;

  console.log('\n== score ==');
  console.log(`  trades settled : ${n}`);
  console.log(`  wins           : ${won}   (win rate ${((won / n) * 100).toFixed(1)}%)`);
  console.log(`  avg price paid : ${(expected / n).toFixed(3)}`);
  console.log(`  EXPECTED wins  : ${expected.toFixed(2)}  <- what the prices imply`);
  console.log(`  z-score        : ${z.toFixed(2)}`);
  console.log('');
  if (z > 1) console.log('  -> beating the market');
  else if (z > -1) console.log('  -> in line with the market (no measurable edge either way)');
  else if (z > -2) console.log('  -> underperforming, not yet conclusive');
  else console.log('  -> SYSTEMATICALLY WORSE than the prices paid');

  await closeAndExit(0);
}

main().catch(async (e) => {
  console.error('failed:', (e as Error).message);
  await closeAndExit(1);
});
