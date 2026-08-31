import type { BookTicker, DecisionAction } from '../types';

/** Cheap-tail surcharge for Up legs.
 *
 *  Evidence (2026-08-25, 12 settled live trades): every underperforming trade
 *  sat in the YES-below-0.40 band — 0/4 vs ~1.2 expected — while NO legs and
 *  high-probability YES ran at or above market odds. Microstructure explains
 *  it: real books price crash-risk above a lognormal, so a driftless-GBM model
 *  systematically sees phantom bargains in cheap tails. n is small, so this
 *  ships as a SURCHARGE (demand more edge), not a ban, and both knobs are env-
 *  configurable so the next training pass can tune or retire it on evidence.
 *
 *  AGENT_TAIL_YES_FLOOR — asks below this price count as cheap tail (0 disables).
 *  AGENT_TAIL_EDGE_MULT — edge multiplier demanded inside that band.           */
const TAIL_FLOOR = Number(process.env.AGENT_TAIL_YES_FLOOR ?? 0.35);
const TAIL_MULT = Number(process.env.AGENT_TAIL_EDGE_MULT ?? 1.5);

/** Momentum circuit-breaker.
 *
 *  Live evidence (2026-08-26): on a 5m window the book collapsed 33c -> 8c
 *  against our side across three cycles while the GBM model — which cannot see
 *  order flow — kept rating it a bargain. We bought into a falling knife and
 *  lost. When the book moves HARD against our intended side within minutes,
 *  the far more likely explanation is that the market knows something the
 *  model cannot, not that everyone else is wrong at once.
 *
 *  Returns true when the trade should be skipped. Pure + exported so the rule
 *  is pinned by tests rather than rediscovered on-chain.                       */
export function momentumBreak(
  prevMid: number | undefined,
  currMid: number,
  action: 'BUY_YES' | 'BUY_NO',
  opts: { moveThreshold: number },
): boolean {
  if (prevMid === undefined || !Number.isFinite(prevMid)) return false;
  const move = currMid - prevMid; // positive = market drifting toward YES
  if (action === 'BUY_YES') return move <= -opts.moveThreshold;
  return move >= opts.moveThreshold;
}

/** Decide using fair-vs-book logic. Prices are Up probabilities in (0,1).
 *  - fair >= ask + required edge → buy Up (YES) at the ask
 *  - fair <= bid - minEdge → buy Down (NO) by selling Up at the bid
 *  - otherwise             → PASS, no edge worth paying                          */
export interface DecideResult {
  action: DecisionAction;
  edge: number;
  mid: number;
  ask: number;
  bid: number;
  size: number;
  pricedNote: string;
  reason: string;
}

export function decideFromFair(
  fair: number,
  book: BookTicker,
  opts: { minEdge: number; maxSize: number },
): DecideResult {
  const ask = book.ask ?? Number.POSITIVE_INFINITY;
  const bid = book.bid ?? 0;
  const mid = book.mid ?? (bid + ask) / 2;

  // The YES leg's edge bar rises inside the cheap-tail band.
  const yesRequired =
    Number.isFinite(ask) && TAIL_FLOOR > 0 && ask < TAIL_FLOOR
      ? opts.minEdge * TAIL_MULT
      : opts.minEdge;

  if (Number.isFinite(ask) && fair >= ask + yesRequired) {
    const size = contracts(opts.maxSize, ask);
    const inTail = yesRequired !== opts.minEdge;
    return {
      action: 'BUY_YES',
      edge: roundP(fair - ask),
      mid,
      ask,
      bid,
      size,
      pricedNote: `fair ${fair.toFixed(3)} >= ask ${ask.toFixed(3)} + ${yesRequired.toFixed(3)}${
        inTail ? ` (tail surcharge x${TAIL_MULT} below ${TAIL_FLOOR})` : ''
      }`,
      reason: `underpriced Up by ${((fair - ask) * 100).toFixed(2)}pp${
        inTail ? ' — tail band demands extra edge' : ''
      }`,
    };
  }
  if (bid > 0 && fair <= bid - opts.minEdge) {
    const size = contractsForNo(opts.maxSize, bid);
    return {
      action: 'BUY_NO',
      edge: roundP(bid - fair),
      mid,
      ask: ask === Number.POSITIVE_INFINITY ? 0 : ask,
      bid,
      size,
      pricedNote: `fair ${fair.toFixed(3)} <= bid ${bid.toFixed(3)} - ${opts.minEdge}`,
      reason: `overpriced Up by ${((bid - fair) * 100).toFixed(2)}pp`,
    };
  }
  return {
    action: 'PASS',
    edge: Number.isFinite(ask) ? Math.max(0, Math.min(fair - ask, bid - fair)) : 0,
    mid,
    ask: ask === Number.POSITIVE_INFINITY ? 0 : ask,
    bid,
    size: 0,
    pricedNote: 'no edge crossing threshold',
    reason: `fair ${fair.toFixed(3)} sits inside the book`,
  };
}

/** Whole Up contracts affordable within `budget` dollars at price p (each $1 contract costs p). */
function contracts(budget: number, p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.max(Math.floor(budget / p), 0);
}

/** Buying Down at the Up bid costs (1 - bid) per contract. Size on that basis so
 *  the broker's notional gate agrees — sizing on `fair` overstates the contract
 *  count and the gate then rejects every Down leg. */
function contractsForNo(budget: number, bid: number): number {
  const cost = Math.min(Math.max(1 - bid, 0.001), 1);
  return contracts(budget, cost);
}

function roundP(n: number): number {
  return Math.round(n * 10000) / 10000;
}