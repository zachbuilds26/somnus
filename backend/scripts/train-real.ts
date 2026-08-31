delete process.env.FAIR_OVERRIDE_BTC;
delete process.env.FAIR_OVERRIDE_ETH;
process.env.AGENT_MAX_HORIZON_SEC = '900';
process.env.DRY_RUN = 'true';

const { runCycle } = await import('../src/services/agent');
const { closeExchanges, listEventMarketRows } = await import('../src/services/sdk');
const { loadAgentConfig, saveAgentConfig, effectiveDryRun } = await import('../src/agent-config');
const { buildPerformanceReport } = await import('../src/services/report');

async function main() {
  const before = loadAgentConfig();
  const trainCfg = { ...before, mode: 'dry-run' as const, minEdge: 0.07, maxTradeSize: 3, maxOrdersPerCycle: 2, tradeQuota: null, maxDailyLoss: 10, maxConsecutiveLosses: 3 };
  saveAgentConfig(trainCfg);
  console.log('train cfg:', trainCfg, 'effectiveDryRun', effectiveDryRun(trainCfg));

  const rows = await listEventMarketRows();
  console.log(`markets total ${rows.length}, 5m ${rows.filter(r=>r.intervalSec===300).length}, 15m ${rows.filter(r=>r.intervalSec===900).length}`);

  console.log('\n== real model dry cycle ==');
  const out = await runCycle({ maxTradeSize: 3, minEdge: 0.07 });

  console.log(`decisions ${out.decisions.length}`);
  for (const d of out.decisions) {
    console.log(`  ${d.symbol} fair ${d.fair.toFixed(3)} mid ${d.mid} ask ${d.ask} bid ${d.bid} edge ${d.edge.toFixed(3)} action ${d.action} size ${d.size} horizon ${d.horizon} tier ${d.horizonTier} reqEdge ${d.requiredEdge} note ${d.pricedNote}`);
  }
  console.log(`\norders ${out.orders.length}`);
  for (const o of out.orders) {
    console.log(`  ${o.symbol} price ${o.price} size ${o.size} status ${o.status} dryRun ${o.dryRun} retained ${o.retainedEdge} // ${o.reason}`);
  }
  if (out.errors.length) console.log('errors', out.errors);
  console.log(`books ${out.books.length}`);

  console.log('\n== performance report ==');
  const rep = buildPerformanceReport();
  console.log(`level ${rep.recommendation.level}: ${rep.recommendation.action}`);
  console.log('reasons:', rep.recommendation.reasons.slice(0,6));
  console.log('pnl', rep.pnl);
  console.log('calibration source', rep.calibration.source, rep.calibration.classes.map(c=>`${c.class}:${c.tier}`).join(', '));
  console.log('breakdown byTier', rep.breakdown.byTier);
  console.log('breakdown byHorizon', rep.breakdown.byHorizon.slice(0,4));

  await closeExchanges();
  await new Promise(r=>setTimeout(r,300));
  process.exit(0);
}
main().catch(async e=>{console.error(e); const {closeExchanges}=await import('../src/services/sdk'); await closeExchanges().catch(()=>{}); process.exit(1)});
