#!/usr/bin/env tsx
/** One-off: authoritative view of OUR binary portfolio — positions, open
 *  orders, and trades. Answers whether the live order actually filled. */
import { getExchange, getSignerAddress } from '../src/services/sdk';

async function main(): Promise<void> {
  const ex = getExchange();
  const me = getSignerAddress()!;
  const p = (await ex.client.getPortfolio(me)) as Record<string, any>;

  console.log('portfolio keys:', Object.keys(p).join(', '));
  const show = (label: string, v: unknown) =>
    console.log(
      `\n== ${label} ==\n` +
        JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x), 1)?.slice(0, 2200),
    );

  for (const k of Object.keys(p)) {
    const v = (p as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      console.log(`\n${k}: ${v.length} item(s)`);
      if (v.length) show(k, v.slice(0, 4));
    } else {
      console.log(`${k}:`, JSON.stringify(v, (_x, y) => (typeof y === 'bigint' ? String(y) : y)));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', (e as Error).message);
  process.exit(1);
});
