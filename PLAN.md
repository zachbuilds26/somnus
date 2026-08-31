# SOMNUS — Full Build Plan

> **Name:** Somnus — Roman god of sleep. Native to the Somnia dreamverse, but
> wide awake. A "lucid" agent: aware, governed, and accountable.
>
> **One-liner:** Governed, auditable AI trading agent for DreamDEX Event
> Contracts on Somnia — research live markets, act within written limits, keep
> machine-readable proof.

---

## 1. Why this wins (judging-criteria mapping)

| Judging bucket (weight) | How Somnus lands it |
|---|---|
| Innovation & Originality (20%) | "Agent-governance" is rare in this space — most entries are dashboards. Somnus is a *permissioned AI trader with a signed audit trail*. |
| Technical Implementation (25%) | Real integration of `@somnia-chain/markets-sdk`, the bot-kit patterns (session keys, `DRY_RUN`, expiry-safe orders), live order-book reads, and a crypto-hash proof chain. |
| UX & Design (20%) | Landing page + a clean app: "Agent Studio" where a human writes limits in plain language; live book visuals; one-click dry-run vs. live. |
| Business & Ecosystem Impact (20%) | Brings **new users** to Event Contracts (AI crowd + casual traders), generates **trading activity** on testnet *and* mainnet, and expands the DreamDEX/Somnia agent ecosystem — literally the rubric's example bullet. |
| Presentation & Demo (15%) | A 2–3 min video: "Set my max size, sent my agent to watch BTC windows, watch it trade + check the signed proof." Instant storyline. |

---

## 2. Product scope

Two pages, one product:

### 2.1 Landing page (`web/` — `/`)
Marketing + onboarding. Sections:
1. **Hero** — "Your prediction-market agent. Awake while you sleep." + CTA → App
2. **How it works** — 3 steps: *Set limits → Agent watches Event Contracts → Verify the proof*
3. **Live gut check** — a real testnet Event Contract ticker (from the API) proving we're not vapor
4. **Why Somnus** — governed (session keys), auditable (signed proof), Somnia-native (EVM L1, sub-cent fees)
5. **Ecosystem** — built on Somnia × DreamDEX Event Contracts + links to docs
6. **Footer** — links + GitHub

### 2.2 App page (`/app`)
The working product. Layout (Somnia dark, violet accent):
- **Markets board** — live Event Contract windows (symbol, strike, expiry, Up prob, bid/ask, edge)
- **Agent Studio** — write your governing rules (max size, max open, min edge, which symbols, dry-run only toggle)
- **Activity / Proof log** — every decision + order with tx-hash, signed entry id, chain-links, human explanation
- **Position chip** — current positions / settle + claim (via `ec-settlement` flow)

---

## 3. Core user flow
1. Connect wallet (EIP-1193; session key generation on first run)
2. Create an agent: pick symbols (e.g. `BTC-…`), set limits ("max $25 trade, only trade when edge > 3%"),
3. Agent goes **DRY_RUN**: computes decisions, logs them, sends nothing
4. Flip to **LIVE** (testnet) with session key + funded wallet
5. Watch Activity: decision → order → fill → claim → proof entry
6. Export/verify proof (hash chain + optional signature)

---

## 4. Architecture

```
Browser (web/) ─━► REST/WS ──► backend (this repo)
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
   services/markets.ts      services/agent.ts         services/proof.ts
   (REST indexer + SDK      (signal → decision)       (signed, hash-chained
    order books, candles)                              audit trail)
            │                       │                       │
            ▼                       ▼                       ▼
   @somnia-chain/markets-sdk  services/broker.ts     services/store.ts
   (SomniaMarkets client,     (governed executor:    (JSON file log +
    binary markets + books)    limits, DRY_RUN,        in-memory ring)
                               session-key orders)
            │
            ▼
   DreamDEX testnet/mainnet (chain 50312 / 5031) + stg.api.dreamdex.io
```

Data flows one way: **markets → agent → broker → chain → proof**.
---

## 5. Backend-first build order

Backend is the product; the frontend is a window into it. Order matters.

### Phase 0 — Scaffold (DONE)
- Repo, workspaces, tsconfig, env config, health route
- Verified live connectivity: testnet RPC `dream-rpc.somnia.network` ✓ , `stg.api.dreamdex.io/v0/markets` ✓ (returns `SOMI:USDso`, `WBTC:USDso`, `WETH:USDso` spot markets + contract addrs)

### Phase 1 — Market intelligence service
- `GET /v0/markets` REST wrapper → normalized market list (verified live above)
- SDK gateway: binary/Event Contract markets, live order books, candles, WS streams
- Pricing math (`services/pricing.ts`): mid ⇢ fair probability, edge, YES/NO implied probabilities from the single two-sided book

### Phase 2 — Agent brain + governed broker
- `AgentConfig` (symbols, maxTradeSize, maxOpenPositions, minEdgeThreshold, mode: `dry-run|live|view`)
- Signal v1: edge vs. mid (honest default: no edge → no trade); pluggable `signal` fn for momentum/oracle later
- `broker.ts` — the hard gate: every order passes limit checks (size, open, edge), **DRY_RUN by default**, then optional session-key submit via SDK (`placeLimit`, IOC, expiry)

### Phase 3 — Proof & audit + full API
- `proof.ts` — each decision/order/fill → entry hashed with prev hash (hash chain) + optional ECDSA secp256k1 signature via `node:crypto`
- `store.ts` — JSON-file append log (no DB dependency, zero native builds)
- Public API: markets, book, probability, agent config/run/logs, proof list/verify, health

### Phase 4 — Live testnet orders (opt-in)
- Session-key flow (per bot-kit `docs/session-keys.md`): operator key signs limits; trade key **cannot withdraw**
- `CLAIM` sweep of settled windows (bot-kit `ec-settlement` pattern) so testnet winnings are redeemable
- Backtest hook (`npm run backtest` pattern) before real orders

### Phase 5 — Frontend (after backend is solid)
- Landing page (`web/`) + App (`/app`) — Vite + React + Tailwind, Somnia tokens (`docs/DESIGN_SYSTEM.md`)
- Pages consume the real backend API only; no fake data

### Phase 6 — Hardening + submission
- `.env` docs, runbooks, Docker/Railway config, DRY_RUN canonical test
- 2–3 min demo video script (see §12) and GitHub public repo

---

## 6. Public API surface (v0)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness + network + dry-run state |
| GET | `/api/markets` | spot markets from REST indexer (live ✓) |
| GET | `/api/markets/binary` | Event Contract windows (SDK) |
| GET | `/api/markets/:symbol/book` | top-of-book + mid + edge |
| GET | `/api/markets/:symbol/probability` | our computed fair probability + edge |
| GET/PUT | `/api/agent/config` | read/update governing rules |
| POST | `/api/agent/run` | one decision cycle (dry-run by default) |
| GET | `/api/agent/logs` | recent decisions + orders |
| GET | `/api/proof` | audit chain (latest N entries) |
| POST | `/api/proof/verify` | re-hash a range and verify linkage |

All responses `application/json`. Error shape: `{ error: { code, message } }`.

---

## 7. Data model (v1 — JSON store)

```ts
interface MarketRow  { symbol; kind: 'spot'|'event'; base; quote; contract; lotSize; tickSize; decimals }
interface BookTicker { symbol; bid?: number; ask?: number; mid?: number; ts }
type DecisionAction  = 'BUY_YES' | 'BUY_NO' | 'PASS' | 'CLAIM'
interface Decision   { id; ts; symbol; fair; mid; ask; edge; action; size; pricedNote; reason }
interface OrderLog   { id; ts; decisionId; symbol; side; price; size; timeInForce; dryRun; txHash?; status }
interface ProofEntry { id; ts; prevHash; payloadHash; signature?; payload: Decision | OrderLog }
interface AgentConfig{ symbols[]; maxTradeSize; maxOpenPositions; minEdge; intervalMs; mode; claimEnabled }
```

---

## 8. Trust & safety model

1. **DRY_RUN=true everywhere until you explicitly set `MODE=live`** — the broker refuses real orders otherwise.
2. **Session key** — trade key scoped to place/cancel only; cannot withdraw (bot-kit session keys).
3. **Written limits** — every order passes through max-size/max-open/min-edge gates server-side, not just UI.
4. **Proof chain** — tamper-evident log with prev-hash links + optional signature.
5. **Separate bot wallet** with only the testnet capital you'll automate (dedicated key per submission).

---

## 9. Design system — "Somnia kinda UI"

Full token list in `docs/DESIGN_SYSTEM.md` (scraped from `somnia.network` CSS).
Highlights: pure-black pages, `#141414/#1c1c1c` cards, violet accent `#771be8`,
purple→pink→ice-blue gradient family, lime `#adf03b` sparkle, green `#00c758`
= YES, red `#fb2c36` = NO. Dark-only, no light mode.

---

## 10. Timeline vs the hackathon

| Date | Milestone |
|---|---|
| Aug 18 | Registrations open (submit early) |
| Aug 25 | Submissions open |
| Now → Sep 1 | Phase 0–3 done, backend running on testnet |
| Sep 2–5 | Phase 4 live testnet trades + capture proof trail for video |
| Sep 6 | Frontend polished |
| Sep 7–8 | Video + submission on DoraHacks |

---

## 11. Definition of done per phase
- **Phase 1:** `GET /api/markets` returns live testnet data; binaries list returns via SDK; book endpoint returns real bid/ask.
- **Phase 2:** agent runs a cycle in DRY_RUN, logs well-formed decisions, obeys limits even if signal says otherwise.
- **Phase 3:** `GET /api/proof` chains entries; verify passes.
- **Phase 4:** one real testnet order (small) places + proof records tx; claim works.
- **Phase 5:** landing + app render real data; wallet connect works; no mock UI.
- **Phase 6:** video + public runbook + README + repo.

---

## 12. Open decisions (call out as we go)
1. Signal: `edge-vs-consensus` v1 is deliberately boring & honest — do we add a momentum/oracle signal for demo spice? (recommend: yes, gated behind config)
2. UI framework: Vite+React+Tailwind (recommended) vs Next.js (SSR).
3. Wallet auth for app: wagmi/privy vs minimal EIP-1193 (recommended minimal for scope).
4. Deploy: Railway (bot-kit style) vs local demo.