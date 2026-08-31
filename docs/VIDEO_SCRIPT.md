# Somnus — Demo Video Script (target: 2:30–2:45)

> Format: screen recording + voiceover. No talking heads needed.
> Every artifact shown is REAL — tx hashes, proof entries and refusals from
> testnet sessions on 2026-08-25. Do not stage anything the chain can't confirm.
>
> Pre-flight before recording:
> - Backend running (`npm run dev:be`), wallet funded, `DRY_RUN=true`.
> - `npm run horizon-study` output fresh so `/agent/horizons` shows measured tiers.
> - If books are quiet during recording, set `FAIR_OVERRIDE_BTC=0.62` to force
>   displacement — and SAY on camera that it's an asserted hypothesis ("the
>   audit trail records it as asserted, not computed"). Honesty is the product.
> - Record at 1080p, browser zoom 110–125%, dark theme, close other tabs.

---

## Beat 1 — The problem (0:00 – 0:20)

**On screen:** plain text card on black. Then a flash of a random "AI trading
bot" Telegram/Dashboard screenshot (any public example), blurred.

**VO:**
"AI trading agents are getting good at making decisions. And terrible at
earning trust. You're asked to hand a black box your money — with no way to
cap what it spends, and no way to check what it actually did."

## Beat 2 — What Somnus is (0:20 – 0:50)

**On screen:** somnus landing hero → scroll through: live Event Contract ticker,
feature grid, calibration table. End on the Agent Studio button.

**VO:**
"This is Somnus — a governed, auditable trading agent for DreamDEX Event
Contracts on Somnia. It watches live Up/Down windows, prices them with its own
volatility model, and only acts when its fair value clears an edge bar *you*
wrote. Everything it does lands in a signed, hash-chained audit trail."

## Beat 3 — Writing the limits (0:50 – 1:15)

**On screen:** Agent Studio → edit config: max trade size $4, max open
positions 5, min edge 3%, symbols BTC/ETH, mode dry-run → save. Point out the
proof entry that appears.

**VO:**
"First, the rules. Not displayed — enforced. They're saved server-side, and the
broker checks every single order against them before anything is sent. Saving a
rule change even writes an entry into the audit chain itself."

## Beat 4 — Dry run, then live (1:15 – 1:45)

**On screen:** run one cycle in DRY_RUN → show decision cards with PASS +
reasons. Flip to live (show the two switches). Start the loop. Show real fills
with tx hashes. **Then show the quota-gate rejection log line.**

**VO:**
"In dry-run it decides but sends nothing. Arm live mode — two explicit
switches, both audited — and it starts taking real positions on Somnia
testnet. In one live session it placed eleven trades across five-minute
windows… and when a fourth opportunity appeared past the trade budget, it
refused it. That refusal is the feature."

## Beat 5 — Verify the proof (1:45 – 2:15)

**On screen:** Proof log → click "Verify full chain" → ok:true, 800+ signatures.
Then open one order entry: reason, model inputs, estimator label, tx hash. Cut
to the explorer showing the same hash settled on-chain. Optionally: claim sweep
redeeming winners in one tx.

**VO:**
"Don't trust the demo — verify the chain. Linkage, head, and all eight hundred
signatures re-checked in seconds. Every entry shows exactly why the agent
acted: spot, strike distance, volatility estimator used, calibration tier.
Wins get redeemed automatically. Losses stay in the record too — because an
audit trail that only shows wins is marketing, not accountability."

## Beat 6 — Why it matters + vision (2:15 – 2:40)

**On screen:** ecosystem cards (Somnia / DreamDEX / testnet hub) → closing card
with repo URL + "governed · auditable · awake".

**VO:**
"Somnia's sub-cent fees make per-cycle autonomy economical; DreamDEX Event
Contracts give the agent something honest to be right about. Agents like this
are how prediction markets get a new user class — capital that trades
tirelessly, within limits, on the record. Somnus: awake while you sleep, and
never above the law it was given."

---

## Shot list / capture checklist

| # | Capture | Source |
|---|---|---|
| 1 | Landing hero + ticker strip | `localhost:5173` |
| 2 | Config edit + save → proof entry | Agent Studio |
| 3 | Dry-run cycle decisions (PASS reasons visible) | Studio or `GET /api/agent/run` JSON |
| 4 | Live fills w/ tx hashes | `GET /api/agent/logs?limit=10` |
| 5 | Quota-gate rejection line | same logs, `status: rejected` entry |
| 6 | Verify button → ok:true sig counts | landing #proof section |
| 7 | Order entry detail (reason text) | proof log expandable |
| 8 | Explorer view of one txHash | Somnia testnet explorer |
| 9 | Claim sweep tx | `POST /api/agent/claim` result |
| 10 | Calibration table w/ tiers | `GET /api/agent/horizons` |

## Narration notes

- Total VO ≈ 380 words → comfortable at natural pace in 2:30–2:45.
- Numbers shown must match the session being recorded — don't reuse old counts.
- If a take shows an indexer hiccup, keep it and say: "the venue's dev indexer
  blinks sometimes; the agent refuses to trade blind rather than guess." That
  line scores honesty points, not deductions.
