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
export async function verifyProofSignature(
  proofHash: string,
  signature: string,
  expectedAddress: string,
): Promise<boolean> {
  try {
    const raw = (proofHash.startsWith('0x') ? proofHash : `0x${proofHash}`) as `0x${string}`;
    return await verifyMessage({
      address: expectedAddress as `0x${string}`,
      message: { raw },
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}