import { config, debug, warn } from '../config';
import { rpcCall, describeNetworkError } from '../http';
import { raiseAlert } from './alerts';

/** Deadline for the block-timestamp read. Deliberately tight — a healthy node
 *  answers in well under a second, and this call sits in the boot path. */
const CLOCK_RPC_TIMEOUT_MS = Number(process.env.AGENT_CLOCK_RPC_TIMEOUT_MS ?? 5_000);

/** Clock-skew detection against chain time.
 *
 *  Every expiry decision in this codebase compares local `Date.now()` against an
 *  on-chain `expiry` in unix seconds: which windows are tradeable, how much
 *  variance is left, whether there is enough headroom to place an order. All of it
 *  trusts the host clock absolutely.
 *
 *  A host clock a minute fast makes the agent trade windows that already locked —
 *  gas spent, `TradingNotActive`. A minute slow makes it skip windows that are fine
 *  and mis-price the ones it does take, because `secondsLeft` feeds the variance
 *  term directly. Neither failure announces itself: the 75-second expiry headroom
 *  absorbs small drift and hides the symptom until the drift is large.
 *
 *  The chain's latest block timestamp is the reference that actually matters, since
 *  it is what the settlement contracts use. */

const CHECK_TTL_MS = Number(process.env.AGENT_CLOCK_CHECK_MS ?? 300_000);
/** Skew worth warning about. Block times themselves add a second or two of noise,
 *  so anything under this is indistinguishable from normal block cadence. */
export const CLOCK_SKEW_WARN_SEC = Number(process.env.AGENT_CLOCK_SKEW_WARN_SEC ?? 10);
/** Skew that makes expiry arithmetic untrustworthy. Above this the agent should not
 *  be deciding what is about to settle. */
export const CLOCK_SKEW_BLOCK_SEC = Number(process.env.AGENT_CLOCK_SKEW_BLOCK_SEC ?? 45);

export interface ClockState {
  /** localSeconds - chainSeconds. Positive = our clock is ahead. */
  skewSec?: number;
  chainTs?: number;
  localTs: number;
  checkedAt?: number;
  ok: boolean;
  /** True when skew is large enough that expiry decisions are unsafe. */
  blocking: boolean;
  error?: string;
}

let last: ClockState = { localTs: Date.now(), ok: true, blocking: false };

async function latestBlockTimestamp(): Promise<number | undefined> {
  // Short deadline on purpose: this runs in the boot preflight, which gates
  // `maybeAutostart()`. An unbounded wait here means the process starts, serves
  // health checks, and silently never begins trading.
  const block = await rpcCall<{ timestamp?: string } | null>(
    config.rpcUrl,
    'eth_getBlockByNumber',
    ['latest', false],
    CLOCK_RPC_TIMEOUT_MS,
  );
  const raw = block?.timestamp;
  if (typeof raw !== 'string') return undefined;
  return Number(BigInt(raw));
}

/** Re-measure skew if the last check is stale. Cheap to call every cycle. */
export async function checkClockSkew(force = false): Promise<ClockState> {
  if (!force && last.checkedAt !== undefined && Date.now() - last.checkedAt < CHECK_TTL_MS) {
    return last;
  }
  const localTs = Date.now();
  try {
    const chainTs = await latestBlockTimestamp();
    if (chainTs === undefined) {
      last = { ...last, localTs, checkedAt: localTs, error: 'chain returned no block timestamp' };
      return last;
    }
    // A block timestamp is the time that block was SEALED, so it is always slightly
    // behind now. Compare against it directly and accept that a few seconds of
    // positive skew is the chain's own cadence, not a broken clock.
    const skewSec = Math.round(localTs / 1000 - chainTs);
    const blocking = Math.abs(skewSec) > CLOCK_SKEW_BLOCK_SEC;
    const ok = Math.abs(skewSec) <= CLOCK_SKEW_WARN_SEC;
    last = { skewSec, chainTs, localTs, checkedAt: localTs, ok, blocking };

    if (blocking) {
      raiseAlert({
        level: 'critical',
        key: 'clock-skew',
        title: `host clock is ${skewSec}s off chain time — expiry decisions are unsafe`,
        detail: { skewSec, chainTs, localTs, blockAboveSec: CLOCK_SKEW_BLOCK_SEC },
      });
    } else if (!ok) {
      warn(`clock skew ${skewSec}s vs chain (warn above ${CLOCK_SKEW_WARN_SEC}s)`);
    } else {
      debug(`clock skew ${skewSec}s vs chain — fine`);
    }
    return last;
  } catch (err) {
    // Unknown skew is not the same as bad skew. An RPC failure here must not halt
    // trading; the feed-health and freshness gates already cover a dead RPC. But a
    // timeout and a refusal need distinguishing, or you go looking in the wrong place.
    last = { ...last, localTs, checkedAt: localTs, error: describeNetworkError(err) };
    return last;
  }
}

export function clockState(): ClockState {
  return last;
}
