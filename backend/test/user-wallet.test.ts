import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import {
  IdentityError,
  MIN_TOKEN_LENGTH,
  TOKEN_HEADER,
  identityFromHeaders,
  identityFromToken,
  perUserWalletsEnabled,
  tokensMatch,
} from '../src/mcp/identity';
import {
  clampStake,
  maxUserStake,
  minUserGas,
  noteUserTrade,
  resolveUserMinEdge,
  userMinEdgeFloor,
  userRateCheck,
  userTradingAvailable,
  userTradingMode,
  __resetUserTradingForTests,
} from '../src/services/user-trading';
import { pauseTrading, resumeTrading, __resetRiskStateForTests } from '../src/services/risk';
import { appendEntry } from '../src/services/store';
import { verifyLedgerAgainstChain } from '../src/services/pnl';
import { pickCollateral } from '../src/services/wallet';

/** Per-user wallets: derived from a token, never stored.
 *
 *  The whole scheme rests on properties that are cheap to assert and expensive to
 *  rediscover — determinism (a caller must get the same wallet back tomorrow),
 *  isolation (one token must say nothing about another), and the caps that stand
 *  between a hosted tool call and somebody's balance.                            */

const SECRET = 'x'.repeat(48);
const OTHER_SECRET = 'y'.repeat(48);
const TOKEN = 'correct-horse-battery-staple-42';

describe('identity: derivation', () => {
  before(() => {
    process.env.SOMNUS_USER_SECRET = SECRET;
  });
  after(() => {
    delete process.env.SOMNUS_USER_SECRET;
  });

  it('is deterministic — the same token always derives the same wallet', () => {
    const a = identityFromToken(TOKEN);
    const b = identityFromToken(TOKEN);
    assert.equal(a.address, b.address);
    assert.equal(a.privateKey, b.privateKey);
    assert.equal(a.handle, b.handle);
    // Nothing is persisted, so this equality IS the storage: a deploy that wipes the
    // filesystem must not cost anyone their wallet.
    assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
  });

  it('ignores surrounding whitespace, so a copy-paste does not change wallets', () => {
    assert.equal(identityFromToken(`  ${TOKEN}\n`).address, identityFromToken(TOKEN).address);
  });

  it('gives different tokens different wallets', () => {
    assert.notEqual(identityFromToken(TOKEN).address, identityFromToken(`${TOKEN}-other`).address);
  });

  it('makes the server secret a real key — the same token is a different wallet under a different secret', () => {
    const withFirst = identityFromToken(TOKEN).address;
    process.env.SOMNUS_USER_SECRET = OTHER_SECRET;
    const withSecond = identityFromToken(TOKEN).address;
    process.env.SOMNUS_USER_SECRET = SECRET;
    assert.notEqual(withFirst, withSecond);
  });

  it('derives an address that matches the private key it hands back', () => {
    const id = identityFromToken(TOKEN);
    assert.equal(privateKeyToAccount(id.privateKey).address, id.address);
  });

  it('publishes a handle that cannot be walked back to the token', () => {
    const id = identityFromToken(TOKEN);
    // The handle appears in audit entries and log lines, which are meant to be
    // published — so it must identify the wallet without carrying the secret.
    assert.match(id.handle, /^[0-9a-f]{12}$/);
    assert.ok(!id.handle.includes(TOKEN));
    assert.ok(!TOKEN.includes(id.handle));
    assert.notEqual(id.handle, identityFromToken(`${TOKEN}!`).handle);
  });

  it('refuses a token short enough to guess', () => {
    // Guessing a token is guessing a wallet: there is no second factor behind it.
    assert.throws(() => identityFromToken('a'.repeat(MIN_TOKEN_LENGTH - 1)), IdentityError);
    assert.doesNotThrow(() => identityFromToken('a'.repeat(MIN_TOKEN_LENGTH)));
  });
});

describe('identity: a deployment with no secret', () => {
  before(() => {
    delete process.env.SOMNUS_USER_SECRET;
  });

  it('reports the feature as unavailable rather than half-working', () => {
    assert.equal(perUserWalletsEnabled(), false);
    assert.throws(() => identityFromToken(TOKEN), IdentityError);
  });

  it('treats a short secret as no secret', () => {
    process.env.SOMNUS_USER_SECRET = 'too-short';
    assert.equal(perUserWalletsEnabled(), false);
    assert.throws(() => identityFromToken(TOKEN), /32\+ characters/);
    delete process.env.SOMNUS_USER_SECRET;
  });
});

describe('identity: reading the caller out of request headers', () => {
  before(() => {
    process.env.SOMNUS_USER_SECRET = SECRET;
  });
  after(() => {
    delete process.env.SOMNUS_USER_SECRET;
  });

  it('treats an anonymous request as legitimate, not as an error', () => {
    // No token is the expected state for someone using only the read tools.
    assert.equal(identityFromHeaders({}), undefined);
    assert.equal(identityFromHeaders({ [TOKEN_HEADER]: '   ' }), undefined);
  });

  it('derives from the header when one is present', () => {
    const id = identityFromHeaders({ [TOKEN_HEADER]: TOKEN });
    assert.equal(id?.address, identityFromToken(TOKEN).address);
  });

  it('takes the first value when a proxy repeats the header', () => {
    const id = identityFromHeaders({ [TOKEN_HEADER]: [TOKEN, 'someone-elses-token-value-here'] });
    assert.equal(id?.address, identityFromToken(TOKEN).address);
  });
});

describe('identity: token comparison', () => {
  it('compares without leaking length through an early return', () => {
    assert.equal(tokensMatch(TOKEN, TOKEN), true);
    assert.equal(tokensMatch(TOKEN, `${TOKEN}x`), false);
    assert.equal(tokensMatch(TOKEN, TOKEN.replace('c', 'd')), false);
  });
});

describe('user-trading: the caps a tool argument cannot raise', () => {
  after(() => {
    delete process.env.SOMNUS_USER_MAX_TRADE;
    delete process.env.SOMNUS_USER_MIN_EDGE;
  });

  it('clamps an oversized stake instead of refusing the trade', () => {
    process.env.SOMNUS_USER_MAX_TRADE = '10';
    // Clamping, not rejecting: someone who asks for 500 wants to trade, and the honest
    // answer is a smaller trade plus a sentence saying so.
    const big = clampStake(500);
    assert.equal(big.stake, 10);
    assert.equal(big.cap, 10);
    assert.equal(big.clamped, true);

    const small = clampStake(4);
    assert.equal(small.stake, 4);
    assert.equal(small.clamped, false);

    // No stake asked for = trade at the cap, and that is not a clamp.
    assert.equal(clampStake().stake, 10);
    assert.equal(clampStake().clamped, false);
    // Nonsense falls back to the cap rather than to zero or NaN.
    assert.equal(clampStake(0).stake, 10);
    assert.equal(clampStake(Number.NaN).stake, 10);
  });

  it('falls back to a sane cap when the env is garbage', () => {
    process.env.SOMNUS_USER_MAX_TRADE = 'not-a-number';
    assert.equal(maxUserStake(), 1000);
    process.env.SOMNUS_USER_MAX_TRADE = '-5';
    assert.equal(maxUserStake(), 1000);
    delete process.env.SOMNUS_USER_MAX_TRADE;
    assert.equal(maxUserStake(), 1000);
  });

  it('demands enough gas for the venue\'s worst-case fee, not for what a trade burns', () => {
    // A trade burns ~0.004 STT, but transactions are built with a 10M gas limit at
    // 60 gwei and the node checks that worst case (~0.6) against the balance first. A
    // wallet funded to the agent's 0.02 floor passes every local check and then fails
    // at the node with "insufficient balance" wearing the SDK's generic error text.
    delete process.env.SOMNUS_USER_MIN_GAS;
    assert.ok(minUserGas() >= 0.6, `${minUserGas()} would not clear the worst-case fee check`);
    process.env.SOMNUS_USER_MIN_GAS = 'nonsense';
    assert.equal(minUserGas(), 0.7);
    process.env.SOMNUS_USER_MIN_GAS = '1.5';
    assert.equal(minUserGas(), 1.5);
    delete process.env.SOMNUS_USER_MIN_GAS;
  });

  it('lets a caller demand more edge but never less', () => {
    process.env.SOMNUS_USER_MIN_EDGE = '0.9';
    assert.equal(userMinEdgeFloor(), 0.9);
    // A floor is the point: minEdge:0 would turn the model's opinion into a coin flip.
    assert.equal(resolveUserMinEdge(0), 0.9);
    assert.equal(resolveUserMinEdge(0.01), 0.9);
    assert.equal(resolveUserMinEdge(0.95), 0.95);
    assert.equal(resolveUserMinEdge(), 0.9);
    assert.equal(resolveUserMinEdge(Number.NaN), 0.9);
  });

  it('never trades on a looser bar than the operator set for the agent itself', () => {
    delete process.env.SOMNUS_USER_MIN_EDGE;
    // Whatever the saved rules demand, a caller's trade demands at least as much.
    assert.ok(resolveUserMinEdge(0) >= userMinEdgeFloor());
  });
});

describe('user-trading: sending is off until an operator turns it on', () => {
  after(() => {
    delete process.env.SOMNUS_USER_TRADING;
  });

  it('defaults to pricing without sending', () => {
    delete process.env.SOMNUS_USER_TRADING;
    assert.equal(userTradingMode(), 'simulate');
    process.env.SOMNUS_USER_TRADING = 'dry-run';
    assert.equal(userTradingMode(), 'simulate');
  });

  it('goes live only on an explicit switch', () => {
    process.env.SOMNUS_USER_TRADING = '  LIVE ';
    assert.equal(userTradingMode(), 'live');
  });
});

describe("user-trading: the operator's kill switch covers callers too", () => {
  after(() => {
    resumeTrading({ clearFailures: true });
    __resetRiskStateForTests();
  });

  it('refuses a caller\'s order while the deployment is paused', () => {
    assert.equal(userTradingAvailable().ok, true);
    pauseTrading('halted for a test');
    const paused = userTradingAvailable();
    // A paused deployment adds no new risk of any kind — the switch would be a lie if
    // a stranger with a token could keep trading through it.
    assert.equal(paused.ok, false);
    assert.match(paused.reason ?? '', /kill switch/i);
    assert.match(paused.reason ?? '', /halted for a test/);
    resumeTrading({ clearFailures: true });
    assert.equal(userTradingAvailable().ok, true);
  });
});

describe('user-trading: the hourly rate limit', () => {
  before(() => {
    process.env.SOMNUS_USER_TRADES_PER_HOUR = '3';
    __resetUserTradingForTests();
  });
  after(() => {
    delete process.env.SOMNUS_USER_TRADES_PER_HOUR;
    __resetUserTradingForTests();
  });

  it('bounds a retry loop, then releases as the window rolls', () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) {
      assert.equal(userRateCheck('handle-a', t0 + i).ok, true, `send ${i + 1} should be allowed`);
      noteUserTrade('handle-a', t0 + i);
    }
    const blocked = userRateCheck('handle-a', t0 + 10);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.used, 3);
    assert.equal(blocked.limit, 3);
    assert.ok((blocked.retryAfterSec ?? 0) > 0);

    // An hour later the oldest send has fallen out of the window.
    assert.equal(userRateCheck('handle-a', t0 + 3_600_001).ok, true);
  });

  it('counts per wallet, so one caller cannot exhaust another', () => {
    assert.equal(userRateCheck('handle-b', 1_000_000_000_000).ok, true);
  });
});

describe("user-trading: a caller's order is not the agent's position", () => {
  it('is excluded from the ledger cross-check instead of read as a lost write', async () => {
    // The ledger holds the AGENT's cost basis and feeds the agent's loss breakers, so a
    // user's trade has no row there by design. Counting one as drift would raise a
    // permanent false alarm about a problem that does not exist — and an alarm that
    // cannot be cleared is worth less than no alarm at all.
    await appendEntry({
      kind: 'order',
      payload: {
        via: 'mcp-user',
        user: 'abc123abc123',
        wallet: '0x000000000000000000000000000000000000dEaD',
        marketId: '0xuser-window',
        symbol: 'BTC-x/tUSDC#YES',
        status: 'submitted',
        dryRun: false,
        price: 0.44,
        size: 10,
      },
    });
    const afterUserOrder = verifyLedgerAgainstChain();
    assert.equal(afterUserOrder.userOrders, 1);
    assert.equal(
      afterUserOrder.missingFromLedger.some((m) => m.marketId === '0xuser-window'),
      false,
    );
    assert.match(afterUserOrder.note, /derived user wallets/);

    // The same entry without a user IS the agent's, and a missing ledger row for it is
    // exactly the lost write this check exists to catch.
    await appendEntry({
      kind: 'order',
      payload: {
        marketId: '0xagent-window',
        symbol: 'BTC-y/tUSDC#YES',
        status: 'submitted',
        dryRun: false,
        price: 0.44,
        size: 10,
      },
    });
    const afterAgentOrder = verifyLedgerAgainstChain();
    assert.equal(
      afterAgentOrder.missingFromLedger.some((m) => m.marketId === '0xagent-window'),
      true,
    );
    assert.equal(afterAgentOrder.userOrders, 1);
  });
});

describe('wallet: which balance is spendable collateral', () => {
  it('ignores gas and outcome tokens', () => {
    // Outcome holdings are POSITIONS keyed by tradable symbol. Counting them reports a
    // wallet as funded when every dollar is already committed to open bets.
    const picked = pickCollateral(
      {
        STT: { free: 3 },
        tUSDC: { free: 120 },
        'BTC-0-02SEP26/tUSDC#YES': { free: 900 },
        'ETH/tUSDC': { free: 50 },
      },
      'STT',
    );
    assert.equal(picked.collateral, 120);
    assert.equal(picked.collateralCode, 'tUSDC');
  });

  it('calls an all-zero read unreadable rather than empty', () => {
    // fetchBalance substitutes 0n for a failed per-token read, so a network blip looks
    // exactly like an empty wallet — and the affordability gate fails CLOSED on a
    // readable zero, which would refuse every trade from a funded account.
    const picked = pickCollateral({ tUSDC: { free: 0 }, USDso: { free: 0 } }, 'STT');
    assert.equal(picked.collateral, undefined);
    assert.match(picked.unreadable ?? '', /unreadable/);
  });

  it('reports a genuine single-currency zero as zero', () => {
    const picked = pickCollateral({ tUSDC: { free: 0 } }, 'STT');
    assert.equal(picked.collateral, 0);
    assert.equal(picked.unreadable, undefined);
  });
});




