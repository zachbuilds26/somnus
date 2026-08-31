/** Local types for the `viem` root subpath.
 *
 *  Same cause as `viem-accounts.d.ts`: the installed viem tarball omits the
 *  `_types/*` declaration files its `exports` map points at, so TypeScript
 *  reports TS7016 for the whole module. Declare only the surface this repo
 *  uses.
 *
 *  Keep this FAITHFUL to viem's real runtime signature. The sibling shim for
 *  `viem/accounts` once declared `signMessage({ raw })` instead of
 *  `signMessage({ message: { raw } })`, which made the wrong call compile and
 *  then throw at runtime — every proof entry silently came out unsigned. Verify
 *  any addition here against actual behaviour, not intuition.
 */
declare module 'viem' {
  /** A signable message: a plain UTF-8 string, or a raw digest signed as-is. */
  export type SomnusSignableMessage = string | { raw: `0x${string}` | Uint8Array };

  /** EIP-191 `personal_sign` recovery check. Resolves true when `signature`
   *  over `message` recovers to `address`. */
  export function verifyMessage(args: {
    address: `0x${string}`;
    message: SomnusSignableMessage;
    signature: `0x${string}`;
  }): Promise<boolean>;
}
