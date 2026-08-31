import { describe, it, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEntry,
  chainStateInit,
  computeHash,
  currentAnchor,
  read,
  setSigner,
  resetSigner,
  signerAddress,
  verifyChain,
} from '../src/services/store';
import { verifyProofSignature } from '../src/services/proof';

const GENESIS = '0'.repeat(64);

describe('store: hash chain', () => {
  before(() => {
    setSigner(undefined); // hashing only; signatures are covered separately
    chainStateInit();
  });

  it('links sequential appends and verifies from genesis', async () => {
    chainStateInit();
    for (let i = 0; i < 10; i++) {
      await appendEntry({ kind: 'decision', payload: { i, note: `entry ${i}` } });
    }
    const entries = read(50);
    assert.equal(entries.length, 10);
    const v = verifyChain(GENESIS, entries);
    assert.equal(v.ok, true, 'sequential chain should verify');
    assert.equal(v.checked, 10);
    assert.equal(v.anchor, currentAnchor(), 'recomputed head must equal the running anchor');
  });

  // REGRESSION — this is the bug that actually corrupted a real 341-entry chain.
  // Concurrent appends each read the anchor, awaited, then wrote it back; the
  // running anchor drifted out of step while every individual link still looked
  // valid, so the break only surfaced on the NEXT append.
  it('survives concurrent appends without breaking linkage', async () => {
    chainStateInit();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        appendEntry({ kind: 'order', payload: { i, concurrent: true } }),
      ),
    );
    // One more sequential append: with the old bug this is where it broke.
    await appendEntry({ kind: 'config', payload: { after: true } });

    const entries = read(200);
    assert.equal(entries.length, 26);
    const v = verifyChain(GENESIS, entries);
    assert.equal(v.ok, true, 'concurrent appends must not break the chain');
    assert.equal(v.checked, 26);
    assert.equal(v.anchor, currentAnchor(), 'anchor must not drift under concurrency');
  });

  it('gives every entry a distinct prevHash', async () => {
    chainStateInit();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => appendEntry({ kind: 'decision', payload: { i } })),
    );
    const seen = new Set(read(100).map((e) => e.prevHash));
    assert.equal(seen.size, 20, 'two entries sharing a prevHash means a lost append');
  });

  it('detects a tampered payload', async () => {
    chainStateInit();
    for (let i = 0; i < 5; i++) await appendEntry({ kind: 'decision', payload: { i } });
    const entries = read(10).map((e) => ({ ...e, payload: { ...e.payload } }));
    (entries[2] as { payload: Record<string, unknown> }).payload.i = 999;
    const v = verifyChain(GENESIS, entries);
    assert.equal(v.ok, false, 'edited payload must fail verification');
    assert.equal(v.checked, 2, 'should fail at the tampered entry');
  });

  it('detects a reordered chain', async () => {
    chainStateInit();
    for (let i = 0; i < 5; i++) await appendEntry({ kind: 'decision', payload: { i } });
    const entries = read(10).slice();
    [entries[1], entries[3]] = [entries[3]!, entries[1]!];
    assert.equal(verifyChain(GENESIS, entries).ok, false, 'reordering must fail');
  });

  it('detects a dropped entry', async () => {
    chainStateInit();
    for (let i = 0; i < 5; i++) await appendEntry({ kind: 'decision', payload: { i } });
    const entries = read(10).filter((_, i) => i !== 2);
    assert.equal(verifyChain(GENESIS, entries).ok, false, 'omitting an entry must fail');
  });

  // Canonical hashing: the same content in a different key order must hash the
  // same, so a caller who rebuilds a payload doesn't get a false "tampered".
  it('hashes payloads independently of key order', async () => {
    chainStateInit();
    await appendEntry({ kind: 'decision', payload: { alpha: 1, beta: 2, gamma: { x: 1, y: 2 } } });
    const [entry] = read(1);
    const reordered = {
      ...entry!,
      payload: { gamma: { y: 2, x: 1 }, beta: 2, alpha: 1 } as Record<string, unknown>,
    };
    assert.equal(verifyChain(GENESIS, [reordered]).ok, true, 'key order must not matter');
  });

  it('computeHash is deterministic and order-sensitive', () => {
    assert.equal(computeHash('a', 'b', 'c'), computeHash('a', 'b', 'c'));
    assert.notEqual(computeHash('a', 'b', 'c'), computeHash('b', 'a', 'c'));
  });
});

test('signs entries without anyone installing a signer first', async () => {
  // Signing used to be installed only by server.ts, so any entry appended from a
  // script went silently hash-only — 48 real entries were written that way while
  // the chain still passed linkage checks. Coverage must not depend on which
  // entrypoint booted the process.
  resetSigner();
  chainStateInit();
  const entry = await appendEntry({ kind: 'decision', payload: { probe: 'lazy-signer' } });

  if (signerAddress() === undefined) {
    // No key configured in this environment — then hash-only is correct, and the
    // point of the test is that the two states agree with each other.
    assert.equal(entry.signature, undefined);
    return;
  }
  assert.ok(entry.signature, 'entry should carry a signature when a key is configured');
  const proofHash = computeHash(entry.prevHash, entry.payloadHash, entry.kind);
  assert.equal(
    await verifyProofSignature(proofHash, entry.signature, signerAddress()!),
    true,
    'signature must verify against the configured signer address',
  );
});

test('setSigner(undefined) still means deliberately unsigned', async () => {
  setSigner(undefined);
  chainStateInit();
  const entry = await appendEntry({ kind: 'decision', payload: { probe: 'explicit-off' } });
  assert.equal(entry.signature, undefined);
  resetSigner();
});
