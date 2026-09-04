import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR, warn } from '../config';
import { createConfiguredSigner } from './proof';
import type { Signer } from './proof';

const STORE_PREFIX = 'somnus';
const GENESIS = '0'.repeat(64);
const CHAIN_FILE = join(DATA_DIR, 'proof-chain.jsonl');

export interface PendingEntry {
  kind: 'decision' | 'order' | 'claim' | 'config';
  payload: Record<string, unknown>;
}

export interface ChainEntry {
  id: string;
  ts: number;
  prevHash: string;
  payloadHash: string;
  signature?: string;
  kind: PendingEntry['kind'];
  payload: Record<string, unknown>;
}

let signer: Signer | undefined;
/** Tri-state: has a signer been chosen explicitly, or should we resolve one from
 *  config on first use? Needed because `setSigner(undefined)` must be able to mean
 *  "deliberately unsigned" and not "not decided yet". */
let signerChosen = false;
let signWarned = false;
let anchor = GENESIS;
let entrySerial = 0;

/** In-memory window over the chain.
 *
 *  The JSONL file is the source of truth; this array only backs the recent-entry
 *  reads the API serves. An unbounded array would grow ~14 entries per cycle
 *  forever — a loop left running overnight is a slow memory leak, and full-chain
 *  verification would walk an ever-larger array on every call. Bounded here;
 *  verification reads the file instead (see `readAllFromDisk`). */
const MAX_MEMORY_ENTRIES = 5_000;
const chain: ChainEntry[] = [];
/** Total appended over the process's life plus whatever was restored, which is
 *  NOT chain.length once the window starts evicting. */
let totalEntries = 0;

export function setSigner(s: Signer | undefined): void {
  signer = s;
  signerChosen = true;
}

/** The signer to use, resolving one from config the first time if nobody set it.
 *
 *  This used to be install-on-demand from `server.ts` only, which made signature
 *  coverage depend on the ENTRYPOINT: entries appended by a script (a backtest, a
 *  one-off trade run, anything not booted through express) were silently written
 *  hash-only. 48 real entries went unsigned that way while the chain still looked
 *  healthy, because hash linkage verified fine. "Signed audit trail" has to hold
 *  however the code was invoked, so resolve it here instead of at the edge.    */
function activeSigner(): Signer | undefined {
  if (!signerChosen) {
    signer = createConfiguredSigner();
    signerChosen = true;
    if (!signer) {
      warn('no proof key configured — chain will be hash-only (set TRADE_KEY or PRIVATE_KEY)');
    }
  }
  return signer;
}

/** Forget an explicitly-set signer so the next append resolves from config again.
 *  For tests. */
export function resetSigner(): void {
  signer = undefined;
  signerChosen = false;
}

/** Address the chain is signed by, when a signer is configured. */
export function signerAddress(): string | undefined {
  return activeSigner()?.address;
}

export function chainStateInit(seed?: Partial<{ anchor: string; entries: ChainEntry[] }>): void {
  anchor = seed?.anchor ?? GENESIS;
  chain.length = 0;
  if (seed?.entries) chain.push(...seed.entries);
  entrySerial = chain.length;
  totalEntries = chain.length;
  diskCache = undefined;
}

/** Canonical (key-sorted) JSON, so a payload hashes the same regardless of the
 *  order its keys happen to be in.
 *
 *  `JSON.stringify` is insertion-ordered. Entries written and then re-read from
 *  the file round-trip fine, which is why this was never visibly broken — but a
 *  caller who POSTs a reconstructed payload to /proof/verify with the same
 *  fields in a different order gets a spurious "tampered" result. Sorting makes
 *  the hash a function of the content alone. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue; // match JSON.stringify's omission
    parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  }
  return `{${parts.join(',')}}`;
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** Pre-canonical hashing, kept so chains written before the change still verify.
 *  Dropping this would invalidate every historical entry — including real
 *  on-chain trades — which is a worse outcome than carrying one fallback. */
function legacyHashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Does this stored payloadHash match the payload under either scheme? */
function payloadHashMatches(entry: ChainEntry): { ok: boolean; hash: string } {
  const canonical = hashPayload(entry.payload);
  if (entry.payloadHash === canonical) return { ok: true, hash: canonical };
  const legacy = legacyHashPayload(entry.payload);
  if (entry.payloadHash === legacy) return { ok: true, hash: legacy };
  return { ok: false, hash: canonical };
}

/** Restore the audit chain from the append-only JSONL store at boot.
 *  Returns how many entries were restored. Unparseable trailing lines
 *  (possible crash mid-append) are skipped.                         */
function loadPersistedChain(): number {
  if (!existsSync(CHAIN_FILE)) return 0;
  const lines = readFileSync(CHAIN_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const restored: ChainEntry[] = [];
  for (const line of lines) {
    try {
      const node = JSON.parse(line) as ChainEntry;
      if (typeof node?.id !== 'string' || typeof node?.payloadHash !== 'string') continue;
      restored.push(node);
    } catch {
      /* skip a torn line left by a crash */
    }
  }
  if (restored.length === 0) return 0;
  const recheck = verifyChain(GENESIS, restored);
  // Keep only the most recent window in memory; the file holds everything.
  chain.push(...restored.slice(-MAX_MEMORY_ENTRIES));
  if (recheck.ok) {
    anchor = recheck.anchor;
  } else {
    // The file may predate the current chain scheme, or have been edited. Keep
    // the history but resume from the true head — the hash *after* the last
    // entry. Resuming from `last.prevHash` (the anchor BEFORE it) would make the
    // next append reuse that prevHash and fork the chain at the tip.
    const last = restored.at(-1);
    if (last) anchor = computeHash(last.prevHash, last.payloadHash, last.kind);
    warn(
      `proof chain file failed linkage recheck after ${recheck.checked}/${restored.length} entries — ` +
        'history preserved, resuming from the last entry\'s computed head',
    );
  }
  entrySerial = restored.length;
  totalEntries = restored.length;
  return restored.length;
}

/** Has a proof-chain write ever failed, and why.
 *
 *  A silent `catch` here meant a full or read-only disk produced an agent whose
 *  entries lived only in memory: `/health` went on reporting `proofEntries`
 *  climbing, every /proof read looked normal, and the entire audit trail vanished
 *  on restart. For a project whose central claim is "signed, verifiable history",
 *  losing the history quietly is the worst available failure. `risk.ts` already
 *  warns in this exact situation; this did not. */
let writeFailure: { at: number; error: string; count: number } | undefined;

/** Non-null when the durable chain write has failed. Surfaced on /health so a lost
 *  audit trail is visible without reading the logs. */
export function chainWriteFailure(): { at: number; error: string; count: number } | undefined {
  return writeFailure;
}

/** Append one entry to the durable JSONL store. Never throws into the caller. */
function persistLine(node: ChainEntry): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(CHAIN_FILE, `${JSON.stringify(node)}\n`, 'utf8');
    // Recovered. Keep the incident out of /health once writes land again, so the
    // flag means "right now", not "at some point today".
    if (writeFailure) {
      warn(`proof chain writes recovered after ${writeFailure.count} failure(s)`);
      writeFailure = undefined;
    }
  } catch (err) {
    const error = (err as Error).message ?? String(err);
    // Warn on the first failure only — this sits on the append path and a read-only
    // disk would otherwise emit one line per entry forever. The count keeps the
    // scale visible without the noise.
    if (!writeFailure) {
      warn(
        `PROOF CHAIN WRITE FAILED (${error}) — entries are being kept in memory only and will be ` +
          `LOST on restart. Check disk space and permissions on ${DATA_DIR}.`,
      );
      writeFailure = { at: Date.now(), error, count: 1 };
    } else {
      writeFailure = { at: Date.now(), error, count: writeFailure.count + 1 };
    }
  } finally {
    // Whether or not the write landed, the parsed cache is no longer authoritative.
    diskCache = undefined;
  }
}

export function computeHash(prev: string, payloadHash: string, kind: string): string {
  return createHash('sha256').update(prev + payloadHash + kind).digest('hex');
}

function nextEntryId(): string {
  const n = (++entrySerial).toString(36).padStart(6, '0');
  return `${STORE_PREFIX}-${n}-${randomBytes(3).toString('hex')}`;
}

/** Serialise appends.
 *
 *  `appendEntry` reads the module-level `anchor`, awaits the signature, then
 *  writes `anchor` back. Today local secp256k1 signing does no I/O, so the body
 *  happens to finish inside one event-loop turn and nothing interleaves — but
 *  the invariant "one append at a time" is load-bearing for the whole chain and
 *  is currently protected only by that accident. A remote signer, an HSM, or one
 *  extra `await` would silently start emitting entries that share a `prevHash`.
 *  A one-line queue makes the guarantee explicit instead of incidental.       */
let appendTail: Promise<unknown> = Promise.resolve();

export function appendEntry(entry: PendingEntry, sign = true): Promise<ChainEntry> {
  const run = appendTail.then(() => appendEntryUnsafe(entry, sign));
  // Keep the queue alive even if one append rejects.
  appendTail = run.catch(() => undefined);
  return run;
}

async function appendEntryUnsafe(entry: PendingEntry, sign = true): Promise<ChainEntry> {
  const payloadHash = hashPayload(entry.payload);
  const proofHash = computeHash(anchor, payloadHash, entry.kind);
  let signature: string | undefined;
  const active = sign ? activeSigner() : undefined;
  if (active) {
    try {
      signature = await active.sign(proofHash);
    } catch (err) {
      // Never fail an append over signing, but say so once — silently dropping
      // signatures makes an "unsigned" chain look intentional.
      if (!signWarned) {
        signWarned = true;
        warn('proof signing failed, entries will be hash-only:', (err as Error).message ?? String(err));
      }
      signature = undefined;
    }
  }
  const node: ChainEntry = {
    id: nextEntryId(),
    ts: Date.now(),
    prevHash: anchor,
    payloadHash,
    signature,
    kind: entry.kind,
    payload: entry.payload,
  };
  chain.push(node);
  totalEntries++;
  if (chain.length > MAX_MEMORY_ENTRIES) chain.splice(0, chain.length - MAX_MEMORY_ENTRIES);
  anchor = proofHash;
  persistLine(node);
  return node;
}

export function read(limit = 50): ChainEntry[] {
  return chain.slice(-limit);
}

/** Every entry, straight from the durable file.
 *
 *  Full-chain verification must not read the in-memory window: once it starts
 *  evicting, "verify the whole chain" would quietly verify only the tail and
 *  still report ok — the failure mode where the check that is supposed to catch
 *  tampering stops looking at most of the data. Falls back to the window if the
 *  file is unreadable.
 *
 *  Cached on mtime AND size, because this is no longer only the verifier's path:
 *  `readChainPage` serves /agent/logs and /proof from it, so a dashboard with four
 *  polling panels was re-reading 1.5 MB four times per refresh. Our own appends
 *  invalidate directly; an external edit moves mtime or size. */
let diskCache: { rows: ChainEntry[]; mtimeMs: number; size: number } | undefined;

export function readAllFromDisk(): ChainEntry[] {
  if (!existsSync(CHAIN_FILE)) return chain.slice();
  try {
    const s = statSync(CHAIN_FILE);
    if (diskCache && diskCache.mtimeMs === s.mtimeMs && diskCache.size === s.size) {
      return diskCache.rows;
    }
    const lines = readFileSync(CHAIN_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const out: ChainEntry[] = [];
    for (const line of lines) {
      try {
        const node = JSON.parse(line) as ChainEntry;
        if (typeof node?.payloadHash === 'string' && typeof node?.prevHash === 'string') out.push(node);
      } catch {
        /* torn line */
      }
    }
    diskCache = { rows: out, mtimeMs: s.mtimeMs, size: s.size };
    return out;
  } catch {
    return chain.slice();
  }
}

export function tail(): ChainEntry | undefined {
  return chain.at(-1);
}

export interface ChainQuery {
  limit?: number;
  /** Restrict to one entry kind. */
  kind?: unknown;
  /** Inclusive lower/upper bound on entry timestamp (ms). */
  since?: unknown;
  until?: unknown;
  /** Entry id to page backwards from — everything strictly OLDER than this. */
  cursor?: unknown;
}

export interface ChainPage {
  entries: ChainEntry[];
  /** Pass as `cursor` to fetch the next (older) page. undefined when exhausted. */
  nextCursor?: string;
  hasMore: boolean;
  /** How many entries matched the filter before the limit was applied. */
  matched: number;
}

/** A filtered, paged window over the chain, newest first.
 *
 *  Reads from disk rather than the in-memory window: the window is bounded at
 *  MAX_MEMORY_ENTRIES so a UI paging into history would silently run out of chain
 *  and show an empty page rather than older entries.
 *
 *  Paging is by entry id, not by offset. Offsets shift under an append-only log —
 *  a client that paged while the agent was trading would see the same entries twice
 *  and miss others, which for an audit trail is worse than a slower query. */
export function readChainPage(query: ChainQuery = {}): ChainPage {
  const limit = Math.min(Math.max(Math.floor(Number(query.limit) || 100), 1), 1000);
  const kind = typeof query.kind === 'string' && query.kind.length > 0 ? query.kind : undefined;
  const since = Number.isFinite(Number(query.since)) ? Number(query.since) : undefined;
  const until = Number.isFinite(Number(query.until)) ? Number(query.until) : undefined;
  const cursor = typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : undefined;

  const all = readAllFromDisk();
  // Newest first is what every caller wants, and it makes the cursor a suffix cut.
  let rows = all.slice().reverse();

  if (cursor) {
    const at = rows.findIndex((e) => e.id === cursor);
    // An unknown cursor means the caller is holding an id from a different chain or a
    // repaired one. Returning page one would silently restart their pagination, so
    // return nothing and let them notice.
    rows = at === -1 ? [] : rows.slice(at + 1);
  }
  if (kind) rows = rows.filter((e) => e.kind === kind);
  if (since !== undefined) rows = rows.filter((e) => e.ts >= since);
  if (until !== undefined) rows = rows.filter((e) => e.ts <= until);

  const entries = rows.slice(0, limit);
  const hasMore = rows.length > entries.length;
  return {
    entries,
    nextCursor: hasMore ? entries.at(-1)?.id : undefined,
    hasMore,
    matched: rows.length,
  };
}

export function currentAnchor(): string {
  return anchor;
}

export function count(): number {
  return totalEntries;
}

/** Re-hash a contiguous slice (assumed to start right after the given prevAnchor).
 *  Accepts either hashing scheme per entry so historical chains stay verifiable. */
export function verifyChain(startAnchor: string, entries: ChainEntry[]): { ok: boolean; anchor: string; checked: number } {
  let cursor = startAnchor;
  let ok = true;
  let checked = 0;
  for (const e of entries) {
    const match = payloadHashMatches(e);
    if (e.prevHash !== cursor || !match.ok) {
      ok = false;
      break;
    }
    // Chain forward with the STORED hash, which is the one the original
    // computeHash used — re-deriving with the other scheme would break linkage.
    cursor = computeHash(e.prevHash, e.payloadHash, e.kind);
    checked++;
  }
  return { ok, anchor: cursor, checked };
}

// Restore the audit chain from disk on first import (append-only JSONL log).
// Tests/normal ops that want a clean slate call chainStateInit() explicitly.
const restoredCount = loadPersistedChain();
if (restoredCount > 0) {
  console.log(`[somnus] restored ${restoredCount} proof entries from ${CHAIN_FILE}`);
}