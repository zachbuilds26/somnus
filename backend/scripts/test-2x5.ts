#!/usr/bin/env tsx
// Dry-run test: 2 x 5m windows, $5 each.
// No keys needed, no real orders sent.

process.env.FAIR_OVERRIDE_BTC = process.env.FAIR_OVERRIDE_BTC ?? '0.68';
process.env.FAIR_OVERRIDE_ETH = process.env.FAIR_OVERRIDE_ETH ?? '0.32';
process.env.AGENT_MAX_HORIZON_SEC = '300';
process.env.DRY_RUN = 'true';

const { runCycle } = await import('../src/services/agent');
const { closeExchanges, listEventMarketRows } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig, effectiveDryRun } = await import('../src/agent-config');

async function main() {
  const before = loadAgentConfig();
  const testCfg = { ...before, mode: 'dry-run' as const, maxTradeSize: 5, minEdge: 0.05, tradeQuota: 2, maxOrdersPerCycle: 2 };
  saveAgentConfig(testCfg);
  console.log('saved config for test:', testCfg);
  console.log('effectiveDryRun:', effectiveDryRun(testCfg));

  const rows = await listEventMarketRows();
  console.log(`pre-cycle markets: ${rows.length} total, first expiry in ${rows[0]?.expiry ? rows[0].expiry - Math.floor(Date.now()/1000) : '?'}s`);

  console.log('');
  console.log('== 2x 5m @ $5 dry-run ==');
  console.log(`FAIR_OVERRIDE_BTC=${process.env.FAIR_OVERRIDE_BTC} ETH=${process.env.FAIR_OVERRIDE_ETH}`);
  console.log('horizon=5m only (AGENT_MAX_HORIZON_SEC=300), maxTrades=2, maxTradeSize=$5, minEdge=0.05');

  const out = await runCycle({ maxTrades: 2, maxTradeSize: 5 });

  console.log(`decisions: ${out.decisions.length}`);
  for (const d of out.decisions.slice(0, 6)) {
    console.log(`  ${d.symbol}  fair ${d.fair} mid ${d.mid} ask ${d.ask} bid ${d.bid} edge ${d.edge.toFixed(3)} action ${d.action} size ${d.size} horizon ${d.horizon} tier ${d.horizonTier} reqEdge ${d.requiredEdge}  // ${d.pricedNote}`);
  }
  if (out.decisions.length > 6) console.log(`  ... and ${out.decisions.length - 6} more`);

  console.log('');
  console.log(`orders: ${out.orders.length} (simulated, not sent)`);
  for (const o of out.orders) {
    console.log(`  ${o.symbol} price ${o.price} size ${o.size} status ${o.status} dryRun ${o.dryRun} retainedEdge ${o.retainedEdge} // ${o.reason}`);
  }

  console.log('');
  if (out.errors.length) console.log('errors:', out.errors);
  else console.log('no cycle errors');

  console.log('');
  console.log(`books read: ${out.books.length}`);
  for (const b of out.books.slice(0, 4)) {
    console.log(`  ${b.symbol} bid ${b.bid} ask ${b.ask} mid ${b.mid}`);
  }

  // restore original quota/mode? keep dry-run for safety
  saveAgentConfig({ ...testCfg, mode: before.mode, tradeQuota: before.tradeQuota });
  console.log('');
  console.log('restored config mode/tradeQuota to before');

  await closeExchanges();
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
}

main().catch(async (e) => {
  console.error('failed:', e);
  await closeExchanges().catch(() => {});
  process.exit(1);
});
