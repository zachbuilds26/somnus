#!/usr/bin/env tsx
// Straight live — no dryRun, real testnet tx.
// 2 x 5m windows, $5 each.

process.env.FAIR_OVERRIDE_BTC = process.env.FAIR_OVERRIDE_BTC ?? '0.68';
process.env.FAIR_OVERRIDE_ETH = process.env.FAIR_OVERRIDE_ETH ?? '0.32';
process.env.AGENT_MAX_HORIZON_SEC = '300';

const { runCycle } = await import('../src/services/agent');
const { closeExchanges, nativeGasBalance, getSignerAddress } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig, effectiveDryRun } = await import('../src/agent-config');

async function main() {
  const before = loadAgentConfig();
  console.log('before config:', before);
  console.log('effectiveDryRun before:', effectiveDryRun(before));

  // Force live: DRY_RUN must be false in env + mode live
  // Ensure env is false (it already is in .env, but double-check process.env)
  process.env.DRY_RUN = 'false';
  const liveCfg = { ...before, mode: 'live' as const, maxTradeSize: 5, minEdge: 0.05, maxOrdersPerCycle: 2, tradeQuota: 2, tradingPaused: false };
  // clear pauseReason if was paused
  delete (liveCfg as any).pauseReason;
  delete (liveCfg as any).pausedAt;
  saveAgentConfig(liveCfg);

  const after = loadAgentConfig();
  console.log('live config set:', after);
  console.log('effectiveDryRun after:', effectiveDryRun(after));

  const signer = getSignerAddress();
  console.log('signer:', signer);
  const gas = await nativeGasBalance();
  console.log('gas STT:', gas !== undefined ? `${Number(gas)/1e18}` : 'unknown');

  const rows = await import('../src/services/sdk').then(m => m.listEventMarketRows());
  console.log(`markets: ${rows.length}, tradeable 5m:`, rows.filter(r => r.intervalSec===300).length);

  console.log('');
  console.log('== LIVE 2x 5m @ $5 ==');
  console.log(`FAIR_OVERRIDE_BTC=${process.env.FAIR_OVERRIDE_BTC} ETH=${process.env.FAIR_OVERRIDE_ETH}`);

  const out = await runCycle({ maxTrades: 2, maxTradeSize: 5 });

  console.log('');
  console.log(`decisions: ${out.decisions.length}`);
  for (const d of out.decisions) {
    console.log(`  ${d.symbol} fair ${d.fair} ask ${d.ask} bid ${d.bid} edge ${d.edge.toFixed(3)} action ${d.action} size ${d.size} horizon ${d.horizon}`);
  }

  console.log('');
  console.log(`orders: ${out.orders.length}`);
  for (const o of out.orders) {
    console.log(`  ${o.symbol} price ${o.price} size ${o.size} status ${o.status} dryRun ${o.dryRun} tx ${o.txHash ?? '-'} // ${o.reason}`);
  }

  if (out.errors.length) console.log('errors:', out.errors);
  else console.log('no cycle errors');

  console.log(`books: ${out.books.length}`);

  // Do NOT auto-restore — leave live config so you can see it
  console.log('');
  console.log('proof entries now:', (await import('../src/services/store')).count());
  console.log('pnl:', (await import('../src/services/pnl')).pnlSummary());

  await closeExchanges();
  await new Promise(r => setTimeout(r, 400));
  process.exit(0);
}

main().catch(async e => {
  console.error('live failed:', e);
  await closeExchanges().catch(()=>{});
  process.exit(1);
});
