#!/usr/bin/env tsx
/** Settlement sweep from the CLI.
 *
 *  Usage:  npm run claim          # report what's claimable (read-only)
 *          npm run claim -- go    # actually redeem (still honours DRY_RUN)
 */
import { config } from '../src/config';
import { effectiveDryRun, loadAgentConfig } from '../src/agent-config';
import { closeAndExit } from '../src/services/sdk';
import { claimAll, findClaimable } from '../src/services/settlement';

function usdc(raw: string, decimals = 6): string {
  return (Number(raw) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function human(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

async function main(): Promise<void> {
  const rules = loadAgentConfig();
  const dryRun = effectiveDryRun(rules);
  const go = (process.argv[2] ?? '').toLowerCase() === 'go';

  console.log(`\n== Somnus settlement (${config.network}) ==`);
  console.log(`claimEnabled: ${rules.claimEnabled} | DRY_RUN in force: ${dryRun}`);

  const scan = await findClaimable();
  if (!scan.signer) {
    throw new Error('no TRADE_KEY/PRIVATE_KEY configured — settlement needs the signing wallet');
  }
  console.log(`signer: ${scan.signer}`);
  console.log(
    `positions held: ${scan.scanned}` +
      `${scan.skippedOlder ? `, skipped ${scan.skippedOlder} older` : ''}`,
  );

  if (scan.claimable.length === 0) {
    console.log('\nnothing claimable right now.\n');
    return;
  }

  console.log(`\nclaimable positions (${scan.claimable.length}):`);
  for (const c of scan.claimable) {
    const side = c.outcomeIdx === 0 ? 'YES' : 'NO';
    const when = c.expiry ? new Date(c.expiry * 1000).toISOString().slice(11, 16) : '?';
    // Use each market's OWN decimals — hardcoding 6 is right for the testnet
    // faucet token but wrong for 18-decimal mainnet collateral.
    console.log(
      `  ${c.asset ?? '?'} ${side.padEnd(3)} exp ${when} ${c.voided ? '[VOIDED] ' : ''}` +
        `amount ${usdc(c.amount, c.decimals)} -> est payout ${usdc(c.estPayout, c.decimals)}`,
    );
  }
  console.log(`  total est payout: ${human(scan.totalEstPayoutHuman)}`);
  if (scan.mixedDecimals) {
    console.log('  (positions span mixed collateral decimals — per-position values above are authoritative)');
  }

  if (!go) {
    console.log('\n(read-only. re-run with `npm run claim -- go` to redeem.)\n');
    return;
  }

  console.log('\nredeeming…');
  const res = await claimAll();
  console.log(`result: ${res.reason}`);
  if (res.txHash) console.log(`tx: ${res.txHash}`);
  console.log('');
}



void main()
  .then(() => closeAndExit(0))
  .catch(async (err) => {
    console.error(`\nclaim failed: ${(err as Error).message ?? err}\n`);
    await closeAndExit(1);
  });
