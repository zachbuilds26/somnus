delete process.env.FAIR_OVERRIDE_BTC;
delete process.env.FAIR_OVERRIDE_ETH;
process.env.AGENT_MAX_HORIZON_SEC='900';
process.env.DRY_RUN='false';
const { runCycle } = await import('../src/services/agent');
const { closeExchanges, listEventMarketRows, nativeGasBalance, getSignerAddress } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig, effectiveDryRun } = await import('../src/agent-config');
async function main(){
  const before=loadAgentConfig();
  const cfg={...before, mode:'live' as const, maxTradeSize:2, minEdge:0.07, maxOrdersPerCycle:1, tradeQuota:1, maxPerMarket:1, tradingPaused:false};
  delete (cfg as any).pauseReason; delete (cfg as any).pausedAt;
  saveAgentConfig(cfg);
  console.log('live cfg',cfg,'effectiveDryRun',effectiveDryRun(cfg));
  console.log('signer',getSignerAddress(),'gas', (await nativeGasBalance())!=null?Number(await nativeGasBalance())/1e18:'?');
  const rows=await listEventMarketRows();
  console.log(`markets ${rows.length} 5m ${rows.filter(r=>r.intervalSec===300).length} 15m ${rows.filter(r=>r.intervalSec===900).length}`);
  console.log('\n== LIVE 1x $2 real model minEdge 0.07 ==');
  const out=await runCycle({maxTrades:1, maxTradeSize:2, minEdge:0.07});
  console.log(`decisions ${out.decisions.length}`);
  for(const d of out.decisions) console.log(`  ${d.symbol} fair ${d.fair.toFixed(3)} mid ${d.mid} ask ${d.ask} bid ${d.bid} edge ${d.edge.toFixed(3)} ${d.action} size ${d.size} ${d.horizon}/${d.horizonTier} reqEdge ${d.requiredEdge} note ${d.pricedNote}`);
  console.log(`\norders ${out.orders.length}`);
  for(const o of out.orders) console.log(`  ${o.symbol} ${o.price} x${o.size} cost $${(o.price*o.size).toFixed(2)} ${o.status} dryRun ${o.dryRun} tx ${o.txHash??'-'} // ${o.reason} retained ${o.retainedEdge}`);
  if(out.errors.length) console.log('errors',out.errors);
  const {pnlSummary}=await import('../src/services/pnl');
  console.log('pnl',pnlSummary());
  await closeExchanges(); await new Promise(r=>setTimeout(r,400)); process.exit(0);
}
main().catch(async e=>{console.error(e); const {closeExchanges}=await import('../src/services/sdk'); await closeExchanges().catch(()=>{}); process.exit(1)});
