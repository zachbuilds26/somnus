delete process.env.FAIR_OVERRIDE_BTC; delete process.env.FAIR_OVERRIDE_ETH;
process.env.AGENT_MAX_HORIZON_SEC='300';
process.env.DRY_RUN='false';
const { runCycle } = await import('../src/services/agent');
const { closeExchanges, listEventMarketRows, nativeGasBalance, getSignerAddress } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig, effectiveDryRun } = await import('../src/agent-config');
async function main(){
  const before=loadAgentConfig();
  const cfg={...before, mode:'live' as const, maxTradeSize:100, minEdge:0.07, maxOrdersPerCycle:1, tradeQuota:1, edgePreset:'very-sure' as const};
  saveAgentConfig(cfg);
  console.log('live $100 very-sure',cfg,'dry',effectiveDryRun(cfg));
  console.log('signer',getSignerAddress(),'gas', (await nativeGasBalance())!=null?Number(await nativeGasBalance())/1e18:'?');
  const rows=await listEventMarketRows();
  console.log(`markets ${rows.length} 5m ${rows.filter(r=>r.intervalSec===300).length}`);
  console.log('\n== LIVE 1x $100 5m very-sure 0.07 ==');
  const out=await runCycle({maxTrades:1, maxTradeSize:100, minEdge:0.07, edgePreset:'very-sure'});
  console.log(`decisions ${out.decisions.length}`);
  for(const d of out.decisions) console.log(`  ${d.symbol} fair ${d.fair.toFixed(3)} edge ${d.edge.toFixed(3)} ${d.action} ${d.horizon} req ${d.requiredEdge}`);
  console.log(`\norders ${out.orders.length} pending ${out.pending.length}`);
  for(const o of out.orders) console.log(`  order ${o.symbol} ${o.price} x${o.size} $${(o.price*o.size).toFixed(2)} ${o.status} tx ${o.txHash??'-'} // ${o.reason}`);
  for(const p of out.pending) console.log(`  PENDING ${p.symbol} $${p.cost} payout $${p.payoutIfWin} price ${p.price} edge ${(p.edge*100).toFixed(1)}% id ${p.id} — confirm to place`);
  if(out.errors.length) console.log('errors',out.errors);
  const {pnlSummary}=await import('../src/services/pnl');
  console.log('pnl',pnlSummary());
  await closeExchanges(); await new Promise(r=>setTimeout(r,400)); process.exit(0);
}
main().catch(async e=>{console.error(e); const {closeExchanges}=await import('../src/services/sdk'); await closeExchanges().catch(()=>{}); process.exit(1)});
