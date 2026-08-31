#!/usr/bin/env tsx
/** Is our loss record bad luck, or systematic bias?
 *
 *  In an efficient market the price you pay IS the probability. So across N
 *  trades, expected wins = sum of prices paid. Comparing that to actual wins
 *  separates "unlucky" from "the model is wrong", which win rate alone cannot:
 *  1 win in 29 is fine if we paid 0.03 a pop, and damning if we paid 0.30.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/config';
import { getExchange, getSignerAddress, closeAndExit } from '../src/services/sdk';

interface OrderRec {
  symbol: string;
  price: number;
  size: number;
  txHash?: string;
  status: string;
  ts: number;
}

async function main(): Promise<void> {
  // Real submitted orders, straight from the signed audit trail.
  const file = join(DATA_DIR, 'proof-chain.jsonl');
  const orders: OrderRec[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 'order' && e.payload?.status === 'submitted' && e.payload?.txHash) {
        orders.push(e.payload as OrderRec);
      }
    } catch {
      /* torn line */
    }
  }
  console.log(`submitted orders in the audit trail: ${orders.length}`);

  // Outcomes, per position, from the portfolio.
  const ex = getExchange();
  const me = getSignerAddress()!;
  const p = (await ex.client.getPortfolio(me)) as { positions?: Array<Record<string, any>> };

  let won = 0;
  let lost = 0;
  let open = 0;
  const settledPrices: number[] = [];

  for (const pos of p.positions ?? []) {
    const m = pos.market ?? {};
    const side = Number(pos.outcomeIndex) === 0 ? 'YES' : 'NO';
    const settled = m.status === 'Finalized' || m.status === 'Resolved' || m.voided;
    if (!settled) {
      open++;
      continue;
    }
    const winSide = Number(m.winningOutcome) === 0 ? 'YES' : 'NO';
    const isWin = winSide === side;

    // Match this position back to the order(s) that opened it, by symbol suffix.
    const suffix = side === 'YES' ? '#YES' : '#NO';
    const asset = String(m.asset ?? '');
    const cands = orders.filter((o) => o.symbol.endsWith(suffix) && o.symbol.startsWith(asset));
    const price = cands.length
      ? cands.reduce((a, b) => a + b.price, 0) / cands.length
      : undefined;
    if (price !== undefined) settledPrices.push(price);
    if (isWin) won++;
    else lost++;
  }

  const n = settledPrices.length;
  const expected = settledPrices.reduce((a, b) => a + b, 0);
  const avgPrice = n ? expected / n : 0;

  // Measurement caveat: this reads the PORTFOLIO, and winning outcome tokens
  // are redeemed (balance → 0) by the claim sweep the moment they settle. A
  // wallet that claims its winners therefore shows ONLY losers here — a
  // survivorship artifact that reads as catastrophic bias regardless of skill.
  // The authoritative record is `npm run score`, which matches ORDERS from the
  // audit trail against market outcomes instead of leftover balances.
  if (won === 0 && lost > 0) {
    console.log('\n[!] every settled position here is a LOSER — expected whenever');
    console.log('    winners are auto-claimed (their tokens leave the portfolio).');
    console.log('[!] this run cannot measure win rate; use `npm run score` for the');
    console.log('    order-vs-outcome record before drawing any bias conclusion.');
  }

  console.log('\n== settled record ==');
  console.log(`  won ${won} / lost ${lost}  (open ${open})`);
  console.log('\n== luck vs bias ==');
  console.log(`  matched prices for ${n} settled positions`);
  console.log(`  average price paid   : ${avgPrice.toFixed(3)}`);
  console.log(`  EXPECTED wins        : ${expected.toFixed(1)}  (sum of prices paid)`);
  console.log(`  ACTUAL wins          : ${won}`);

  if (n > 0) {
    // Binomial sd under the market's own probabilities.
    const variance = settledPrices.reduce((a, q) => a + q * (1 - q), 0);
    const sd = Math.sqrt(variance);
    const z = sd > 0 ? (won - expected) / sd : 0;
    console.log(`  sd                   : ${sd.toFixed(2)}`);
    console.log(`  z-score              : ${z.toFixed(2)}`);
    console.log('');
    if (Math.abs(z) < 2) {
      console.log('  -> within ~2 sd of the market\'s own odds: consistent with BAD LUCK / small sample.');
      console.log('     The prices we paid were low, so few wins is expected.');
    } else if (z < 0) {
      console.log('  -> more than 2 sd WORSE than the market\'s own odds: SYSTEMATIC BIAS.');
      console.log('     We are paying for outcomes that happen less often than the price implies.');
    } else {
      console.log('  -> significantly BETTER than the market: genuine edge.');
    }
  }

  await closeAndExit(0);
}

main().catch(async (e) => {
  console.error('failed:', (e as Error).message);
  await closeAndExit(1);
});
