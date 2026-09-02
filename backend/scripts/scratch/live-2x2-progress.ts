delete process.env.FAIR_OVERRIDE_BTC; delete process.env.FAIR_OVERRIDE_ETH;
process.env.AGENT_MAX_HORIZON_SEC='900';
process.env.DRY_RUN='false';
const { runCycle } = await import('../src/services/agent');
const { closeExchanges, listEventMarketRows } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig } = await import('../src/agent-config');
const before=loadAgentConfig();
const cfg={...before, mode:'live' as const, maxTradeSize:2, minEdge:0.07, maxOrdersPerCycle:1, tradeQuota:2};
saveAgentConfig(cfg);
console.log(`Hunting 2 live $2 — 5m+15m, 0.07 edge. Logs every check.`);
let total=0, checks=0;
while(total<2 && checks<30){
  checks++;
  const now=new Date().toLocaleTimeString();
  console.log(`\n[${now}] check ${checks} — scanning...`);
  const rows=await listEventMarketRows();
  console.log(`  windows ${rows.length} (5m ${rows.filter(r=>r.intervalSec===300).length})`);
  const out=await runCycle({maxTrades:1, maxTradeSize:2, minEdge:0.07});
  for(const d of out.decisions){
    const s=d.action==='PASS'?'SKIP':'TRADE';
    console.log(`  ${d.symbol} ${d.horizon} edge ${d.edge.toFixed(3)}/${d.requiredEdge} → ${s}`);
  }
  for(const o of out.orders){
    if(o.status==='submitted'){ total++; console.log(`  >>> LIVE #${total}: ${o.symbol} $${(o.price*o.size).toFixed(2)} tx ${o.txHash?.slice(0,10)}...`); }
    else if(o.status==='rejected') console.log(`  skip: ${o.reason?.slice(0,80)}`);
  }
  if(out.errors.length) console.log(`  note ${out.errors[0].slice(0,80)}`);
  if(total>=2) break;
  console.log(`  progress ${total}/2 — waiting 12s for next window...`);
  await new Promise(r=>setTimeout(r,12000));
}
console.log(`\n=== done ${total}/2 live $2 ===`);
const {pnlSummary}=await import('../src/services/pnl');
console.log(pnlSummary());
await closeExchanges(); await new Promise(r=>setTimeout(r,300)); process.exit(0);
