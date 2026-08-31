delete process.env.FAIR_OVERRIDE_BTC;
delete process.env.FAIR_OVERRIDE_ETH;
process.env.AGENT_MAX_HORIZON_SEC = '300';
process.env.DRY_RUN = 'false';

const { runCycle } = await import('../src/services/agent');
const { closeExchanges, listEventMarketRows, nativeGasBalance, getSignerAddress } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig, effectiveDryRun } = await import('../src/agent-config');

async function main(){
  const before = loadAgentConfig();
  const liveCfg = { ...before, mode: 'live' as const, maxTradeSize: 33, minEdge: 0.03, maxOrdersPerCycle: 3, tradeQuota: 3, maxPerMarket: 1, tradingPaused:false };
  delete (liveCfg as any).pauseReason; delete (liveCfg as any).pausedAt;
  saveAgentConfig(liveCfg);
  console.log('live cfg', liveCfg, 'effectiveDryRun', effectiveDryRun(liveCfg));
  console.log('signer', getSignerAddress(), 'gas STT', (await nativeGasBalance())!=null? Number(await nativeGasBalance())/1e18 : 'unknown');

  const rows = await listEventMarketRows();
  console.log(`markets ${rows.length} 5m ${rows.filter(r=>r.intervalSec===300).length}`);

  console.log('\n== LIVE 3x 5m @ $33 real model ==');
  const out = await runCycle({ maxTrades: 3, maxTradeSize: 33, minEdge: 0.03 });
  console.log(`decisions ${out.decisions.length}`);
  for(const d of out.decisions) console.log(`  ${d.symbol} fair ${d.fair.toFixed(3)} mid ${d.mid} ask ${d.ask} bid ${d.bid} edge ${d.edge.toFixed(3)} action ${d.action} size ${d.size} horizon ${d.horizon} tier ${d.horizonTier} reqEdge ${d.requiredEdge} note ${d.pricedNote}`);
  console.log(`\norders ${out.orders.length}`);
  for(const o of out.orders) console.log(`  ${o.symbol} price ${o.price} size ${o.size} status ${o.status} dryRun ${o.dryRun} tx ${o.txHash??'-'} // ${o.reason} retained ${o.retainedEdge}`);
  if(out.errors.length) console.log('errors', out.errors);
  console.log(`books ${out.books.length}`);

  const { pnlSummary } = await import('../src/services/pnl');
  console.log('pnl', pnlSummary());

  await closeExchanges();
  await new Promise(r=>setTimeout(r,400));
  process.exit(0);
}
main().catch(async e=>{console.error(e); const {closeExchanges}=await import('../src/services/sdk'); await closeExchanges().catch(()=>{}); process.exit(1)});
