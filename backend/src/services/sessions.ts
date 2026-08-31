import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { sessionAddress } from '@somnia-chain/markets-sdk/native';
import { verifyJWT } from './auth';
import { forgetSessionExchange } from './sdk';
import { warn } from '../config';

// Per-user session keys. A user logs in (Phase 1 → JWT), then we mint a Somnia
// session seed for them. The derived session address is what they fund with
// tUSDC; the agent trades through it. The user's main wallet is never touched —
// this is the non-custodial "their own wallet" model. The seed is the signing
// key for that sub-account, so it is encrypted at rest (even in memory) and is
// revocable; it is never returned to the client.
interface Cipher {
  ct: string;
  iv: string;
  tag: string;
}
interface UserSession {
  enc: Cipher;
  address: string;
  createdAt: number;
}

const userSessions = new Map<string, UserSession>();

function encKey(): Buffer {
  const raw = process.env.SESSION_ENC_KEY ?? process.env.AUTH_SECRET;
  if (!raw) {
    warn('SESSION_ENC_KEY / AUTH_SECRET unset — session seeds encrypted with a dev key. Set SESSION_ENC_KEY in production.');
    return Buffer.alloc(32, 7);
  }
  return createHash('sha256').update(raw).digest();
}

function encrypt(plain: string): Cipher {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ct: ct.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

function decrypt(c: Cipher): string {
  const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(c.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(c.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(c.ct, 'hex')), decipher.final()]).toString('utf8');
}

export function userIdFromAuth(authHeader?: string): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer (.+)$/);
  const token = (m ? m[1] : authHeader) ?? '';
  const decoded = verifyJWT(token);
  return decoded?.sub ? String(decoded.sub) : null;
}

export function createUserSession(userId: string): { address: string; createdAt: number } {
  const seed = ('0x' + randomBytes(32).toString('hex')) as `0x${string}`;
  const address = sessionAddress(seed);
  userSessions.set(userId.toLowerCase(), { enc: encrypt(seed), address, createdAt: Date.now() });
  return { address, createdAt: Date.now() };
}

export function getUserSession(userId: string): { seed: string; address: string; createdAt: number } | undefined {
  const rec = userSessions.get(userId.toLowerCase());
  if (!rec) return undefined;
  return { seed: decrypt(rec.enc), address: rec.address, createdAt: rec.createdAt };
}

export function revokeUserSession(userId: string): boolean {
  const rec = userSessions.get(userId.toLowerCase());
  const removed = userSessions.delete(userId.toLowerCase());
  // Drop any cached signing client for this seed so a revoked key can't be used.
  if (rec) forgetSessionExchange(decrypt(rec.enc) as `0x${string}`);
  return removed;
}

export function sessionSeedFor(userId: string): string | undefined {
  return getUserSession(userId)?.seed;
}
