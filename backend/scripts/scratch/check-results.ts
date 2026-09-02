import { pnlSummary, settledTrades, pnlRecent } from '../src/services/pnl';
import { closeExchanges, getSignerAddress, getExchange } from '../src/services/sdk';
import { findClaimable } from '../src/services/settlement';

const pnl = pnlSummary();
console.log('== PnL ==');
console.log(pnl);
console.log('');
console.log(`settledTrades: ${settledTrades().length}`);
for (const t of settledTrades().slice(-5)) {
  console.log(`  ${t.symbol} ${t.marketId.slice(0,10)}... outcome ${t.outcomeIdx} cost ${t.cost} payout ${t.payout} pnl ${t.pnl} won ${t.won}`);
}
console.log('');
console.log('recent ledger rows:', pnlRecent(8));
console.log('');

const signer = getSignerAddress();
console.log('signer', signer);
try {
  const claimable = await findClaimable();
  console.log('claimable:', claimable);
} catch (e) {
  console.log('claimable error:', (e as Error).message);
}

try {
  const ex = getExchange();
  const port = await ex.client.getPortfolio(signer as `0x${string}`) as any;
  const positions = port.positions ?? [];
  console.log(`\nportfolio positions: ${positions.length}`);
  for (const p of positions.slice(0, 10)) {
    const m = p.market ?? {};
    console.log(`  ${m.asset} ${m.intervalSec}s ${p.outcomeIndex===0?'YES':'NO'} size ${p.size} status ${m.status} winning ${m.winningOutcome} voided ${m.voided} marketId ${m.marketId?.slice(0,10)}...`);
  }
} catch (e) {
  console.log('portfolio error', (e as Error).message);
}

await closeExchanges();
await new Promise(r => setTimeout(r, 400));
process.exit(0);
