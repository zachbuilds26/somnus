# Training Somnus — the repeatable loop

Somnus is designed to improve with time. Trust is **earned from settled
evidence**, not hardcoded: window classes graduate (or get demoted) as data
accumulates, and model weaknesses found in review become priced-in surcharges.
This doc is the operating manual for that loop.

## The loop (run in this order)

```bash
# 1. Re-measure every window class against settled windows (~1000 sampled).
npm run horizon-study        # writes data/horizon-calibration.json

# 2. Authoritative performance record: orders vs outcomes.
npm run score                # z-score vs market-implied wins; split by hand if needed

# 3. Sanity probe (optional): portfolio-based luck check.
npm run luck                 # NOTE: blind to claimed winners — see caveat below

# 4. Confirm connectivity + tier table after a study.
npm run doctor

# 5. Restart only if you changed code. Calibration + config changes are picked
#    up by the running agent on its next cycle, no restart needed.
```

**Cadence:** daily during the hackathon week; weekly afterwards is enough.

## What each pass feeds

| Artifact | Who reads it | Effect |
|---|---|---|
| `data/horizon-calibration.json` | `horizon.ts`, live agent | Tier per class → edge multiplier & stake cap applied on the next cycle |
| `score` output | operator | Whether the signal beats market-implied wins (z-score) |
| proof-chain order entries | any analysis | Direction/price-band/regime splits for weaknesses |

## Graduation path (automatic)

```
no data  →  PROVISIONAL   (2x minEdge, 0.5x maxTradeSize, reserved slots)
         →  VALIDATED     (operator's own rules)   needs n≥40 AND beats base rate
         →  BLOCKED       (not traded at all)      measured ≈ base rate (e.g. 1m)
```

Latest measured state lives in `GET /api/agent/horizons` and `npm run doctor`.

## Known model biases & their guards

| Finding | Date | Guard shipped |
|---|---|---|
| Cheap YES tails (<$0.35 asks) underperformed — 0/4 live vs ~1.2 expected; crash-risk priced above lognormal fools a GBM model | 2026-08-25 | Tail surcharge: YES legs below `AGENT_TAIL_YES_FLOOR` (0.35) demand `AGENT_TAIL_EDGE_MULT` (1.5×) edge. Recorded in each decision's `pricedNote`. |
| sqrt(t) vol scaling overstated long-horizon dispersion ~4x on this mean-reverting feed | earlier | Horizon-matched k-step estimators, max(direct, scaled); estimator label stored per decision |
| Absolute-strike windows misread when upstream rescales units | earlier | Scale detection vs spot with 5x implausibility refusal |
| Partial IOC fills were billed at the REQUESTED size, so the ledger was wrong on exactly the trades that mattered most. 4 of 102 submitted orders came back `canceled` (partial) — all four were the ~$1000 orders. One winner (1976 requested, 990 filled) was booked as a $10 loser instead of a ~$489 win. | 2026-08-30 | `resolveFill` takes the cost basis from the venue's reported `filled` and tick-snapped price; an order that filled nothing gets no ledger row. Pinned by `broker.test.ts`. |
| Four ~$1000 orders went out between 18:41 and 18:46 and all settled together at 19:17, so the $1000 `maxDailyLoss` breaker had nothing to read until every one had resolved — $4000 at risk under a $1000 limit. `maxOpenPositions` counts positions, not dollars. | 2026-08-30 | `maxOpenNotional` caps collateral riding at once (defaults to `maxDailyLoss`), enforced against the ledger's open cost plus what the cycle has already committed. Sizes down rather than refusing. |

**Re-measure the ledger before trusting any historical P&L.** Rows written before
the partial-fill fix overstate cost on the four `canceled` orders. `npm run score`
reads the proof chain, where the order entries now carry `filledSize` and
`fillStatus`, so new records are gradeable directly; older ones are not
reconstructible and should be split out rather than pooled.

## Research findings (2026-08-25/26 deep pass)

- **Deep-scan knobs fixed long-horizon starvation** (2026-08-26). The study
  previously read only the most recent ~1000 finalized windows (~1 day — almost
  all 5m) and loaded ~17h of candles (skipping any decision point older than
  that). `BT_LIMIT` and `BT_CANDLES` now control depth; a deep pass looks like:
  ```bash
  BT_LIMIT=4000 BT_CANDLES=6000 npm run horizon-study
  ```
- **1h verdict (n=50)**: Brier 0.1435 vs base 0.2400 — best directional
  accuracy of any class — but calibration error 0.215 > 0.15 gate, so it stays
  PROVISIONAL. Direction strong, stated probabilities overconfident. Expected
  to graduate as samples grow; a per-band calibration curve is the candidate
  fix if calErr stays high at n≥100.
- **4h**: n=12 of 40 after deep scan (was n=2). 24h: no settled windows in
  range yet.
- **Vol level is NOT the tail problem.** `vol-vs-market`: sigma ratio ours/market
  median 0.93 (n=8) — broadly in line. The cheap-tail losses come from
  distribution shape / microstructure, not overestimated vol. Surcharge stays
  (justified by realized outcomes); revisit as samples grow.
- **The naive backtest's 79.5% hindsight was an artifact.**
  `scripts/settle-audit.ts` shows strike-window errors scale monotonically with
  distance-to-strike (63% correct inside ±0.02%, 91% beyond ±0.30%) — the
  signature of CANDLE-feed vs ORACLE-print divergence flipping near-the-money
  windows, not of a wrong settlement rule. The live agent prices from the same
  oracle (`fetchPrice`) the venue settles on, so it is unaffected.
- **Open improvement:** historical oracle prints aren't exposed by current SDK
  endpoints (only openings). If Somnia exposes oracle tick history, re-run
  `horizon-study` on oracle-settled outcomes instead of candle finals — Brier
  scores near the money should tighten further.

## Overnight training sessions

Free sample accumulation, zero risk:
```bash
# arm once via API (or Agent Studio):
PUT /api/agent/config {"mode":"dry-run","tradeQuota":null,"maxOpenPositions":10}
POST /api/agent/loop/start     # then leave it running
```
Every cycle records decisions + simulated orders into the proof chain across
ALL classes (provisional slots reserve capacity for long horizons). Score it
later with `npm run score` — simulated orders are matched against real
settlements exactly like live ones.

## Measurement traps (read before trusting any number)

1. **`npm run luck` reads the PORTFOLIO.** Winning tokens are redeemed by the
   claim sweep and vanish from it — a claiming wallet shows *only losers*, which
   the script now flags loudly. Use `npm run score` (order↔outcome matching from
   the audit chain) as the authoritative record.
2. **Win rate alone is meaningless** — always compare against prices paid
   (0.05-priced contracts are *supposed* to lose 19 times in 20).
3. **Small samples graduate nothing.** The tier system demands n≥40 per class;
   respect that before hand-tuning constants based on a handful of trades.

## Adding a guard: the pattern that worked

1. Find it in the data (`score` splits by direction / price band / horizon tier).
2. Ship the *mildest* intervention that bounds damage — a surcharge or size cut,
   not a ban (bans hide the evidence you need to confirm the bias).
3. Record the intervention in the decision's own note so the audit trail can
   split "before/after" later.
4. Pin behaviour with a regression test naming the date and evidence.
5. Re-measure next pass: promote the guard to default, tune it, or retire it —
   same evidence bar as everything else.
