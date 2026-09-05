import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyProofSignature, __resetSignatureMemoForTests } from '../src/services/proof';
import { computeHash, setSigner, appendEntry, chainStateInit } from '../src/services/store';
import { createProofSigner } from '../src/services/proof';

/** `POST /proof/verify` was a denial of service, and a measured one.
 *
 *  The route is deliberately exempt from the gateway key: "anyone can audit the chain" is
 *  the project's central claim and a POST that needs the operator's secret does not
 *  deliver it. But opening it without bounding its cost meant an empty body — "verify
 *  everything" — spent one ECDSA public-key recovery per signed entry. Against the live
 *  deployment that was 2,799 recoveries and 78 seconds of CPU, from a single
 *  unauthenticated request, growing with the chain forever. The pre-existing
 *  `MAX_VERIFY_ENTRIES` did not help: it only ever bounded CALLER-SUPPLIED slices, and
 *  omitting `entries` skipped it entirely.
 *
 *  Three things fixed it, and the memo tested here is the one that does the real work:
 *  the answer for a given (hash, signature, address) never changes, because all three are
 *  immutable once an entry is written. Verification was re-answering thousands of
 *  identical questions on every call.
 *
 *  Measured on a seeded 2,885-entry chain: 78s -> 9.2s cold, 0.01s on repeat via the
 *  route cache, and 0.30s for the same work with the route cache deliberately bypassed —
 *  that last number is this memo. */

const HASH_A = computeHash('a'.repeat(64), 'b'.repeat(64), 'decision');
const HASH_B = computeHash('c'.repeat(64), 'd'.repeat(64), 'order');
const KEY = `0x${'11'.repeat(32)}` as const;

describe('signature memo: the same question is only ever asked once', () => {
  let signer: ReturnType<typeof createProofSigner>;
  let sigA = '';
  let addr = '';

  before(async () => {
    signer = createProofSigner(KEY);
    assert.ok(signer, 'test signer failed to build');
    addr = signer.address ?? '';
    sigA = await signer.sign(HASH_A);
    __resetSignatureMemoForTests();
  });
  after(() => __resetSignatureMemoForTests());

  it('returns the same verdict on a repeat as on the first call', async () => {
    const first = await verifyProofSignature(HASH_A, sigA, addr);
    const second = await verifyProofSignature(HASH_A, sigA, addr);
    assert.equal(first, true, 'a freshly made signature should verify');
    assert.equal(second, first);
  });

  it('answers a repeat far faster than the first call', async () => {
    // The point of the whole change. Not asserting a hard millisecond figure — CI
    // machines vary — but a cached answer must be dramatically cheaper than a recovery,
    // which measures ~36ms.
    __resetSignatureMemoForTests();
    const t1 = Date.now();
    await verifyProofSignature(HASH_A, sigA, addr);
    const cold = Date.now() - t1;
    const t2 = Date.now();
    for (let i = 0; i < 50; i++) await verifyProofSignature(HASH_A, sigA, addr);
    const warm50 = Date.now() - t2;
    assert.ok(warm50 < cold * 5, `50 cached checks (${warm50}ms) should beat 5 cold ones (${cold}ms each)`);
  });

  it('does not answer one question with another question\'s result', async () => {
    // The key is the whole triple. A memo keyed on the hash alone would let a valid
    // signature over entry A vouch for entry B — which is exactly the forgery this route
    // exists to detect.
    assert.equal(await verifyProofSignature(HASH_A, sigA, addr), true);
    assert.equal(await verifyProofSignature(HASH_B, sigA, addr), false);
  });

  it('does not carry an answer across a change of expected signer', async () => {
    // Repointing SOMNUS_PROOF_SIGNER must re-prove everything. Inheriting the previous
    // signer's verdict would report a foreign chain as authentic.
    assert.equal(await verifyProofSignature(HASH_A, sigA, addr), true);
    const other = '0x0000000000000000000000000000000000000001';
    assert.equal(await verifyProofSignature(HASH_A, sigA, other), false);
  });

  it('caches a NEGATIVE result too, so a forgery is cheap to re-reject', async () => {
    const bogus = `0x${'ab'.repeat(65)}`;
    assert.equal(await verifyProofSignature(HASH_A, bogus, addr), false);
    assert.equal(await verifyProofSignature(HASH_A, bogus, addr), false);
  });
});

describe('chain verification still detects tampering with the memo in place', () => {
  before(() => {
    chainStateInit();
    __resetSignatureMemoForTests();
    setSigner(createProofSigner(KEY));
  });
  after(() => {
    setSigner(undefined);
    chainStateInit();
    __resetSignatureMemoForTests();
  });

  it('a signature over one entry does not validate an altered one', async () => {
    // End to end: write a real signed entry, then verify its signature against a hash
    // computed from DIFFERENT contents. A cache that ignored the hash would pass this.
    const e = await appendEntry({ kind: 'decision', payload: { note: 'genuine' } });
    assert.ok(typeof e.signature === 'string' && e.signature.length > 0, 'entry was not signed');
    const honest = computeHash(e.prevHash, e.payloadHash, e.kind);
    const tampered = computeHash(e.prevHash, 'f'.repeat(64), e.kind);
    const addr = createProofSigner(KEY)?.address ?? '';
    assert.equal(await verifyProofSignature(honest, e.signature, addr), true);
    assert.equal(await verifyProofSignature(tampered, e.signature, addr), false);
  });
});
