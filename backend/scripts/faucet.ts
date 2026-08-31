#!/usr/bin/env tsx
/** Mint TestUSDC to the configured trade key (TESTNET ONLY).
 *
 *  Event Contracts settle in tUSDC, not the native gas token — a wallet with
 *  STT and no tUSDC can pay gas but cannot buy a single contract. The SDK
 *  exposes the faucet on the raw trader tier; there is no website for it.
 *
 *  Usage:  npm run faucet            # default drip (10,000 tUSDC)
 *          npm run faucet -- 2500    # explicit amount
 */
import { config } from '../src/config';
import { getSignerAddress, getTradingExchange, closeAndExit } from '../src/services/sdk';

const COLLATERAL = '0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E';

async function balanceOf(address: string): Promise<bigint> {
  const data = `0x70a08231${address.slice(2).padStart(64, '0')}`;
  const res = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: COLLATERAL, data }, 'latest'],
    }),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'eth_call failed');
  return BigInt(body.result ?? '0x0');
}

async function main(): Promise<void> {
  if (config.network !== 'testnet') {
    throw new Error(`faucet is testnet-only — NETWORK is "${config.network}"`);
  }

  const exchange = getTradingExchange();
  const address = getSignerAddress();
  if (!address) throw new Error('no TRADE_KEY/PRIVATE_KEY configured in backend/.env');
  console.log(`\n== Somnus faucet (${config.network}) ==`);
  console.log(`signer: ${address}`);

  const before = await balanceOf(address);
  console.log(`tUSDC before: ${fmt(before)}`);

  // 6-decimal collateral on the testnet faucet token; the SDK defaults to
  // 10,000 x 10^decimals when `amount` is omitted.
  const arg = process.argv[2];
  const amount = arg ? BigInt(Math.round(Number(arg) * 1e6)) : undefined;
  if (arg && !(Number(arg) > 0)) throw new Error(`bad amount "${arg}"`);

  console.log(amount ? `requesting ${fmt(amount)} tUSDC…` : 'requesting default drip…');
  const tx = await exchange.trader.faucet(amount ? { amount } : undefined);
  console.log(`tx: ${tx.hash}`);
  console.log(`status: ${tx.receipt.status}`);
  if (tx.receipt.status === 'reverted') {
    throw new Error('faucet reverted — it may be rate-limited per address');
  }

  const after = await balanceOf(address);
  console.log(`tUSDC after:  ${fmt(after)}  (+${fmt(after - before)})`);
  console.log('\nReady to trade. DRY_RUN stays in force until you set DRY_RUN=false AND mode=live.\n');
}

function fmt(raw: bigint): string {
  return (Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 });
}



void main()
  .then(() => closeAndExit(0))
  .catch(async (err) => {
    console.error(`\nfaucet failed: ${(err as Error).message ?? err}\n`);
    await closeAndExit(1);
  });
