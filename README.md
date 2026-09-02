# Somnus

**An autonomous trading bot for DreamDEX Event Contracts on Somnia.**

Somnus reads live order books, forms its own probability estimates, and places trades — all within hard risk limits you set. Every decision, order, and config change is written to a tamper-proof audit chain so you (or anyone else) can verify exactly what happened and why.

Built for the **Somnia × DreamDEX Event Contracts Hackathon**. Testnet-first.

---

## What it actually does

1. **Watches live markets** — pulls Event Contract windows (Up/Down) and order books from DreamDEX via the Somnia Markets SDK
2. **Thinks for itself** — computes a fair probability using driftless GBM with horizon-matched volatility (not naive sqrt-scaling), compares it to the book, and only acts when there's genuine edge
3. **Respects your limits** — max trade size, max open positions, max open exposure, min edge, daily loss cap, loss streak, execution failures, data freshness — all enforced server-side, not in the UI
4. **Leaves a paper trail** — every decision, order, claim, and config change goes into a hash-chained, optionally signed JSONL log. `POST /proof/verify` lets anyone audit the chain end-to-end.
5. **Runs autonomously** — start the loop and it runs non-overlapping cycles on your interval. Or call `POST /agent/run` for a one-off.

---

## Repository structure

```
somnus/
├── backend/       # Node 20+ TypeScript API + autonomous agent runtime
├── docs/          # training and calibration notes
├── PLAN.md        # product and implementation plan
├── .env.example   # safe testnet configuration template
└── render.yaml    # backend deployment definition
```

**Backend only.** No frontend, no Telegram bot, no MCP server. Just a JSON API and an autonomous runtime.

---

## Quick start

```bash
npm install
cp .env.example backend/.env   # keep NETWORK=testnet, DRY_RUN=true
npm run dev
```

API runs at `http://127.0.0.1:4545` by default.

---

## Verify it works

```bash
npm run typecheck
npm test
npm run doctor
```

Tests run offline — no RPC, no indexer, no keys. They use a temp data dir and force dry-run mode.

---

## API (all under `/api`)

| Method | Path | What it does |
|--------|------|--------------|
| GET | `/health` | Liveness, network, feed health, loop status, wallet, clock skew, breaker state, proof anchor |
| GET | `/metrics` | Prometheus text format — every gauge above, sampled over time |
| GET | `/markets` | DreamDEX spot markets |
| GET | `/markets/binary` | Live Event Contract windows (Up/Down) |
| GET | `/markets/:symbol/book` | Top of book for a YES outcome |
| GET/PUT | `/agent/config` | Read or update the rules the bot *actually enforces* |
| POST | `/agent/run` | Run one decision cycle (dry-run by default) |
| GET | `/agent/logs` | Recent decisions + orders — filter by `kind`, `since`, `until`, `cursor` |
| GET | `/agent/stream` | SSE feed of decisions, orders, cycles, settlements, breaker trips |
| GET/POST | `/agent/loop` | Inspect / start / stop the autonomous loop |
| POST | `/agent/pause`, `/agent/resume` | Emergency stop, and the way back (`{clearFailures:true}` resets the venue counter) |
| GET | `/agent/horizons` | Horizon tier table (validated / provisional / blocked) |
| GET | `/agent/pnl` | Local fill & settlement ledger |
| GET | `/agent/pnl/verify` | Diff the ledger against the signed audit chain |
| GET | `/agent/reconcile` | Diff on-chain positions against the ledger — finds lost writes |
| GET | `/agent/report` | Performance + calibration report |
| POST | `/agent/settle-sweep` | Realise settled outcomes without redeeming |
| GET/POST | `/agent/claimable`, `/agent/claim` | Find & redeem settled winners |
| GET | `/proof` | Proof-chain entries — same filters as `/agent/logs` |
| POST | `/proof/verify` | Re-hash a range, verify linkage + signatures |

Set `SOMNUS_API_KEY` to require `X-API-Key` on mutating routes.

---

## Use it from your coding agent (MCP)

Somnus speaks [MCP](https://modelcontextprotocol.io), so you can drive it from Claude Code, Cursor, or anything else that speaks the protocol. There's no frontend because **your agent is the frontend** — you ask in English and it calls the tools.

There are two installs, and the difference is whose wallet is at stake.

### Watch mode — hosted, no key, 5 seconds

```bash
claude mcp add --transport http somnus https://somnus-backend.onrender.com/mcp
```

Twelve read-only tools. No credential, nothing to spend, nothing to steal — the hosted endpoint registers *only* the read half of the surface, so a stranger who knows the URL cannot make it trade. Ask it things like:

- *"is somnus trading right now, and what's blocking it?"*
- *"which timeframes does it actually trust, and on what evidence?"*
- *"prove it actually placed the trades it claims"*

That last one runs `somnus_proof_verify` — linkage, head match, and every signature, checked independently, with unsigned historical entries reported rather than hidden.

### Trade mode — local, your own wallet, ~2 minutes

```bash
git clone https://github.com/zachbuilds26/somnus && cd somnus && npm install
claude mcp add somnus -- npx tsx backend/src/mcp-server.ts
```

Your agent runs Somnus on **your** machine, reading **your** `backend/.env`. All 23 tools, including the 11 that move money. **Nobody hands out a private key and nobody takes custody of anyone's funds** — that's the whole reason this install exists separately from the hosted one.

Then tell your agent:

> set up somnus for me

`somnus_setup` mints a fresh wallet, writes the key to `backend/.env` (never into the conversation — an MCP result is chat content and gets stored), and reports the address. One step it *can't* do for you: the SDK's faucet mints **collateral only**, and minting is itself a transaction that needs gas. So send a little of the native token to the address it prints, then run setup again and it draws its own tUSDC.

It comes up in dry-run. Nothing reaches the chain until you say so.

### The tool surface

| | Read (hosted + local) | Write (local only) |
|---|---|---|
| **State** | `health` `config` `explain` | `config_set` `pause` `resume` |
| **Market** | `markets` `book` `horizons` | `scan` `confirm` |
| **Money** | `pnl` `report` | `settle` `claim` `setup` |
| **Trust** | `proof_verify` `pnl_verify` `reconcile` `decisions` | `loop_start` `loop_stop` `loop_status` |

Write tools go through the same broker and the same circuit breakers as the HTTP API — MCP is another doorway onto the same enforcement, not a way past it.

---

## Safety model (the short version)

- **`DRY_RUN=true` is the floor** — env can force it globally. Live needs *both* `DRY_RUN=false` **and** saved config `mode: "live"` **and** a `TRADE_KEY` (or `PRIVATE_KEY`).
- **Limits live in `data/agent-config.json`** — the same file the UI writes. A limit you set is a limit that's enforced, not just displayed.
- **`maxOpenNotional` bounds a batch, not just a trade.** A daily loss cap only sees *realised* loss, and a binary realises nothing until its window settles — so orders placed inside one interval are invisible to it. This caps the collateral riding at once and defaults to your daily loss limit.
- **Correlated positions are counted as correlated.** `maxPerExpiryBucket` limits how much of the book settles on one tick; ten "separate" positions on the same expiry are one bet.
- **The loss breakers are never allowed to go blind.** They read the P&L ledger, so a settlement sweep runs *before* they're evaluated every cycle — and if sweeps stop succeeding, the agent refuses new risk instead of trading on stale numbers.
- **One process per data dir.** A lockfile enforces it; two processes would corrupt the audit chain and double-spend the position budget.
- **It tells you when it stops.** Set `ALERT_WEBHOOK_URL` and a breaker trip, loop halt, feed blackout or unrecorded position reaches you instead of a log file.
- **Dedicated testnet key only** — put only what you're willing to lose.
- **The hosted MCP endpoint cannot trade.** It registers only read tools, so publishing the URL hands out no authority. Trading lives in the local install, where the person running the process owns the wallet.
- **Loop is off by default** — `POST /api/agent/loop/start` or `AGENT_AUTOSTART=true` to arm it.

---

## Why the audit chain matters

Most "trading bots" are black boxes. Somnus writes every decision to an append-only hash chain:

```
prevHash + canonicalJSON(payload) + kind → sha256 → this entry's hash
```

Optionally signed with secp256k1. `POST /proof/verify` checks:
1. **Linkage** — every `prevHash` matches the recomputed chain
2. **Head matches** — recomputed head equals the server's reported anchor
3. **Signatures** — every signature recovers to the configured signer

Linkage alone isn't enough (a drifted anchor passes link checks while being wrong). Signatures alone aren't enough (an unsigned chain would pass). You need all three.

---

## The signal, in plain English

For each Event Contract window, Somnus asks: *"What's the probability this asset finishes at or above the reference level?"*

It answers using:
- Live spot price from Somnia's oracle
- The window's reference level (absolute strike, or "vs opening price" for strike=0)
- Time remaining
- **Realized volatility measured at that horizon** — not 1-min vol scaled by √t (that overstates long-horizon vol on mean-reverting feeds)

The edge = fair probability − book price. If edge ≥ your `minEdge` (scaled by horizon tier), it sizes the trade and submits IOC.

Horizon tiers (learned from settled windows, not hardcoded):
| Tier | When | Edge bar | Stake |
|------|------|----------|-------|
| `validated` | Beats base rate + calibrated (n≥40) | 1× minEdge | 1× maxTradeSize |
| `provisional` | Too few samples, or miscalibrated | 2× minEdge | 0.5× maxTradeSize |
| `blocked` | No better than base rate | — | none |

Run `npm run horizon-study` to re-score and promote/demote tiers. The agent picks up the new table on its next cycle — no restart.

---

## CLI commands

```bash
npm run typecheck     # tsc --noEmit
npm test              # 130 unit + regression tests, no network, no keys
npm run doctor        # read-only connectivity probe (no keys needed)
npm run faucet        # mint test tUSDC to trade key (testnet)
npm run claim         # report claimable settled positions
npm run claim -- go   # redeem them (honours DRY_RUN)
npm run horizon-study # re-score all horizon classes
npm run calibration   # view current tier table
npm run survey        # what markets are actually live right now
```

---

## Network endpoints

| What | Testnet | Mainnet |
|------|---------|---------|
| RPC | `https://dream-rpc.somnia.network` | `https://api.infra.mainnet.somnia.network` |
| REST (spot only) | `https://stg.api.dreamdex.io/v0` | `https://api.dreamdex.io/v0` |
| **Indexer (GraphQL, SDK)** | `https://dev.smk.somnia.host/v1/graphql` | `https://prd.smk.somnia.host/v1/graphql` |
| Chain WS (SDK live tail) | `wss://api.infra.testnet.somnia.network/ws` | `wss://api.infra.mainnet.somnia.network/ws` |

**Two traps:**
1. REST API has **no Event Contract endpoints** — they come from the SDK (GraphQL indexer)
2. `INDEXER_URL` must be the **GraphQL** endpoint. Passing the REST base makes every SDK call fail with `indexer RegistryMarkets failed`.

---

## Detailed docs

See [`backend/README.md`](backend/README.md) for:
- Full execution details (why both directions are BUYs, crossing logic, window status checks)
- Concurrency guarantees (one cycle at a time, one proof append at a time, one claim at a time)
- Signal model math & horizon volatility methodology
- Autonomous loop behavior
- Demo without keys (`FAIR_OVERRIDE_BTC=0.62` to force a hypothesis)