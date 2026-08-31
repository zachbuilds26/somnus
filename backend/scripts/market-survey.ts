#!/usr/bin/env tsx
/** Survey every window class DreamDEX offers: which periods exist, how many
 *  settle, and which carry the most actual trading activity.
 *
 *  Answers two different questions people conflate:
 *   - what is the LONGEST period available?
 *   - which period is the most ACTIVE (volume / trade count)?
 */
import { closeAndExit, getExchange } from '../src/services/sdk';

function label(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return 'unknown';
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

interface Agg {
  count: number;
  trades: number;
  volume: number;
  assets: Set<string>;
}

function aggregate(rows: Array<Record<string, any>>): Map<number, Agg> {
  const by = new Map<number, Agg>();
  for (const r of rows) {
    const raw = Number(r.intervalSec ?? 0);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    // Some rows carry a fractional interval (e.g. 14.97m) from clock skew —
    // round to the nearest minute so classes don't fragment.
    const sec = raw < 60 ? raw : Math.round(raw / 60) * 60;
    const a = by.get(sec) ?? { count: 0, trades: 0, volume: 0, assets: new Set<string>() };
    a.count++;
    a.trades += Number(r.tradeCount ?? 0);
    // Quote volume is in collateral raw units (6dp on testnet tUSDC).
    a.volume += Number(r.cumulativeQuoteVolume ?? 0) / 1e6;
    if (r.asset) a.assets.add(String(r.asset));
    by.set(sec, a);
  }
  return by;
}

async function main(): Promise<void> {
  const ex = getExchange();

  const active = (await ex.client.listBinaryMarkets({ status: 'Trading', limit: 500 } as never)) as Array<
    Record<string, any>
  >;
  const done = (await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 1000 } as never)) as Array<
    Record<string, any>
  >;

  console.log(`live windows: ${active.length} | settled sample: ${done.length}\n`);

  const A = aggregate(active);
  const D = aggregate(done);
  const periods = [...new Set([...A.keys(), ...D.keys()])].sort((a, b) => a - b);

  console.log('period   live   settled   totalTrades   totalVolume(tUSDC)   avgTrades/window   assets');
  console.log('-'.repeat(96));
  for (const p of periods) {
    const a = A.get(p);
    const d = D.get(p);
    const trades = (a?.trades ?? 0) + (d?.trades ?? 0);
    const vol = (a?.volume ?? 0) + (d?.volume ?? 0);
    const windows = (a?.count ?? 0) + (d?.count ?? 0);
    const assets = new Set([...(a?.assets ?? []), ...(d?.assets ?? [])]);
    console.log(
      `${label(p).padStart(6)}  ${String(a?.count ?? 0).padStart(5)}   ${String(d?.count ?? 0).padStart(7)}   ` +
        `${String(trades).padStart(11)}   ${vol.toFixed(2).padStart(18)}   ${(windows ? trades / windows : 0)
          .toFixed(1)
          .padStart(16)}   ${[...assets].join(',')}`,
    );
  }

  console.log('-'.repeat(96));
  const longest = periods[periods.length - 1];
  let busiestByVolume = periods[0];
  let busiestByTrades = periods[0];
  let bestVol = -1;
  let bestTr = -1;
  for (const p of periods) {
    const vol = (A.get(p)?.volume ?? 0) + (D.get(p)?.volume ?? 0);
    const tr = (A.get(p)?.trades ?? 0) + (D.get(p)?.trades ?? 0);
    if (vol > bestVol) {
      bestVol = vol;
      busiestByVolume = p;
    }
    if (tr > bestTr) {
      bestTr = tr;
      busiestByTrades = p;
    }
  }
  console.log(`\nlongest period offered : ${label(longest!)}`);
  console.log(`most volume            : ${label(busiestByVolume!)}  (${bestVol.toFixed(2)} tUSDC)`);
  console.log(`most trades            : ${label(busiestByTrades!)}  (${bestTr})`);

  await closeAndExit(0);
}

main().catch(async (e) => {
  console.error('failed:', (e as Error).message);
  await closeAndExit(1);
});
