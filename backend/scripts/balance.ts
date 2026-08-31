#!/usr/bin/env tsx
/** Read-only wallet check: native gas (STT) + collateral (tUSDC). Sends nothing. */
import { config } from '../src/config';
import { getSignerAddress, closeAndExit } from '../src/services/sdk';

const COLLATERAL = '0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E';

async function rpc(method: string, params: unknown[]): Promise<string> {
  const res = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error || !body.result) throw new Error(body.error?.message ?? `${method} failed`);
  return body.result;
}

async function balanceOfErc20(address: string): Promise<bigint> {
  const data = `0x70a08231${address.slice(2).padStart(64, '0')}`;
  return BigInt(await rpc('eth_call', [{ to: COLLATERAL, data }, 'latest']));
}

function fmt6(raw: bigint): string {
  return (Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

async function main(): Promise<void> {
  const address = getSignerAddress();
  if (!address) throw new Error('no TRADE_KEY/PRIVATE_KEY configured in backend/.env');
  console.log(`signer:   ${address}`);
  console.log(`network:  ${config.network} (${config.rpcUrl})`);

  const [gasWei, tusdcRaw] = await Promise.all([
    rpc('eth_getBalance', [address, 'latest']),
    balanceOfErc20(address),
  ]);
  const gas = Number(BigInt(gasWei)) / 1e18;

  console.log(`gas STT:  ${gas.toFixed(6)} ${gas > 0 ? '(can pay gas)' : '(EMPTY - need Somnia testnet faucet)'}`);
  console.log(`tUSDC:    ${fmt6(tusdcRaw)} ${tusdcRaw > 0n ? '(can buy contracts)' : '(EMPTY - run npm run faucet)'}`);
  if (gas <= 0 || tusdcRaw <= 0n) process.exitCode = 1;
}

void main()
  .then(() => closeAndExit(process.exitCode === '1' ? 1 : 0))
  .catch(async (err) => {
    console.error(`\nbalance failed: ${(err as Error).message ?? err}\n`);
    await closeAndExit(1);
  });
