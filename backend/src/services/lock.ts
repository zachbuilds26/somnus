import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, log, warn } from '../config';

/** Single-instance lock.
 *
 *  backend/README.md documents three concurrency invariants won the hard way: one
 *  proof append at a time, one cycle at a time, one claim at a time. All three are
 *  enforced with module-level state, which means all three hold within ONE process
 *  and none of them hold across two.
 *
 *  Two `npm start` processes on the same data dir would interleave appends to
 *  proof-chain.jsonl — the exact corruption that produced five linkage breaks and
 *  the backup files still sitting in data/ — while both spent the same position
 *  budget and both wrote the same ledger. Nothing prevented that until this file.
 *
 *  A lock is only honest if it can be broken safely: a process killed with SIGKILL
 *  leaves the file behind, and refusing to ever start again would be worse than the
 *  problem. So the lock records a pid and is taken over when that pid is gone. */

const LOCK_PATH = join(DATA_DIR, 'somnus.lock');

interface LockDoc {
  pid: number;
  startedAt: number;
  host?: string;
}

export class LockHeldError extends Error {
  constructor(public readonly holder: LockDoc) {
    super(
      `another Somnus process is already running (pid ${holder.pid}, started ` +
        `${new Date(holder.startedAt).toISOString()}). Two processes on one data dir ` +
        'corrupt the proof chain and double-spend the position budget. Stop it first, ' +
        `or delete ${LOCK_PATH} if you are certain it is dead.`,
    );
    this.name = 'LockHeldError';
  }
}

/** Is a pid still running? `signal 0` checks for existence without delivering
 *  anything, and works on Windows as well as POSIX. EPERM means the process exists
 *  but belongs to another user — still alive, so still a conflict. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(): LockDoc | undefined {
  try {
    const doc = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Partial<LockDoc>;
    const pid = Number(doc.pid);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return { pid, startedAt: Number(doc.startedAt) || 0, host: doc.host };
  } catch {
    // Unreadable or torn lock file carries no claim. Treating a corrupt lock as
    // held would wedge the agent permanently on a bad write.
    return undefined;
  }
}

let held = false;

/** Take the lock, or throw {@link LockHeldError}. */
export function acquireLock(): void {
  const existing = readLock();
  if (existing && pidAlive(existing.pid) && existing.pid !== process.pid) {
    throw new LockHeldError(existing);
  }
  if (existing) {
    warn(
      `stale lock from pid ${existing.pid} (no longer running) — taking over. ` +
        'If that process died mid-cycle, run GET /api/agent/reconcile before trading.',
    );
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const doc: LockDoc = { pid: process.pid, startedAt: Date.now(), host: process.env.HOSTNAME };
  writeFileSync(LOCK_PATH, JSON.stringify(doc, null, 2), 'utf8');
  held = true;
  log(`instance lock acquired (pid ${process.pid})`);
}

/** Release the lock, but only if we still own it. A process that lost its lock to a
 *  takeover must not delete the new holder's claim on its way out. */
export function releaseLock(): void {
  if (!held) return;
  held = false;
  const current = readLock();
  if (current && current.pid !== process.pid) return;
  try {
    rmSync(LOCK_PATH, { force: true });
  } catch {
    /* nothing we can do at shutdown */
  }
}

export function lockInfo(): { path: string; held: boolean; holder?: LockDoc } {
  return { path: LOCK_PATH, held, holder: existsSync(LOCK_PATH) ? readLock() : undefined };
}
