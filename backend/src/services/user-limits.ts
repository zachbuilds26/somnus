import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, debug, warn } from '../config';
import { readAllFromDisk } from './store';
import { utcDayKey, utcDayStart } from './pnl';
import { maxUserStake } from './user-trading';

/** Per-caller limits a caller sets for themselves.
 *
 *  The server ceilings (`SOMNUS_USER_MAX_TRADE` and friends) exist so no tool argument can
 *  widen the blast radius of a bug or a stolen token. They are not a risk policy for the
 *  person on the other end: 1,000 tUSDC a trade and 20 trades an hour is 20,000 an hour,
 *  and the only thing that stops a caller losing their whole balance is running out of it.
 *  Their agent has six circuit breakers; a caller had two.
 *
 *  ── The one rule that makes this safe ────────────────────────────────────────────
 *
 *  A caller's setting may only ever be TIGHTER than the server's. `effectiveMaxStake` is
 *  `min(theirs, server)`, always, in that direction only. So this can hand out no
 *  authority the caller did not already have, and a corrupt or hand-edited file can widen
 *  nothing.
 *
 *  That rule also decides how the storage hazard is handled rather than hidden. `DATA_DIR`
 *  is recreated with the container on a diskless free tier, so a saved limit is lost on
 *  deploy — and it is lost in the LOOSER direction, back to the server default. That is
 *  the dangerous direction, so every response that depends on these limits reports whether
 *  it is running on a caller's own value or on the default, and `somnus_my_limits` says
 *  when it was set. A limit that silently relaxed itself and said nothing would be worse
 *  than never offering one.
 *
 *  Keyed by HANDLE — the non-reversible HMAC label from identity.ts — never by token. The
 *  file is therefore worth nothing to anyone who steals it. */

const LIMITS_FILE = join(DATA_DIR, 'user-limits.json');

export interface UserLimits {
  /** Collateral ceiling for one trade, tUSDC. Undefined = use the server default. */
  maxPerTrade?: number;
  /** Collateral this caller may commit in one UTC day, tUSDC.
   *
   *  This IS a maximum daily loss, not an approximation of one. Every position here is a
   *  bought outcome token: the cost is paid up front and the worst case is that it settles
   *  worthless. Nothing can lose more than it cost, so a cap on daily spend is exactly a
   *  cap on daily loss — which is why it can be enforced honestly without per-user
   *  settlement tracking that does not exist. */
  maxDailyLoss?: number;
  /** When the caller last changed these, so a value lost to a redeploy is visible. */
  setAt?: number;
}

type LimitsFile = Record<string, UserLimits>;

function readAll(): LimitsFile {
  if (!existsSync(LIMITS_FILE)) return {};
  try {
    const doc = JSON.parse(readFileSync(LIMITS_FILE, 'utf8')) as LimitsFile;
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    // A corrupt file falls back to server defaults, which are TIGHTER than anything a
    // caller could have saved. Failing open here would be failing loose.
    warn('user-limits.json is unreadable — every caller falls back to server defaults');
    return {};
  }
}

/** What this caller has set, if anything. */
export function savedLimits(handle: string): UserLimits {
  return readAll()[handle] ?? {};
}

/** Record a caller's own limits. Returns what was actually stored after clamping.
 *
 *  Clamps rather than rejects: a caller asking for a 5,000 ceiling on a server that allows
 *  1,000 means "as much as you'll let me", and refusing the whole request would leave them
 *  with whatever they had before while believing they had changed it. */
export function saveLimits(handle: string, next: UserLimits): UserLimits {
  const cap = maxUserStake();
  const all = readAll();
  // MERGE, do not replace. Setting one limit must not silently erase the other — a caller
  // tightening their per-trade cap would otherwise lose the daily cap they set a minute
  // ago and never be told. Same class of bug as a partial config PUT clobbering a field it
  // did not mention. Use `reset` to clear both on purpose.
  const clean: UserLimits = { ...(all[handle] ?? {}), setAt: Date.now() };
  if (next.maxPerTrade !== undefined) {
    const n = Number(next.maxPerTrade);
    if (Number.isFinite(n) && n > 0) clean.maxPerTrade = Math.min(n, cap);
  }
  if (next.maxDailyLoss !== undefined) {
    const n = Number(next.maxDailyLoss);
    if (Number.isFinite(n) && n > 0) clean.maxDailyLoss = n;
  }
  all[handle] = clean;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LIMITS_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (err) {
    // Non-fatal, and the failure direction is safe: nothing saved means server defaults,
    // which are tighter. Say so rather than pretending it stuck.
    warn(`could not save user limits: ${(err as Error).message}`);
  }
  return clean;
}

/** Forget a caller's limits, returning them to the server defaults. */
export function clearLimits(handle: string): void {
  const all = readAll();
  if (!(handle in all)) return;
  delete all[handle];
  try {
    writeFileSync(LIMITS_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (err) {
    warn(`could not clear user limits: ${(err as Error).message}`);
  }
}

/** The per-trade ceiling actually in force, and where it came from.
 *
 *  `min` in one direction only. A saved value can tighten this and can never widen it, so
 *  the server ceiling remains the real bound whatever the file says. */
export function effectiveMaxStake(handle: string): {
  cap: number;
  serverCap: number;
  source: 'default' | 'custom';
} {
  const serverCap = maxUserStake();
  const own = savedLimits(handle).maxPerTrade;
  if (own === undefined) return { cap: serverCap, serverCap, source: 'default' };
  return { cap: Math.min(own, serverCap), serverCap, source: 'custom' };
}

/** Collateral this caller has committed since 00:00 UTC.
 *
 *  Summed from the signed audit chain rather than from a second ledger, deliberately.
 *  A caller's orders are already recorded there (`via: 'mcp-user'`, keyed by handle), so
 *  a separate per-user tally would be a second source of truth that could disagree with
 *  the audit trail — and the audit trail is the one this project asks people to believe.
 *
 *  Counts only orders that reached the venue. A rejected order committed nothing. */
export function spentToday(handle: string, now = Date.now()): number {
  const since = utcDayStart(now);
  let total = 0;
  for (const e of readAllFromDisk()) {
    if (e.kind !== 'order' || e.ts < since) continue;
    const p = e.payload as Record<string, unknown>;
    if (p.via !== 'mcp-user' || p.user !== handle) continue;
    if (p.status !== 'submitted') continue;
    const cost = Number(p.cost);
    if (Number.isFinite(cost) && cost > 0) total += cost;
  }
  return Math.round(total * 100) / 100;
}

export interface DailyVerdict {
  ok: boolean;
  spent: number;
  limit?: number;
  remaining?: number;
  dayUtc: string;
  reason?: string;
}

/** Would this trade breach the caller's own daily cap?
 *
 *  No cap set means no check — the server does not impose one, and inventing a default
 *  here would change behaviour for every existing caller without being asked. */
export function checkDailyLimit(handle: string, cost: number, now = Date.now()): DailyVerdict {
  const limit = savedLimits(handle).maxDailyLoss;
  const spent = spentToday(handle, now);
  const dayUtc = utcDayKey(now);
  if (limit === undefined) return { ok: true, spent, dayUtc };
  const remaining = Math.round((limit - spent) * 100) / 100;
  if (spent + cost > limit) {
    return {
      ok: false,
      spent,
      limit,
      remaining: Math.max(0, remaining),
      dayUtc,
      reason:
        `this trade costs ${cost.toFixed(2)} and you have committed ${spent.toFixed(2)} of your ` +
        `${limit} daily limit, leaving ${Math.max(0, remaining).toFixed(2)}. Every position here ` +
        'is a bought outcome token, so its cost IS its worst case — this cap is a real maximum ' +
        `daily loss. It resets at 00:00 UTC (currently ${dayUtc}), or raise it with ` +
        'somnus_my_limits.',
    };
  }
  debug(`user ${handle}: ${spent} of ${limit} spent today`);
  return { ok: true, spent, limit, remaining, dayUtc };
}
