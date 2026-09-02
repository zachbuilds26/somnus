delete process.env.FAIR_OVERRIDE_BTC; delete process.env.FAIR_OVERRIDE_ETH;
process.env.AGENT_MAX_HORIZON_SEC='900';
process.env.DRY_RUN='false';
const { runCycle } = await import('../src/services/agent');
const { closeExchanges, listEventMarketRows, nativeGasBalance, getSignerAddress } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig, effectiveDryRun } = await import('../src/agent-config');
async function main(){
  const before=loadAgentConfig();
  const cfg={...before, mode:'live' as const, maxTradeSize:2, minEdge:0.07, maxOrdersPerCycle:2, tradeQuota:20, maxPerMarket:1, tradingPaused:false};
  delete (cfg as any).pauseReason; delete (cfg as any).pausedAt;
  saveAgentConfig(cfg);
  console.log('live 20x $2 cfg',cfg,'dry',effectiveDryRun(cfg));
  console.log('signer',getSignerAddress(),'gas', (await nativeGasBalance())!=null?Number(await nativeGasBalance())/1e18:'?');
  const rows=await listEventMarketRows();
  console.log(`markets ${rows.length} 5m ${rows.filter(r=>r.intervalSec===300).length} 15m ${rows.filter(r=>r.intervalSec===900).length}`);

  let totalOrders=0, totalDecisions=0;
  for(let i=1;i<=20;i++){
    console.log(`\n--- live ${i}/20 ---`);
    const out=await runCycle({maxTrades:1, maxTradeSize:2, minEdge:0.07});
    console.log(`decisions ${out.decisions.length} orders ${out.orders.length}`);
    for(const d of out.decisions) console.log(`  ${d.symbol} fair ${d.fair.toFixed(3)} edge ${d.edge.toFixed(3)} ${d.action} ${d.horizon} req ${d.requiredEdge}`);
    for(const o of out.orders) console.log(`  order ${o.symbol} ${o.price} x${o.size} $${(o.price*o.size).toFixed(2)} ${o.status} tx ${o.txHash??'-'} // ${o.reason}`);
    if(out.errors.length) console.log('errors',out.errors);
    totalDecisions+=out.decisions.length;
    totalOrders+=out.orders.length;
    const { pnlSummary } = await import('../src/services/pnl');
    console.log('pnl',pnlSummary());
    if(totalOrders>=20) break;
    // wait for next window to appear + feed to recover
    await new Promise(r=>setTimeout(r, 15000));
  }
  console.log(`\n=== done: ${totalDecisions} decisions, ${totalOrders} live orders ===`);
  const { pnlSummary } = await import('../src/services/pnl');
  console.log('final pnl',pnlSummary());
  await closeExchanges(); await new Promise(r=>setTimeout(r,400)); process.exit(0);
}
main().catch(async e=>{console.error(e); const {closeExchanges}=await import('../src/services/sdk'); await closeExchanges().catch(()=>{}); process.exit(1)});
