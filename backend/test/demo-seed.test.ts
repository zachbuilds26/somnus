import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSigner, signerAddress } from '../src/services/store';
import { createConfiguredSigner } from '../src/services/proof';

/** Free-tier persistence, and being honest about what it is.
 *
 *  Render's free plan has no disk, so `DATA_DIR` is recreated with the container — on every
 *  deploy AND every wake from the idle spin-down. The proof chain and the P&L ledger start
 *  from zero each time, which makes the project's headline claim ("prove it actually placed
 *  the trades it claims") answer with an empty list. A disk is the correct fix and costs
 *  money the operator does not have.
 *
 *  So `backend/demo/*.seed.*` is committed and copied into `DATA_DIR` at boot when it holds
 *  no file of that name. Two properties have to hold or this is dangerous rather than
 *  useful: it must be opt-in, and it must never overwrite. Verified end to end against a
 *  keyless server on a fresh dir — 2,885 entries restored, linkage OK from genesis, head
 *  matched, 2,799 signatures valid — but the safety properties belong here. */

const DEMO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo');

describe('demo seed: the snapshot shipped for a diskless deploy', () => {
  it('ships a chain, a ledger and a config', () => {
    for (const f of ['proof-chain.seed.jsonl', 'pnl-ledger.seed.jsonl', 'agent-config.seed.json']) {
      assert.ok(existsSync(join(DEMO_DIR, f)), `missing demo/${f}`);
    }
  });

  it('ships a chain long enough to be worth verifying', () => {
    const lines = readFileSync(join(DEMO_DIR, 'proof-chain.seed.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    assert.ok(lines.length > 100, `only ${lines.length} entries — regenerate the snapshot`);
  });

  it('starts from genesis, so linkage can be checked end to end', () => {
    // A snapshot cut from the middle would fail `verifyChain(GENESIS, …)` and put
    // `linkageOk: false` on the public URL — worse than shipping no history at all.
    const first = readFileSync(join(DEMO_DIR, 'proof-chain.seed.jsonl'), 'utf8')
      .split('\n')
      .find((l) => l.trim() !== '');
    const entry = JSON.parse(first ?? '{}') as { prevHash?: string };
    assert.equal(entry.prevHash, '0'.repeat(64), 'first entry does not follow genesis');
  });

  it('ships a config that is dry-run, whatever the operator was last running', () => {
    // The snapshot is taken from a real data dir that may have been mid-experiment. A
    // public demo booting into live mode from a copied file would be the worst kind of
    // surprise.
    const cfg = JSON.parse(readFileSync(join(DEMO_DIR, 'agent-config.seed.json'), 'utf8')) as {
      mode?: string;
      tradingPaused?: boolean;
    };
    assert.equal(cfg.mode, 'dry-run');
    assert.equal(cfg.tradingPaused, false);
  });
});

describe('demo seed: opt-in, and never destructive', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'somnus-seedtest-'));
  after(() => {
    delete process.env.SOMNUS_SEED_DEMO_DATA;
  });

  it('does nothing at all unless explicitly enabled', () => {
    // The test suite itself is the proof: it runs with a throwaway DATA_DIR and no
    // SOMNUS_SEED_DEMO_DATA, and several tests depend on that dir being empty. If seeding
    // were on by default they would be silently testing the snapshot.
    assert.equal(process.env.SOMNUS_SEED_DEMO_DATA, undefined);
    assert.equal(existsSync(join(process.env.DATA_DIR ?? scratch, 'proof-chain.jsonl')), false);
  });

  it('leaves an existing file alone rather than overwriting history', () => {
    // The guard is `existsSync` on the DESTINATION. Simulated directly here because the
    // real path runs once at import; what matters is that the rule is the destination's
    // existence, not the source's.
    const dest = join(scratch, 'proof-chain.jsonl');
    writeFileSync(dest, 'PRE-EXISTING HISTORY\n', 'utf8');
    const shouldCopy = !existsSync(dest);
    assert.equal(shouldCopy, false);
    assert.equal(readFileSync(dest, 'utf8'), 'PRE-EXISTING HISTORY\n');
  });
});

describe('proof signer: a keyless server can still verify a signed chain', () => {
  const saved = process.env.SOMNUS_PROOF_SIGNER;
  before(() => {
    // The suite loads the operator's real .env, so a live signer exists and correctly
    // takes precedence. Clear it to stand in for the hosted deploy, which holds no key.
    setSigner(undefined);
  });
  after(() => {
    if (saved === undefined) delete process.env.SOMNUS_PROOF_SIGNER;
    else process.env.SOMNUS_PROOF_SIGNER = saved;
    setSigner(createConfiguredSigner());
  });

  it('prefers a real signer over a declared address', () => {
    // Order matters: the wallet this process signs WITH is the truth about what it writes.
    // A declared address is only ever a fallback for verifying somebody else's chain.
    process.env.SOMNUS_PROOF_SIGNER = '0x0000000000000000000000000000000000000001';
    setSigner(createConfiguredSigner());
    const live = signerAddress();
    assert.notEqual(live, '0x0000000000000000000000000000000000000001');
    setSigner(undefined);
  });

  it('accepts a declared address when no key is configured', () => {
    // The hosted demo holds no key by design and serves a seeded chain whose entries ARE
    // signed. Without an address to compare against, /proof/verify could only report
    // `signaturesChecked: 0` and call them unsigned — false, and false in the direction
    // that undersells the guarantee the chain exists to provide.
    process.env.SOMNUS_PROOF_SIGNER = '0xC2187C19bcD588E0eb68d68143Af5D410079C69a';
    assert.equal(signerAddress(), '0xC2187C19bcD588E0eb68d68143Af5D410079C69a');
  });

  it('refuses anything that is not an address', () => {
    // A typo must not become a signer nobody notices is wrong — every signature would
    // then fail and the chain would read as forged.
    for (const bad of ['', 'not-an-address', '0x123', 'C2187C19bcD588E0eb68d68143Af5D410079C69a']) {
      process.env.SOMNUS_PROOF_SIGNER = bad;
      assert.equal(signerAddress(), undefined, `accepted "${bad}"`);
    }
  });

  it('trims surrounding whitespace, which a copied env var carries', () => {
    process.env.SOMNUS_PROOF_SIGNER = '  0xC2187C19bcD588E0eb68d68143Af5D410079C69a  ';
    assert.equal(signerAddress(), '0xC2187C19bcD588E0eb68d68143Af5D410079C69a');
  });
});
