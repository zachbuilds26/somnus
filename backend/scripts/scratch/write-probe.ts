#!/usr/bin/env tsx
/** One-off write-path probe: fresh process, force-reloaded trading client,
 *  smallest possible IOC order on the freshest liquid window.
 *  DRY_RUN must be false; set PROBE_YES=1 to actually send. Read-only otherwise. */
import { closeAndExit, getTradingExchangeReady, listEventMarketRows } from '../src/services/sdk';
import { config } from '../src/config';

async function main(): Promise<void> {
  console.log(`dryRun(env)=${config.dryRun} mode(saved)=see config file`);
  // The header promises this gate: without PROBE_YES=1 this is a read-only
  // rehearsal that resolves a window and stops. Sending a real order takes an
  // explicit opt-in on top of DRY_RUN=false, so a stray `npx tsx` never spends.
  if (process.env.PROBE_YES !== '1') {
    const rows = await listEventMarketRows();
    const target = rows.find((r) => r.symbol.includes('BTC') && r.expiry && r.expiry > Date.now() / 1000 + 120);
    console.log(`probe window: ${target?.symbol ?? '(none found)'}`);
    console.log('read-only rehearsal — set PROBE_YES=1 (with DRY_RUN=false) to actually send.');
    return;
  }
  const ex = await getTradingExchangeReady(true);
  const rows = await listEventMarketRows();
  const target = rows.find((r) => r.symbol.includes('BTC') && r.expiry && r.expiry > Date.now() / 1000 + 120);
  if (!target) throw new Error('no candidate window');
  console.log(`probe window: ${target.symbol}`);
  console.log('attempting createOrder 1 contract @ 0.05 …');
  const order = (await ex.createOrder(target.symbol, 'limit', 'buy', 1, 0.05, {
    timeInForce: 'IOC',
  })) as Record<string, any>;
  const receipt = order?.info?.receipt;
  console.log(`status=${order?.status} tx=${receipt?.transactionHash ?? '(none)'}`);
}

void main()
  .then(() => closeAndExit(0))
  .catch(async (err) => {
    console.error('PROBE FAILED:', (err as Error).message);
    await closeAndExit(1);
  });
