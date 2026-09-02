delete process.env.FAIR_OVERRIDE_BTC; delete process.env.FAIR_OVERRIDE_ETH;
process.env.AGENT_MAX_HORIZON_SEC='900';
process.env.DRY_RUN='false';
const { runCycle } = await import('../src/services/agent');
const { closeExchanges, listEventMarketRows } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig } = await import('../src/agent-config');
const before=loadAgentConfig();
const cfg={...before, mode:'live' as const, maxTradeSize:2, minEdge:0.07, maxOrdersPerCycle:1, tradeQuota:20};
saveAgentConfig(cfg);
console.log(`Starting 20 live $2 hunt — 5m+15m, needs 0.07 edge. Will log every check so you see progress.`);
let totalOrders=0;
for(let i=1;i<=20;i++){
  const now=new Date().toLocaleTimeString();
  console.log(`\n[${now}] check ${i}/20 — scanning 5m+15m windows...`);
  try{
    const rows=await listEventMarketRows();
    console.log(`  found ${rows.length} windows (${rows.filter(r=>r.intervalSec===300).length} 5m, ${rows.filter(r=>r.intervalSec===900).length} 15m)`);
  }catch(e){ console.log(`  markets fetch failed: ${(e as Error).message}`); }
  const out=await runCycle({maxTrades:1, maxTradeSize:2, minEdge:0.07});
  if(out.decisions.length===0) console.log(`  no windows to price`);
  for(const d of out.decisions){
    const status=d.action==='PASS'?'SKIP (no edge)':'TRADE ready';
    console.log(`  ${d.symbol} ${d.horizon} edge ${d.edge.toFixed(3)}/${d.requiredEdge} → ${status} fair ${d.fair.toFixed(3)} book ${d.mid.toFixed(3)}`);
  }
  for(const o of out.orders){
    totalOrders++;
    console.log(`  >>> ORDER #${totalOrders}: ${o.symbol} $${(o.price*o.size).toFixed(2)} tx ${o.txHash?.slice(0,10)??'pending'} ${o.status}`);
  }
  if(out.errors.length) console.log(`  note: ${out.errors[0]}`);
  if(totalOrders===0) console.log(`  no good bet this minute — waiting for next window...`);
  else console.log(`  progress: ${totalOrders}/20 live orders placed`);
  if(totalOrders>=20) break;
  await new Promise(r=>setTimeout(r, 12000));
}
console.log(`\n=== done: ${totalOrders}/20 live $2 placed ===`);
const {pnlSummary}=await import('../src/services/pnl');
console.log(pnlSummary());
await closeExchanges(); await new Promise(r=>setTimeout(r,300)); process.exit(0);
