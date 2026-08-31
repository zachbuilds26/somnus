import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { config, DATA_DIR, log, debug, warn } from '../config';
import { currentAnchor } from './store';

/** Periodic, tamper-evident anchoring of the proof-chain head to chain.
 *
 *  The JSONL proof log is auditable on this machine, but "auditable locally" is
 *  weaker than it sounds: anyone with the file can rewrite history and re-sign.
 *  Writing the current chain anchor (a 32-byte SHA-256 of the whole history) into
 *  a transaction's calldata — a 0-value self-transfer — timestamps it on-chain.
 *  After that, tampering the local log without also forking the chain is
 *  detectable. The anchor tx hash is surfaced in /api/proof so a verifier can
 *  cross-check.
 *
 *  Uses `viem/accounts` + raw JSON-RPC (not the top-level `viem` client, whose
 *  type entry is broken in this install) to serialize and broadcast the tx.   */

const ANCHOR_PATH = join(DATA_DIR, 'proof-anchor.json');

function signerKey(): `0x${string}` | undefined {
  const k = config.privateKey ?? config.tradeKey ?? config.operatorKey;
  if (!k) return undefined;
  return (k.startsWith('0x') ? k : `0x${k}`) as `0x${string}`;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'rpc error');
  return body.result as T;
}

/** Write the current proof anchor to chain. Skips (and says why) when there is no
 *  key, we're in dry-run, or the chain is still at genesis. Returns the tx hash. */
export async function anchorProofHead(): Promise<{ txHash: string } | { skipped: string }> {
  const key = signerKey();
  if (!key) return { skipped: 'no signing key configured' };
  if (config.dryRun) return { skipped: 'DRY_RUN — would not write to chain' };
  const anchor = currentAnchor();
  if (!anchor || anchor === '0'.repeat(64)) return { skipped: 'chain at genesis, nothing to anchor' };

  // The local install's viem type entry is broken (returns a phantom account
  // type), though the runtime object has signTransaction. Narrow to the slice we
  // use so the call type-checks without fighting the missing declarations.
  const account = privateKeyToAccount(key) as unknown as {
    address: `0x${string}`;
    signTransaction: (tx: Record<string, unknown>) => Promise<`0x${string}`>;
  };
  const address = account.address;
  const nonceHex = await rpc<string>('eth_getTransactionCount', [address, 'pending']);
  const gasPrice = BigInt(await rpc<string>('eth_gasPrice', []));
  const data = `0x${anchor}` as `0x${string}`;

  // Legacy self-transfer carrying the anchor as calldata. Gas is paid in the
  // native token; this is the only on-chain write Somnus makes for auditability.
  const serialized = await account.signTransaction({
    to: address,
    value: 0n,
    data,
    chainId: config.chainId,
    nonce: Number(BigInt(nonceHex)),
    gas: 120_000n,
    gasPrice,
    type: 'legacy',
  });
  const txHash = await rpc<string>('eth_sendRawTransaction', [serialized]);

  try {
    writeFileSync(ANCHOR_PATH, JSON.stringify({ lastAnchor: anchor, lastTxHash: txHash, lastAt: Date.now() }), 'utf8');
  } catch {
    /* non-fatal: the tx is on-chain regardless */
  }
  return { txHash };
}

let lastAnchoredAt = 0;

/** Gate anchoring behind an interval (default 15 min) and the obvious preconditions.
 *  Cheap to call often; it only acts when due. */
export async function maybeAnchor(): Promise<void> {
  const interval = Number(process.env.PROOF_ANCHOR_INTERVAL_MS ?? 900_000);
  if (!(interval > 0)) return;
  if (config.dryRun) return;
  if (Date.now() - lastAnchoredAt < interval) return;
  try {
    const r = await anchorProofHead();
    if ('txHash' in r) {
      lastAnchoredAt = Date.now();
      log(`proof anchor written on-chain: ${r.txHash}`);
    } else {
      debug('proof anchor skipped:', r.skipped);
    }
  } catch (err) {
    warn('proof anchor failed:', (err as Error).message ?? String(err));
  }
}

export function lastAnchorInfo(): { lastAnchor?: string; lastTxHash?: string; lastAt?: number } | null {
  try {
    if (!existsSync(ANCHOR_PATH)) return null;
    return JSON.parse(readFileSync(ANCHOR_PATH, 'utf8'));
  } catch {
    return null;
  }
}
