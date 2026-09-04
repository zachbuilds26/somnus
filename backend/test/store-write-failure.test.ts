import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A lost audit trail must not look healthy.
 *
 *  `persistLine` caught every write error and said nothing. On a full or read-only
 *  disk the entries lived in memory only: `/health` reported `proofEntries` climbing,
 *  every /proof read looked normal, and the whole chain vanished on restart. For a
 *  project whose central claim is "signed, verifiable history", losing the history
 *  quietly is the worst available failure — and `risk.ts` already warned in this
 *  exact situation, so the silence was not even consistent.
 *
 *  The setup: point DATA_DIR at a path UNDER a regular file. `mkdirSync` then fails
 *  with ENOTDIR on every append, which is a real filesystem error rather than a
 *  stubbed one. DATA_DIR is read when config.ts is evaluated, so the env has to be
 *  set before the dynamic import below. */
const scratch = mkdtempSync(join(tmpdir(), 'somnus-nowrite-'));
const blocker = join(scratch, 'not-a-directory');
writeFileSync(blocker, 'this is a file, so nothing can be created beneath it', 'utf8');
process.env.DATA_DIR = join(blocker, 'data');

const store = await import('../src/services/store');

describe('store: a proof chain that cannot be written says so', () => {
  before(() => {
    // Nothing is signed here — the signature path is covered elsewhere, and this is
    // about the write. Unsigned keeps the failure attributable to one cause.
    store.setSigner(undefined);
  });
  after(() => {
    delete process.env.DATA_DIR;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('reports no failure before anything has been written', () => {
    assert.equal(store.chainWriteFailure(), undefined);
  });

  it('records the failure instead of swallowing it', async () => {
    await store.appendEntry({ kind: 'decision', payload: { note: 'first' } }, false);
    const f = store.chainWriteFailure();
    assert.ok(f, 'expected a recorded write failure');
    assert.equal(f.count, 1);
    assert.ok(f.error.length > 0);
    assert.ok(f.at > 0);
  });

  it('counts repeats without re-warning, so a broken disk is not a log flood', async () => {
    await store.appendEntry({ kind: 'decision', payload: { note: 'second' } }, false);
    await store.appendEntry({ kind: 'decision', payload: { note: 'third' } }, false);
    assert.equal(store.chainWriteFailure()?.count, 3);
  });

  it('still appends in memory, so the agent keeps running', () => {
    // Deliberate: a storage fault must not take down the trading loop. The point of
    // the flag is that the operator finds out, not that the process stops.
    assert.equal(store.count(), 3);
  });
});
