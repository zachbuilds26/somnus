#!/usr/bin/env tsx
/** One-off write-path probe: fresh process, force-reloaded trading client,
 *  smallest possible IOC order on the freshest liquid window.
 *  DRY_RUN must be false; set PROBE_YES=1 to actually send. Read-only otherwise. */
import { closeAndExit, getTradingExchangeReady, listEventMarketRows } from '../src/services/sdk';
import { config } from '../src/config';

async function main(): Promise<void> {
  console.log(`dryRun(env)=${config.dryRun} mode(saved)=see config file`);
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
