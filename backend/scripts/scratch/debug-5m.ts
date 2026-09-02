process.env.AGENT_MAX_HORIZON_SEC = '300';
process.env.FAIR_OVERRIDE_BTC = '0.68';
process.env.FAIR_OVERRIDE_ETH = '0.32';
process.env.DRY_RUN = 'true';
process.env.AGENT_MODE = 'dry-run';
const { listEventMarketRows } = await import('../src/services/sdk');
const { calibrationSummary, horizonPolicy } = await import('../src/services/horizon');
const { loadAgentConfig } = await import('../src/agent-config');

console.log('config', loadAgentConfig());
console.log('calibration', calibrationSummary());

const rows = await listEventMarketRows();
console.log(`rows total: ${rows.length}`);
for (const r of rows.slice(0, 8)) {
  console.log(`  ${r.symbol} asset=${r.asset} interval=${r.intervalSec} expiry=${r.expiry} secsLeft=${r.expiry ? r.expiry - Math.floor(Date.now()/1000) : '?'}`);
  const left = r.expiry ? r.expiry - Math.floor(Date.now()/1000) : NaN;
  const pol = horizonPolicy(r.intervalSec, left);
  console.log(`    -> policy ${pol.label} tier=${pol.tier} note=${pol.note}`);
}

const filtered = rows.filter(r => {
  const left = r.expiry ? r.expiry - Math.floor(Date.now()/1000) : NaN;
  const pol = horizonPolicy(r.intervalSec, left);
  return pol.tier !== 'blocked';
});
console.log(`filtered non-blocked: ${filtered.length}`);

import { closeExchanges } from '../src/services/sdk';
await closeExchanges();
await new Promise(r => setTimeout(r, 300));
process.exit(0);
