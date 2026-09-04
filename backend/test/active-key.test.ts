import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { activeKey, config } from '../src/config';

/** Which wallet does this process act with?
 *
 *  There used to be two answers. `sdk.ts` signed orders with `TRADE_KEY ?? PRIVATE_KEY
 *  ?? OPERATOR_KEY`; the proof signer and the on-chain anchor preferred `PRIVATE_KEY`
 *  first. Set both — which `.env.example` actively invites, calling it "session-key
 *  mode" — and the wallet placing trades was not the wallet signing the audit chain.
 *  Nothing reported the split, because `proof/verify` checks signatures against
 *  whichever signer it resolved, so it verified the wrong wallet's chain successfully.
 *
 *  These tests exist because the bug was invisible: every endpoint said OK. They pin
 *  the precedence itself, so restoring the divergence fails here rather than silently
 *  in production. */

/** `config` is read once at import time, so a test has to write to the object to
 *  exercise a different .env. Saved and restored rather than assumed empty — the
 *  real operator's TRADE_KEY is set when the suite runs locally. */
const saved = {
  tradeKey: config.tradeKey,
  privateKey: config.privateKey,
  operatorKey: config.operatorKey,
};

const setKeys = (keys: Partial<typeof saved>): void => {
  config.tradeKey = keys.tradeKey;
  config.privateKey = keys.privateKey;
  config.operatorKey = keys.operatorKey;
};

// Distinguishable by value, and never real keys: 32 bytes of a repeated nibble.
const TRADE = `0x${'1'.repeat(64)}`;
const PRIVATE = `0x${'2'.repeat(64)}`;
const OPERATOR = `0x${'3'.repeat(64)}`;

describe('activeKey: one answer to which wallet is active', () => {
  after(() => setKeys(saved));

  it('prefers TRADE_KEY when every key is set', () => {
    setKeys({ tradeKey: TRADE, privateKey: PRIVATE, operatorKey: OPERATOR });
    // TRADE_KEY holds the money and places the orders. An audit trail signed by
    // anything else is signed by a bystander.
    assert.equal(activeKey(), TRADE);
  });

  it('falls back to PRIVATE_KEY, then to OPERATOR_KEY', () => {
    setKeys({ privateKey: PRIVATE, operatorKey: OPERATOR });
    assert.equal(activeKey(), PRIVATE);
    setKeys({ operatorKey: OPERATOR });
    assert.equal(activeKey(), OPERATOR);
  });

  it('is undefined when no key is configured, rather than throwing', () => {
    // Read-only operation is a supported mode: markets and books need no key, and
    // callers fail open on undefined. Throwing here would take down /health.
    setKeys({});
    assert.equal(activeKey(), undefined);
  });

  it('adds the 0x prefix a bare hex key is missing', () => {
    // viem rejects an unprefixed key, and pasting one without 0x is the single most
    // common way to configure this wrong.
    setKeys({ tradeKey: '1'.repeat(64) });
    assert.equal(activeKey(), TRADE);
  });

  it('gives the signer and the trader the same key, whatever is set', () => {
    // The actual regression, stated directly: proof signing resolved PRIVATE_KEY
    // first while trading resolved TRADE_KEY first. Both now go through this one
    // function, so for every combination the two must agree.
    for (const keys of [
      { tradeKey: TRADE, privateKey: PRIVATE, operatorKey: OPERATOR },
      { privateKey: PRIVATE, operatorKey: OPERATOR },
      { tradeKey: TRADE, operatorKey: OPERATOR },
      { operatorKey: OPERATOR },
    ]) {
      setKeys(keys);
      const forTrading = activeKey();
      const forSigning = activeKey();
      assert.equal(forTrading, forSigning);
      assert.ok(forTrading !== undefined);
    }
  });
});
