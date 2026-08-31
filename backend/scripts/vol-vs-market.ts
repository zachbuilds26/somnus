#!/usr/bin/env tsx
/** Compare OUR volatility estimate against the volatility the market implies.
 *
 *  For a binary priced at q with spot S, reference K and horizon T:
 *      q = Phi( (ln(S/K) - sigma^2 T / 2) / (sigma sqrt(T)) )
 *  Inverting for sigma gives the market's implied view. If ours is consistently
 *  higher, we systematically think tails are fatter than the market does — which
 *  is exactly the bias that makes cheap outcomes look underpriced and produces a
 *  book full of losing long-shot bets.
 */
import {
  buildSignalContext,
  horizonVolatility,
  normalCdf,
  referenceLevel,
} from '../src/services/signal';
import { closeAndExit, eventBook, listEventMarketRows } from '../src/services/sdk';

/** Solve for sigma such that the model price equals `q`. Bisection is plenty. */
function impliedSigma(spot: number, reference: number, q: number): number | undefined {
  const price = (sigma: number): number => {
    if (sigma <= 0) return spot >= reference ? 1 : 0;
    return normalCdf((Math.log(spot / reference) - 0.5 * sigma * sigma) / sigma);
  };
  let lo = 1e-6;
  let hi = 5;
  // Monotonicity differs either side of the money; check both ends.
  const pLo = price(lo);
  const pHi = price(hi);
  if ((q < Math.min(pLo, pHi) - 1e-6) || (q > Math.max(pLo, pHi) + 1e-6)) return undefined;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const pm = price(mid);
    if (pLo < pHi ? pm < q : pm > q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

async function main(): Promise<void> {
  const rows = await listEventMarketRows();
  const ctx = await buildSignalContext(rows.map((r) => r.asset));
  const now = Math.floor(Date.now() / 1000);

  console.log('window                      secsLeft   ourSigma  mktSigma   ratio   ourFair  mktMid');
  console.log('-'.repeat(92));

  let ratios: number[] = [];
  for (const r of rows) {
    const spot = ctx.spot.get(r.asset.toUpperCase());
    const closes = ctx.closes.get(r.asset.toUpperCase());
    if (spot === undefined || closes === undefined || r.expiry === undefined) continue;
    const secondsLeft = r.expiry - now;
    if (secondsLeft <= 30) continue;
    const reference = referenceLevel(r, spot);
    if (reference === undefined) continue;

    const vol = horizonVolatility(closes, secondsLeft / 60);
    if (!vol) continue;

    let book;
    try {
      book = await eventBook(r.symbol, 3);
    } catch {
      continue;
    }
    const mid = book.mid;
    if (mid === undefined || mid <= 0.01 || mid >= 0.99) continue;

    const ourFair = normalCdf(
      (Math.log(spot / reference) - 0.5 * vol.sigma * vol.sigma) / vol.sigma,
    );
    const mkt = impliedSigma(spot, reference, mid);
    const ratio = mkt && mkt > 0 ? vol.sigma / mkt : undefined;
    if (ratio) ratios.push(ratio);

    console.log(
      `${r.symbol.slice(-26).padEnd(27)} ${String(secondsLeft).padStart(7)}   ` +
        `${(vol.sigma * 100).toFixed(3).padStart(7)}%  ${mkt ? (mkt * 100).toFixed(3).padStart(7) + '%' : '      ?'}  ` +
        `${ratio ? ratio.toFixed(2).padStart(5) : '    ?'}   ${ourFair.toFixed(3).padStart(6)}  ${mid.toFixed(3)}`,
    );
  }

  if (ratios.length) {
    ratios.sort((a, b) => a - b);
    const med = ratios[Math.floor(ratios.length / 2)]!;
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    console.log('-'.repeat(92));
    console.log(`\nsigma ratio (ours / market): median ${med.toFixed(2)}, mean ${mean.toFixed(2)}, n=${ratios.length}`);
    if (med > 1.25) console.log('  -> OUR VOL IS TOO HIGH: we overprice tails, so cheap outcomes look underpriced.');
    else if (med < 0.8) console.log('  -> our vol is too LOW: we underprice tails.');
    else console.log('  -> vol is broadly in line with the market.');
  } else {
    console.log('\nno comparable windows right now');
  }

  await closeAndExit(0);
}

main().catch(async (e) => {
  console.error('failed:', (e as Error).message);
  await closeAndExit(1);
});
