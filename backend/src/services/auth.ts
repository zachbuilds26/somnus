import { createHmac } from 'node:crypto';
import { verifyMessage } from 'viem';

const AUTH_SECRET = process.env.AUTH_SECRET ?? 'dev-only-somnus-auth-secret-change-me';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface Pending {
  nonce: string;
  expires: number;
}
const pending = new Map<string, Pending>();

function loginMessage(nonce: string): string {
  return `Somnus login.\nSign this nonce to authenticate your wallet.\nNonce: ${nonce}`;
}

function signJWT(payload: Record<string, unknown>, ttlSec = 3600): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(body)}`;
  const sig = createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyJWT(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const sig = createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  if (sig !== s) return null;
  try {
    const body = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
    if (typeof body.exp === 'number' && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

export function issueChallenge(address: string): { nonce: string; message: string } {
  const nonce = createHmac('sha256', String(Date.now()) + Math.random()).digest('hex');
  pending.set(address.toLowerCase(), { nonce, expires: Date.now() + CHALLENGE_TTL_MS });
  return { nonce, message: loginMessage(nonce) };
}

export async function verifyChallenge(
  address: string,
  signature: string,
): Promise<{ ok: boolean; token?: string; reason?: string }> {
  const key = address.toLowerCase();
  const rec = pending.get(key);
  if (!rec) return { ok: false, reason: 'no challenge issued for this address' };
  if (rec.expires < Date.now()) {
    pending.delete(key);
    return { ok: false, reason: 'challenge expired' };
  }
  let valid = false;
  try {
    valid = await verifyMessage({
      address: key as `0x${string}`,
      message: loginMessage(rec.nonce),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'signature does not match address' };
  }
  pending.delete(key);
  return { ok: true, token: signJWT({ sub: key, address: key }) };
}
