# Somnus

**An autonomous trading bot for DreamDEX Event Contracts on Somnia.**

Somnus reads live order books, forms its own probability estimates, and places trades — all within hard risk limits you set. Every decision, order, and config change is written to a tamper-proof audit chain so you (or anyone else) can verify exactly what happened and why.

Built for the **Somnia × DreamDEX Event Contracts Hackathon**. Testnet-first.

---

## What it actually does

1. **Watches live markets** — pulls Event Contract windows (Up/Down) and order books from DreamDEX via the Somnia Markets SDK
2. **Thinks for itself** — computes a fair probability using driftless GBM with horizon-matched volatility (not naive sqrt-scaling), compares it to the book, and only acts when there's genuine edge
3. **Respects your limits** — max trade size, max open positions, max open exposure, min edge, daily loss cap, loss streak, execution failures, data freshness — all enforced server-side, not in the UI
4. **Leaves a paper trail** — every decision, order, claim, and config change goes into a hash-chained, optionally signed JSONL log. `POST /proof/verify` lets anyone audit the chain end-to-end, and means it: the route is exempt from the gateway key, since a public audit that needs the operator's secret is not one. Caller-supplied slices are capped at 5,000 entries per request, because each entry costs a signature recovery.
5. **Runs autonomously** — start the loop and it runs non-overlapping cycles on your interval. Or call `POST /agent/run` for a one-off.

**Is it profitable? No — and the ledger says so in public.** Realised P&L is -3,196 tUSDC over 76 settled trades. Roughly 95% of that came from four oversized trades in a ninety-second window on 30 August, caused by two bugs this repo's own instrumentation caught and fixed — one of which recorded a winning trade as a loss. [The full account is below](#the--3196-on-the-pnl-and-what-actually-caused-it), reconstructed entirely from the ledger and the audit chain. The number stays on the record because a figure that looks better and cannot be interrogated would be worth less.

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

**Backend only — no frontend.** A JSON API, an autonomous runtime, and an MCP surface: a hosted endpoint anyone can interrogate (and trade through with a wallet of their own), plus a local install that runs on your machine with your key.

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
| GET | `/markets/book?symbol=` | Top of book for a YES outcome. Use this form — Event Contract symbols contain `/` and `#`, so the path form below needs `%2F`/`%23` |
| GET | `/markets/:symbol/book` | Same, path form. The symbol **must** be percent-encoded (`BTC-…-1538%2FtUSDC%23YES`) or the `/` splits the path and it 404s |
| GET/PUT | `/agent/config` | Read or update the rules the bot *actually enforces*. `tradingPaused` is rejected here — use `/agent/pause` and `/agent/resume`, which alert and audit |
| POST | `/agent/run` | Run one decision cycle. Always returns proposals as **pending** for confirmation and never places an order itself — to auto-execute, use the `somnus_scan` MCP tool with `confirm:true`, or run the loop |
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

There are three ways in, and the difference is whose wallet is at stake.

### Watch mode — hosted, no key, 5 seconds

```bash
claude mcp add --transport http somnus https://somnus-backend.onrender.com/mcp
```

Twelve read-only tools. No credential, nothing to spend, nothing to steal — nothing registered here can touch the operator's wallet or change a saved rule. (The six per-user tools below are listed too; calling one without a token answers with how to send one.) Ask it things like:

- *"is somnus trading right now, and what's blocking it?"*
- *"which timeframes does it actually trust, and on what evidence?"*
- *"prove it actually placed the trades it claims"*

That last one runs `somnus_proof_verify` — linkage, head match, and every signature, checked independently, with unsigned historical entries reported rather than hidden.

**The slow tools narrate themselves.** Pricing eight windows means eight order-book reads and takes the better part of a minute; verifying the chain is one ECDSA recovery per entry across thousands. That used to be dead silence followed by an abrupt answer, which reads as a hung tool. These now emit MCP `notifications/progress` as they work:

```
+0ms     finding tradeable windows
+2527ms  reading spot and candles for 2 asset(s)
+5289ms  [0/8] pricing 5m BTC (1 of 8)
+5469ms  [1/8] pricing 5m ETH (2 of 8)
...
+6777ms  result
```

This is deliberately **server-side, not a client setting**. Progress is part of the MCP protocol, so any client that renders it gets this — Claude Code, Cursor, Cline, your own script — with nothing to configure. It is also strictly additive: a client that sends no `progressToken` gets no notifications and a byte-identical result, because the spec forbids volunteering progress nobody asked for. Reporting is fire-and-forget, so a client that hangs up mid-call can never turn a placed trade into a failed tool.

### Your-wallet mode — hosted, your own token, ~1 minute

```bash
claude mcp add --transport http somnus https://somnus-backend.onrender.com/mcp \
  --header "x-somnus-token: $(openssl rand -hex 24)"
```

Six more tools appear, and they act on a wallet that is **yours**. The server derives it as `HMAC(server secret, your token)` — so the same token always returns the same wallet and **nothing is stored anywhere**. There is no per-user database to back up, migrate, or lose in a deploy. Keep the token like a password: it is the only thing that controls the wallet.

Then say: *"set up my somnus wallet"*

`somnus_my_wallet` prints the address. Send it about **0.7 STT** of testnet gas, then `somnus_my_fund` draws your own tUSDC — the SDK's faucet mints **collateral only**, and minting is itself a transaction, so gas is the one step nobody can automate for you. After that: *"what would you trade for me with $5?"* (`somnus_my_quote`) and *"do it"* (`somnus_my_trade`).

Every tool that finds your wallet short on gas prints these itself, with your address already filled in — you should never have to come back here for them:

| Faucet | Why this one |
| --- | --- |
| [Google Cloud Web3](https://cloud.google.com/application/web3/faucet/somnia/shannon) | Try first — run by Google Cloud, sends STT straight to any EVM address |
| [thirdweb Somnia Shannon](https://thirdweb.com/somnia-shannon-testnet) | Ecosystem partner, claims through the Shannon network page |
| [Stakely](https://stakely.io/faucet/somnia-testnet-stt) | No sign-in and no Google account — just a captcha |

Need more than a faucet hands out (stress testing)? Ask in `#dev-chat` on the [Somnia Discord](https://discord.com/invite/somnia) and tag DevRel `@emreyeth`.

STT pays **gas only**. It is not the tUSDC you trade with, and the two are never interchangeable — having 10,000 tUSDC and no STT still means you cannot trade.

Why 0.7 when a trade only burns about 0.004: the venue builds transactions with a 10,000,000 gas limit at 60 gwei, and the node checks that **worst case** against your balance before it will accept one. A wallet holding less passes every local check and then dies at the node with `insufficient balance`, so the tools refuse early and name the real number instead.

**This is custodial, and it is not hidden.** The server can recompute the key for any token, so it could move any caller's funds. Somnia has no scoped-permission mechanism — the SDK states plainly that a session seed "is a private key in another shape" and whoever holds it "can move the session account's funds" — so a hosted agent that trades for you necessarily holds something that could also drain you. It is acceptable here for exactly one reason: these are **testnet** wallets funded from a faucet. The code refuses to derive one on mainnet, and you should not deposit anything you would miss.

What bounds a trade placed this way:

- `confirm: true` on the call that spends — a quote is free, a purchase is deliberate
- a hard per-trade cap (1000 tUSDC by default, a tenth of one faucet drip) and an hourly per-token rate limit, neither of which a tool argument can raise. Ask for more and you are clamped down and told so; ask for nothing and it stakes the cap, so name a number if you want a smaller bet
- your stake is a **ceiling, not a fixed amount**. Two things shrink it, and every quote says which in plain words (`sizingNote`, next to `stakeRequested` and `stakeUsed`): a window class the model has not yet proven itself on is sized at **half** and demands **double** the edge, and contracts are whole units so the remainder after the last one is left unspent. Ask to risk 10 on an hourly window and expect about 4.85 — deliberately, and now stated rather than inferred from the cost
- the operator's kill switch: a paused deployment adds no new risk of any kind, including yours
- the same model, horizon tiers and edge bar the agent applies to its own money (you can demand *more* edge, never less)
- your wallet's own balance — it can only spend what you funded
- an entry in the same signed audit chain, identified by a non-reversible handle and never by your token

### Operator mode — local, your own key, ~2 minutes

```bash
git clone https://github.com/zachbuilds26/somnus && cd somnus && npm install
claude mcp add somnus -- npx tsx backend/src/mcp-server.ts
```

Your agent runs Somnus on **your** machine, reading **your** `backend/.env`. All 23 tools, including the 11 that move money and change limits. **Nobody hands out a private key and nobody takes custody of anyone's funds** — that's the whole reason this install exists separately from the hosted one.

Then tell your agent:

> set up somnus for me

`somnus_setup` mints a fresh wallet, writes the key to `backend/.env` (never into the conversation — an MCP result is chat content and gets stored), and reports the address. One step it *can't* do for you: the SDK's faucet mints **collateral only**, and minting is itself a transaction that needs gas. So send a little of the native token to the address it prints, then run setup again and it draws its own tUSDC.

It comes up in dry-run. Nothing reaches the chain until you say so.

### The tool surface

| | Read — anyone | Your wallet — hosted, with a token | Operator — local only |
|---|---|---|---|
| **State** | `health` `config` `explain` | `my_wallet` | `config_set` `pause` `resume` |
| **Market** | `markets` `book` `horizons` | `my_quote` | `scan` `confirm` |
| **Money** | `pnl` `report` | `my_fund` `my_trade` `my_positions` `my_claim` | `settle` `claim` `setup` |
| **Trust** | `proof_verify` `pnl_verify` `reconcile` `decisions` | — | `loop_start` `loop_stop` `loop_status` |

Operator tools go through the same broker and the same circuit breakers as the HTTP API — MCP is another doorway onto the same enforcement, not a way past it.

Per-user tools deliberately do **not** go through the broker: it enforces the operator's mandate and writes cost basis into the ledger the operator's loss breakers read, so feeding somebody else's trades into it would fire the operator's daily-loss limit on a stranger's losses. What they share is everything that bounds a single order — the probability model, the tier policy, the crossing rule, the fill accounting and the on-chain window check.

Per-user tools are registered only when the deployment sets `SOMNUS_USER_SECRET`, and their orders only reach the chain when it also sets `SOMNUS_USER_TRADING=live`. Otherwise every trade is priced, recorded and not sent.

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
- **The hosted endpoint cannot touch the operator's wallet.** Publishing the URL hands out no authority over it: the read tools spend nothing, and the per-user tools spend only the wallet the caller's own token derives. Trading the operator's wallet lives in the local install, where the person running the process owns the key.
- **Per-user wallets are custodial and testnet-only.** The server derives them, so it can move them; the code refuses on mainnet, and orders are priced-but-not-sent unless the operator sets `SOMNUS_USER_TRADING=live`.
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

### What is in the chain, and whose

Two different records, and the difference matters if you use the hosted endpoint:

| Record | Contains | Public route |
| --- | --- | --- |
| Proof chain | **every** order — the agent's own *and* every hosted caller's | `GET /proof`, `GET /agent/logs` |
| P&L ledger | the **agent's own** trades only | `GET /agent/pnl`, `/metrics` |

So if you trade through `somnus_my_trade`, your order is written into the public audit chain, tagged `via: "mcp-user"` with your wallet address and a non-reversible handle. Your token never appears. Your wallet address is already public on-chain, so nothing is revealed that a block explorer would not show — but **your trades are visible to anyone reading the chain**, by design: an audit trail with parts missing is not one.

Your wins and losses never enter the P&L ledger. That is deliberate rather than incidental: the agent's own loss limits read that ledger, and folding a stranger's outcomes into it would let their bad day trip the operator's circuit breakers. `/agent/pnl` is the agent's own report card and nobody else's.

---

## The -3,196 on the PnL, and what actually caused it

`/agent/pnl` and `/metrics` are public and unauthenticated. They currently read:

```
fills 76 · closed 76 · win rate 36.8% · realizedPnl -3196.65
```

That is a real number from a real ledger and it is not being hidden. It is also almost entirely the record of two bugs rather than of the model, and the ledger itself is what makes that provable.

**Four trades, 30 August, inside ninety seconds:**

| Cost | Contracts | Implied price | Outcome |
| --- | --- | --- | --- |
| 999.86 | 1976 | 0.5060 | **won**, paid 990 |
| 999.66 | 2866 | 0.3488 | lost |
| 999.92 | 4182 | 0.2391 | lost |
| 999.77 | 2377 | 0.4206 | lost |

Those four cost 3,999 and returned 990. They are **94.7% of all collateral this agent has ever committed**. The other 72 fills risked 449 in total and came out close to flat.

**Bug one: exposure was never checked against the chain.** `maxOpenNotional` was 1,000. Four orders of ~1,000 each landed inside it because the ceiling was compared against a counter this process kept in memory, not against positions actually held on-chain. Fixed in `9ffda05` — `beginCycle` now establishes the open-position baseline from `countOpenByMarket()` before any order is considered.

**Bug two: cost basis was recorded against the requested size.** Look at row one. 1,976 contracts requested at 0.506, 990 actually filled, and the ledger booked 999.86 — a position that really cost ~501 and paid out 990. A 489 **winner**, written into the ledger as a 10 loser. An IOC fills partially and cancels the remainder; the accounting did not know that. Fixed in the same commit — `resolveFill` now reads the filled quantity out of the pool's own `OrderFilled` events.

So the headline loss contains at least one trade that made money, sized by a limit that was not being enforced. `maxTradeSize` is **2** now, and the per-cycle exposure baseline comes from the chain.

**What this is evidence of.** The reason both bugs are describable to this level of detail is the thing the loss is recorded in: every fill carries its requested size, its filled size, the price paid, the model's fair value, the freshness of every input, and a hash linking it to the entry before it. Nothing was reconstructed from memory for this section — the numbers came out of the ledger and the chain, and `POST /proof/verify` will confirm all 2,885 entries independently.

A number that looks better and cannot be interrogated would be worth less. The loss stays on the record.

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
npm test              # 239 unit + regression tests, no network, no keys
npm run doctor        # read-only connectivity probe (no keys needed)
npm run faucet        # mint test tUSDC to trade key (testnet)
npm run claim         # report claimable settled positions
npm run claim -- go   # redeem them (honours DRY_RUN)
npm run horizon-study # re-score all horizon classes
npm run calibration   # view current tier table
npm run survey        # what markets are actually live right now
```

`data/` is gitignored — it holds the proof chain and the P&L ledger — so a fresh clone or
a fresh deploy has no measured tier table. `backend/calibration.seed.json` is a committed
study (4,000 scored windows) that fills that gap, and `/agent/horizons` says which one you
are looking at:

| `source` | Means |
| --- | --- |
| `measured` | this agent ran the study on its own settled trades |
| `seeded` | the study committed to the repo — real measurements, not this deployment's |
| `built-in default` | constants, no measurement behind them |

`data/horizon-calibration.json` always wins when present, so a running agent's own
measurements override the seed. After `npm run horizon-study`, copy the result over
`calibration.seed.json` to update what a fresh deploy starts from.

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