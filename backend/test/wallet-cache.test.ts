import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_GAS_NATIVE, WALLET_TTL_MS } from '../src/services/wallet';

/** The balance cache has to outlive the read it caches.
 *
 *  A latency bug that presented as a trading bug, which is why it survived so long.
 *  `fetchBalance` walks every currency the venue lists plus every outcome token held —
 *  measured at 14-20s cold on a real wallet, varying with the network. That read used to
 *  happen lazily, inside the FIRST `executeDecision` of a cycle, which is AFTER the cycle
 *  has built its signal context. So the first order paid the 14-20s and every decision
 *  behind it inherited a spot reading that much older. `dataFresh` then rejected them
 *  against `maxDataAgeMs` (15s), so orders 2..N were refused as stale regardless of edge,
 *  and `maxOrdersPerCycle: 5` could never mean more than 1.
 *
 *  Two things were wrong and both are fixed:
 *
 *    - the ORDER. `beginCycle` now reads the balance before the caller reads spot, so the
 *      slow-moving input is fetched first and the fast-moving one last, right before it is
 *      judged. Verified against the live venue: cold `canAfford` 13.9s, then 0ms once
 *      `beginCycle` had run.
 *    - the TTL. 10s against a 14-20s read, so the cache expired before it could ever be
 *      reused and a cycle paid full price again mid-flight.
 *
 *  Only the constants are asserted here, deliberately. `walletSnapshot` opens a chain
 *  WebSocket and hits the network, so exercising it in the suite hangs the runner on an
 *  open handle — which is why every other wallet test sticks to `pickCollateral`. The
 *  ordering was proven by measurement instead. What these guard is a silent revert: put
 *  the TTL back to 10s and the one-order-per-cycle cap returns with nothing to notice it. */

/** A cold read measured 13.9-20.1s. The TTL must clear that with room for a whole cycle. */
const TTL_FLOOR_MS = 60_000;

describe('wallet cache: long enough to survive the read it caches', () => {
  it('defaults to a TTL that outlasts a cold balance read', () => {
    assert.ok(
      WALLET_TTL_MS >= TTL_FLOOR_MS,
      `wallet TTL ${WALLET_TTL_MS}ms is below the ${TTL_FLOOR_MS}ms floor — a cold read takes ` +
        '14-20s, so a shorter TTL expires mid-cycle and the affordability check pays full ' +
        'price again, aging the cycle\'s own spot reading past maxDataAgeMs',
    );
  });

  it('is still bounded, so a stale balance cannot outlive the session', () => {
    // The other direction matters too: `committedSinceRead` covers our own spending and
    // `beginCycle` forces a fresh read each cycle, but an external top-up should still
    // show up on a human timescale rather than never.
    assert.ok(WALLET_TTL_MS <= 600_000, `wallet TTL ${WALLET_TTL_MS}ms is unreasonably long`);
  });
});

describe('wallet: the gas floor matches what the venue actually reserves', () => {
  it('demands the worst-case fee, not the burn', () => {
    // 0.02 used to green-light wallets the node then rejected: a trade burns ~0.005, but
    // the venue builds transactions with a 10,000,000 gas limit at 60 gwei and the node
    // checks that ~0.6 against the balance before accepting one. Confirmed by a real
    // fill, which cost 0.00553 in gas against this floor.
    assert.ok(
      MIN_GAS_NATIVE >= 0.6,
      `MIN_GAS_NATIVE ${MIN_GAS_NATIVE} is below the ~0.6 the node reserves — canAfford would ` +
        'pass wallets the chain rejects, and five such failures pause the agent',
    );
  });
});
