import { createHmac, timingSafeEqual } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

/** Per-user wallets, derived rather than stored.
 *
 *  The hosted deployment has no durable filesystem — Render wipes a service's local
 *  files on every deploy and every wake from idle. A user wallet written to disk
 *  would therefore be destroyed the next time the code is pushed, taking whatever
 *  the user had deposited with it. That is not an acceptable failure mode, and a
 *  persistent disk costs money this project does not have.
 *
 *  So nothing is stored. A caller supplies a secret token; their wallet key is
 *  HMAC-SHA256(server secret, token). The same token always yields the same wallet,
 *  and the derivation is recomputed per request:
 *
 *      user token ──HMAC(SOMNUS_USER_SECRET)──▶ private key ──▶ address
 *
 *  Nothing to wipe, nothing to back up, nothing to migrate. Survives deploys because
 *  the only durable input is an environment variable.
 *
 *  ── What this is honestly NOT ────────────────────────────────────────────────
 *  This is CUSTODIAL. The server can derive any user's key, so it can move any
 *  user's funds. There is no way around that on this venue: Somnia has no scoped
 *  permission — the SDK states plainly that a session seed "is a private key in
 *  another shape" and its holder "can move the session account's funds". A hosted
 *  agent that trades for you necessarily holds something that could also drain you.
 *
 *  It is acceptable here for one reason only: these are TESTNET wallets funded from
 *  a faucet, so the balance has no market value. Do not point this at mainnet, and
 *  do not let anyone deposit anything they would miss.                          */

/** Minimum token length. A short token is guessable, and guessing someone's token
 *  is guessing their wallet — there is no second factor behind it. */
export const MIN_TOKEN_LENGTH = 24;

/** The header a caller identifies themselves with. */
export const TOKEN_HEADER = 'x-somnus-token';

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** The server-side secret that turns a user token into a key.
 *
 *  Read lazily rather than at import so the read-only tools still work on a
 *  deployment that never sets it — a server with no user secret simply offers no
 *  per-user trading, instead of failing to boot. */
function serverSecret(): string {
  const secret = process.env.SOMNUS_USER_SECRET;
  if (!secret || secret.length < 32) {
    throw new IdentityError(
      'This deployment has no per-user wallet support: SOMNUS_USER_SECRET is unset or too ' +
        'short (needs 32+ characters). The read-only tools work without it.',
    );
  }
  return secret;
}

/** True when this deployment can derive user wallets at all. */
export function perUserWalletsEnabled(): boolean {
  const secret = process.env.SOMNUS_USER_SECRET;
  return typeof secret === 'string' && secret.length >= 32;
}

export interface UserIdentity {
  /** Private key for this user's wallet. Never leaves the process. */
  privateKey: `0x${string}`;
  address: `0x${string}`;
  /** Short, non-reversible label for logs and audit entries. Safe to display —
   *  it identifies the account without revealing the token that controls it. */
  handle: string;
}

/** Derive a user's wallet from their token.
 *
 *  HMAC rather than a plain hash so the server secret is a real key: without it a
 *  token is useless, and someone who learns one user's token learns nothing about
 *  any other. The output is reduced into the valid secp256k1 range in the same
 *  retry-on-overflow way key derivation normally is — the loop is unreachable in
 *  practice (a 256-bit digest lands outside the curve order with probability under
 *  2^-128) but returning an invalid key would be worse than looping. */
export function identityFromToken(token: string): UserIdentity {
  const secret = serverSecret();
  const trimmed = token.trim();
  if (trimmed.length < MIN_TOKEN_LENGTH) {
    throw new IdentityError(
      `Your token must be at least ${MIN_TOKEN_LENGTH} characters. It is the only thing ` +
        'protecting your wallet, so use a long random string and keep it like a password.',
    );
  }

  const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  for (let i = 0; i < 256; i++) {
    const digest = createHmac('sha256', secret).update(`${trimmed}:${i}`).digest('hex');
    const value = BigInt(`0x${digest}`);
    if (value > 0n && value < SECP256K1_N) {
      const privateKey = `0x${digest}` as `0x${string}`;
      const address = privateKeyToAccount(privateKey).address;
      return {
        privateKey,
        address,
        // A separate HMAC, so the handle cannot be walked back to the token even if
        // it appears in a log or an audit entry.
        handle: createHmac('sha256', secret).update(`handle:${trimmed}`).digest('hex').slice(0, 12),
      };
    }
  }
  throw new IdentityError('could not derive a valid key from this token');
}

/** Pull the caller's identity out request headers, or explain what is missing.
 *
 *  Returns undefined rather than throwing when no token is present: an anonymous
 *  caller is a legitimate, expected state — they get the read-only tools. */
export function identityFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): UserIdentity | undefined {
  const raw = headers[TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (typeof token !== 'string' || token.trim().length === 0) return undefined;
  return identityFromToken(token);
}

/** Constant-time token comparison, for anywhere a token is checked rather than
 *  derived from. Avoids leaking length-prefix information through timing. */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
