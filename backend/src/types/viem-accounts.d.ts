/** Local types for the `viem/accounts` subpath.
 *
 *  The installed `viem` (2.55.x) ships runtime code and an `exports` map for
 *  `./accounts`, but the npm tarball omits the `_types/accounts/*` declaration
 *  files referenced by that map. TypeScript therefore cannot resolve the
 *  subpath and reports TS7016. We provide the *minimal* surface this repo
 *  uses (privateKeyToAccount) here; the runtime import itself is unaffected.
 *
 *  Keep this faithful to viem's ACTUAL runtime signature. An earlier version
 *  declared `signMessage({ raw })`, which made the wrong call compile cleanly
 *  and then throw at runtime ("cannot read properties of undefined (reading
 *  'raw')") — viem takes the raw digest nested under `message`. Combined with a
 *  swallowed catch in the proof store, that silently left every audit entry
 *  unsigned. A shim that lies is worse than no shim.
 */
declare module 'viem/accounts' {
  /** A signable message: a plain UTF-8 string, or a raw digest to sign as-is. */
  export type SomnusSignableMessage = string | { raw: `0x${string}` | Uint8Array };

  export interface SomnusAccountLike {
    readonly address: `0x${string}`;
    signMessage(args: { message: SomnusSignableMessage }): Promise<`0x${string}`>;
  }

  export function privateKeyToAccount(privateKey: `0x${string}`): SomnusAccountLike;

  /** A fresh secp256k1 private key from the platform CSPRNG.
   *
   *  Used by somnus_setup to mint a local trading wallet, so a new user never has to
   *  paste an existing key anywhere. Declared here for the same reason as the rest of
   *  this file: the tarball omits the declaration the exports map points at. */
  export function generatePrivateKey(): `0x${string}`;

  /** The address a private key controls, without building a full account object. */
  export function privateKeyToAddress(privateKey: `0x${string}`): `0x${string}`;
}
