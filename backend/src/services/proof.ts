import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { activeKey } from '../config';

export interface Signer {
  readonly address: string | undefined;
  sign(hex: string): Promise<string>;
}

/** secp256k1 signer over a 64-char hex digest, using viem's account.
 *  Returns undefined when no private key is configured — the chain still
 *  records hashes, just without an on-wallet signature. */
export function createProofSigner(privateKey: string | undefined): Signer | undefined {
  if (!privateKey) return undefined;
  const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    async sign(hex: string): Promise<string> {
      // Two traps, both previously masked by a swallowed catch: computeHash()
      // yields a bare 64-char digest so it needs the 0x prefix, and viem takes
      // the raw form nested as `{ message: { raw } }` — a bare `{ raw }` throws
      // reading `message.raw` of undefined.
      const raw = (hex.startsWith('0x') ? hex : `0x${hex}`) as `0x${string}`;
      return (await account.signMessage({ message: { raw } })) as string;
    },
  };
}

export function createConfiguredSigner(): Signer | undefined {
  return createProofSigner(activeKey());
}

/** Verify one entry's signature against an expected signer address.
 *
 *  The signature covers the entry's proof hash (prevHash + payloadHash + kind),
 *  so the caller recomputes that and passes it in. Without this, "signed audit
 *  trail" is an unchecked assertion: hash linkage proves the chain wasn't
 *  reordered, but only a signature proves who wrote it.                        */
/** Memoised signature results, keyed on the exact question asked.
 *
 *  An ECDSA public-key recovery costs ~36ms and the answer for a given
 *  (hash, signature, address) triple never changes — the inputs are immutable once an
 *  entry is written. Verifying the chain therefore re-answered thousands of identical
 *  questions on every request, which is what made `POST /proof/verify` a denial of
 *  service: 2,799 recoveries, 78 seconds of CPU, from one unauthenticated call.
 *
 *  With this, the second verification of the same chain costs nothing, and a
 *  verification after N new entries costs N recoveries rather than all of them.
 *
 *  Bounded, because a cache that grows forever is its own memory leak: oldest evicted
 *  first, at roughly 80 bytes an entry. The key includes the address, so pointing a
 *  different `SOMNUS_PROOF_SIGNER` at the same chain cannot inherit an answer computed
 *  for the previous one. */
const MAX_MEMO = Number(process.env.SOMNUS_SIGNATURE_MEMO ?? 20_000);
const memo = new Map<string, boolean>();

/** Drop the memo. For tests, and for anywhere a signer change should be re-proved. */
export function __resetSignatureMemoForTests(): void {
  memo.clear();
}

export async function verifyProofSignature(
  proofHash: string,
  signature: string,
  expectedAddress: string,
): Promise<boolean> {
  const key = `${proofHash}|${signature}|${expectedAddress.toLowerCase()}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let result = false;
  try {
    const raw = (proofHash.startsWith('0x') ? proofHash : `0x${proofHash}`) as `0x${string}`;
    result = await verifyMessage({
      address: expectedAddress as `0x${string}`,
      message: { raw },
      signature: signature as `0x${string}`,
    });
  } catch {
    result = false;
  }
  // Evict oldest-first. Map preserves insertion order, so the first key is the oldest.
  if (memo.size >= MAX_MEMO) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, result);
  return result;
}