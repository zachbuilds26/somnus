import { loadAgentConfig, saveAgentConfig } from '../src/agent-config';
import { runCycle } from '../src/services/agent';
import { closeExchanges } from '../src/services/sdk';

const before = loadAgentConfig();
const cfg = { ...before, mode: 'dry-run' as const, minEdge: 0.07, maxTradeSize: 5, maxOrdersPerCycle: 1, tradeQuota: null };
saveAgentConfig(cfg);
console.log('dry practice cfg', cfg);

let totalDecisions=0, totalOrders=0;
for(let i=1;i<=20;i++){
  console.log(`\n--- dry ${i}/20 ---`);
  const out = await runCycle();
  console.log(`decisions ${out.decisions.length} orders ${out.orders.length} errors ${out.errors.length}`);
  for(const d of out.decisions) console.log(`  ${d.symbol} fair ${d.fair.toFixed(3)} edge ${d.edge.toFixed(3)} ${d.action} ${d.horizon}`);
  for(const o of out.orders) console.log(`  order ${o.symbol} ${o.price} x${o.size} ${o.status} // ${o.reason}`);
  totalDecisions+=out.decisions.length;
  totalOrders+=out.orders.length;
  // small pause so next 5m window can appear and feed recovers
  await new Promise(r=>setTimeout(r, 4000));
}

console.log(`\n=== done 20 cycles: ${totalDecisions} decisions, ${totalOrders} simulated orders ===`);
const { buildPerformanceReport } = await import('../src/services/report');
const rep = buildPerformanceReport();
console.log(`report level ${rep.recommendation.level}: ${rep.recommendation.action}`);
console.log('pnl', rep.pnl);
console.log('byHorizon', rep.breakdown.byHorizon);
console.log('byTier', rep.breakdown.byTier);

// restore live mode
saveAgentConfig({ ...cfg, mode: before.mode });
console.log('restored mode', before.mode);

await closeExchanges();
await new Promise(r=>setTimeout(r,300));
process.exit(0);
