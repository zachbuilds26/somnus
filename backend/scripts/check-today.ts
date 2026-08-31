#!/usr/bin/env tsx
/** One-off: inspect today's traded windows — on-chain status, winner, and our
 *  outcome balance for each. Read-only. */
import { readFileSync } from 'node:fs';
import { getExchange, getSignerAddress, closeAndExit } from '../src/services/sdk';

const ids = (JSON.parse(readFileSync(process.env.IDS_FILE!, 'utf8')) as { ids: string[] }).ids;

async function main(): Promise<void> {
  const ex = getExchange();
  const me = getSignerAddress()!;
  const portfolio = (await ex.client.getPortfolio(me)) as {
    positions?: Array<Record<string, any>>;
  };

  for (const id of ids) {
    let onchain: any = {};
    try {
      onchain = await ex.client.getMarketOnchain(id as `0x${string}`);
    } catch (err) {
      console.log(`${id}: onchain read failed: ${(err as Error).message}`);
    }
    const pos = (portfolio.positions ?? []).find(
      (p) => String((p.market ?? {}).id ?? '') === id,
    );
    console.log(`\n== ${id} ==`);
    console.log(`onchain: status=${onchain?.status} winningOutcome=${onchain?.winningOutcome} lastPrice=${onchain?.lastPrice}`);
    if (pos) {
      const m = pos.market ?? {};
      console.log(`held: outcomeIndex=${pos.outcomeIndex} balance=${pos.balance} (${Number(pos.balance) / 1e6} contracts)`);
      console.log(`indexer market: status=${m.status} winningOutcome=${m.winningOutcome} expiry=${m.expiry} interval=${m.interval}`);
    } else {
      console.log('held: NO position found in portfolio');
    }
  }
}

void main().then(() => closeAndExit(0)).catch(async (err) => {
  console.error('failed:', (err as Error).message);
  await closeAndExit(1);
});
