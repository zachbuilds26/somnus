# Somnus Backend

Governed, auditable AI trading agent runtime for **DreamDEX Event Contracts on Somnia**.
Backend-first: the REST API *is* the product shell; the frontend is a window into it.

## Run (dev)

```bash
# from repo root
npm install
cp .env.example backend/.env      # keep NETWORK=testnet, DRY_RUN=true
npm run dev:be                     # tsx watch → http://localhost:4545
```

Or directly from `backend/`:

```bash
npm run dev          # tsx watch src/server.ts
npm run start        # one-shot server
npm run typecheck    # tsc --noEmit
npm run doctor       # read-only connectivity probe (REST checks need no keys)
```

Requires Node 20+.

## Environment

All vars documented in `.env.example` (repo root). Non-exhaustive safety-critical ones:

| var | default | meaning |
|---|---|---|
| `NETWORK` | `testnet` | `testnet` (chain 50312) or `mainnet` (5031) |
| `DRY_RUN` | `true` | `true` = broker logs orders and sends nothing |
| `AGENT_MODE` | `dry-run` | `dry-run` \| `live` \| `view` |
| `PRIVATE_KEY` / `OPERATOR_KEY` / `TRADE_KEY` | – | needed only for live execution |
| `AGENT_SYMBOLS` | `BTC,ETH` | base-symbol filter for Event Contract windows |
| `AGENT_MIN_EDGE` | `0.03` | minimum fair-vs-book edge to trade |

## API

Base `http://localhost:4545/api`

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + network + DRY_RUN state + loop status + proof anchor |
| GET | `/markets` | spot markets from the DreamDEX REST indexer (live) |
| GET | `/markets/binary` | live Event Contract (Up/Down) windows via SDK — **no key needed** |
| GET | `/markets/:symbol/book` | top-of-book + mid for a YES symbol |
| GET/PUT | `/agent/config` | read / update governing rules |
| POST | `/agent/run` | one decision cycle (dry-run by default) |
| GET | `/agent/logs` | recent decisions + orders |
| GET | `/agent/loop` | autonomous loop status (cycles, errors, interval) |
| POST | `/agent/loop/start` | start running cycles on `intervalMs` |
| POST | `/agent/loop/stop` | stop the loop |
| GET | `/agent/claimable` | settled positions that can be redeemed |
| POST | `/agent/claim` | redeem them (honours DRY_RUN + `claimEnabled`) |
| GET | `/proof` | latest proof-chain entries |
| POST | `/proof/verify` | re-hash a range and verify linkage |

Optional gateway auth: set `SOMNUS_API_KEY` and send `X-API-Key`.

## CLI

```bash
npm run typecheck     # tsc --noEmit
npm test              # 51 unit + regression tests, no network, no keys
npm run doctor        # read-only connectivity probe (no keys needed)
npm run faucet        # mint test tUSDC to the trade key (testnet only)
npm run faucet -- 2500
npm run claim         # report claimable settled positions
npm run claim -- go   # redeem them (still honours DRY_RUN)
```

## Tests

`npm test` runs offline — no RPC, no indexer, no keys — so it works on a fresh
clone. It uses the Node built-in runner via `tsx`.

Coverage is deliberately weighted toward **regressions for bugs that actually
happened**, not toward a coverage percentage:

| area | what it pins down |
|---|---|
| `store.test.ts` | 25 concurrent appends must not break linkage — the bug that corrupted a real 341-entry chain. Also: tampering, reordering and dropped entries must all fail, and key order must not matter. |
| `pricing.test.ts` | sizing and the notional gate must agree on the cost basis; a Down leg costs `(1 - bid)`. Getting this wrong rejected 100% of Down orders. |
| `signal.test.ts` | horizon volatility must not be the `sqrt(t)` multiple on a mean-reverting series; strike scaling must reject an implausible level rather than trade a 100x-wrong one. |
| `agent-config.test.ts` | no hostile PUT can widen the risk envelope — and no casing trick (`"LIVE"`) can arm live mode. |

Tests run against a temp `DATA_DIR` (set by `test/env.ts` via `tsx --import`) with
`DRY_RUN` forced on, so a test run can neither append to the real audit chain nor
send an order.

## Durability of the audit chain

- Payload hashes are **canonical** (key-sorted JSON), so the same content hashes
  the same regardless of key order. Entries written before this change still
  verify — the verifier accepts either scheme rather than invalidating history.
- The JSONL file is the **source of truth**. Memory holds a bounded window
  (`MAX_MEMORY_ENTRIES`) so a long-running loop isn't a slow leak; full-chain
  verification reads the file, not the window, so it can never quietly verify
  only the tail.
- A torn final line (crash mid-append) is skipped on boot. A chain that fails its
  linkage recheck is **kept**, warned about loudly, and resumed from the true
  computed head — never from the previous entry's `prevHash`, which would fork
  the tip.

## Execution details that cost real money to learn

- **Both directions are BUYS.** Up buys YES; Down buys the NO outcome. Selling an
  outcome you don't hold is a naked short and the pool refuses it
  (`InsufficientBalance()`).
- **Orders cross the touch by ~1pp**, capped so the price never exceeds our own
  fair value. Submitting at exactly the best offer means any one-tick move
  reverts `ImmediateOrCancelNoFill()` — gas spent for nothing.
- **The window's on-chain status is checked before every submit.** The indexer
  trails the chain, so a window it lists as active may already be locked
  (`TradingNotActive`).
- **Windows with under `AGENT_MIN_EXPIRY_SEC` left are skipped** — a cycle takes
  tens of seconds and a near-close window locks mid-flight.
- **Window class drives the edge bar and the stake**, not a single on/off horizon
  cap. See *Which windows it trades* below.
- **The signing client's symbol table refreshes on a TTL.** It is a separate SDK
  instance from the reader with its own symbol cache, and new windows are minted
  every minute; hydrating it once makes every order on the freshest markets fail.
- **`maxOpenPositions` counts real on-chain exposure**, not orders seen in the
  log. A log-based count never decreases, so the agent would stop trading forever
  once it crossed the limit.
- **Tightening a limit mid-cycle sizes the trade down**, it doesn't discard it.

## Concurrency guarantees

Three invariants are enforced rather than left to luck:

- **One proof append at a time.** `appendEntry` reads the chain anchor, awaits a
  signature, then writes it back. Concurrent appends corrupted a real chain
  during testing (5 linkage breaks) — the running anchor drifted while each entry
  still linked to a fresh one, so per-entry checks passed while the chain head was
  wrong. Appends are now queued.
- **One cycle at a time.** `POST /agent/run` bypassed the loop's busy guard, and
  the per-cycle position counter is module state. A concurrent caller now joins
  the in-flight cycle.
- **One claim at a time.** Two concurrent claims would each redeem the same
  positions, the second burning gas to revert.

## Verifying the audit trail

`POST /proof/verify` checks three things, and `ok` requires all of them:

| field | meaning |
|---|---|
| `linkageOk` | every entry's `prevHash` matches the recomputed chain |
| `headMatches` | the recomputed head equals the anchor the server reports |
| `signaturesOk` | every signature recovers to the configured signer address |

Linkage alone is not enough: it derives each cursor from the entry's own
`prevHash`, so a drifted anchor passes every link while being wrong. And without
the signature check, an entirely unsigned chain returns `ok: true` — which it did
until a faulty local viem type shim was corrected (see `src/types/viem.d.ts`).

## The signal

The agent forms its **own** probability rather than echoing the book, so it has a
reason to act. For each window it takes live spot from Somnia's oracle price
feed, the level the window settles against, the time remaining, and recent
realised volatility, then computes `P(spot_T >= reference)` under driftless GBM.
The edge is that number minus the book price.

Two window shapes exist and both are handled: an absolute `strike`, and
`strike === 0` meaning *"closes at or above its opening price"* — the latter needs
`getOpeningPrices` for its reference level and is the majority of live windows.

Volatility is measured **at each window's own horizon** via overlapping k-step
returns, not by scaling 1-minute vol by `sqrt(t)`. That matters: this feed
mean-reverts, so sqrt-scaling overstated 4h volatility by ~4x, dragged every
probability toward 0.5, and manufactured a systematic one-sided bias. The proof
note records which estimator was used (e.g. `sigma 0.337% [224m direct]`).

Set `FAIR_OVERRIDE_BTC=0.62` to assert a probability for a demo; it is recorded
as `asserted, not computed` so the audit trail never hides it.

## Which windows it trades, and on what evidence

DreamDEX lists window classes from 1m to 24h. The model is not equally
trustworthy across all of them, so **every class gets a tier**, and the tier
scales the two things that actually bound damage — the edge demanded before
paying, and the size paid with:

| tier | when | edge bar | stake |
| --- | --- | --- | --- |
| `validated` | beats the base rate **and** is calibrated, on n ≥ 40 settled windows | `minEdge` | `maxTradeSize` |
| `provisional` | too few samples yet, **or** directionally useful but miscalibrated | `2x minEdge` | `0.5x maxTradeSize` |
| `blocked` | measured to be no better than the base rate | — | none |

The table is **not hardcoded**. `npm run horizon-study` scores each class against
1000 settled windows and writes `data/horizon-calibration.json`; the agent reads
that file on its next cycle, no restart. So a class graduates from evidence rather
than from someone remembering to edit a constant — which is the whole
train-it-over-time loop: trade provisionally, settle, re-measure, promote.

Latest run on Somnia testnet:

```
  1m   blocked      Brier 0.2500 vs 0.2496 base rate, n=786   <- disproven, not unknown
  5m   validated    Brier 0.1944 vs 0.2500, cal. err 0.100, n=154
 15m   validated    Brier 0.1534 vs 0.2484, cal. err 0.098, n=50
  1h   provisional  n=10 of 40 needed to judge
  4h   provisional  no settled windows scored yet
 24h   provisional  no settled windows scored yet
```

`GET /agent/horizons` returns this table live, and `npm run doctor` prints it.

Three details that are easy to get wrong:

- **A long window in its final minutes is a short-horizon bet.** A 4h window with
  10 minutes left carries 10 minutes of variance, not 4 hours of it, so it is
  judged in the 15m regime. The label is still recorded as `4h` for the audit
  trail. Judging by the name on the window would have applied an unmeasured
  verdict to a measured situation.
- **Measurements do not extrapolate far.** A verdict applies to horizons within
  3x of what was measured; beyond that the class is treated as unknown, not as
  inheriting the nearest number.
- **Long classes get reserved slots** (`AGENT_PROVISIONAL_SLOTS`, default 4).
  There are always hundreds of live 15m windows, so without a reservation the
  agent would fill every slot with them and the 1h/4h/24h classes could never
  accumulate the settled samples they need to graduate.

`npm run survey` reports what the venue is actually offering and where the volume
is, which is a different question from where the model is accurate.

## Safety model

1. **DRY_RUN=true everywhere** until you explicitly set `AGENT_MODE=live` + a key.
   `DRY_RUN` is a floor, not a preference: env can force it on globally, and the
   saved agent mode must *also* be `live` before anything is sent.
2. Every order still passes server-side limit gates: notional ≤ `maxTradeSize`,
   open positions ≤ `maxOpenPositions`, price within (0,1), edge ≥ `minEdge`.
   These read the **saved rules** (`backend/data/agent-config.json`, written by
   `PUT /agent/config`) — the same document Agent Studio edits — so a limit you
   set in the UI is genuinely enforced rather than merely displayed. Notional for
   a Down leg is `(1 - bid) x size`, the actual cash at risk, not the wire price.
3. **Proof chain** — every decision/order/config is hashed into a tamper-evident
   chain (`prevHash + payloadHash + kind` → sha256), optionally signed
   (`privateKeyToAccount` over secp256k1), and **persisted** to
   `backend/data/proof-chain.jsonl` (append-only JSONL, restored on boot).
4. Live orders use the trade/session key (`TRADE_KEY`), IOC only — never a
   resting order — and the operator/reset key never signs trades.

## Layout

```
src/
  config.ts        env + safe defaults (network, endpoints, agent seeds)
  agent-config.ts  the saved governing rules — single source of truth for limits
  server.ts        express bootstrap + gateway key check
  routes/          health, markets, agent, proof
  services/
    markets.ts     REST spot-market normalizer
    sdk.ts         SDK gateway: keyless reads (event markets + books), retry + cache
    sdk-live.ts    real IOC order placement (signing client only)
    signal.ts      independent fair-probability model + horizon-matched volatility
    horizon.ts     per-class tiering: what to trade, at what edge bar and size
    pricing.ts     fair-vs-book decision math (BUY_YES / BUY_NO / PASS)
    agent.ts       one decision cycle: books → signal → decisions → orders
    broker.ts      the hard gate: limits, DRY_RUN, order routing, optional submit
    loop.ts        the autonomous loop (non-overlapping cycles on intervalMs)
    settlement.ts  claim sweep: find settled winners and redeem them
    proof.ts       secp256k1 signer over the proof hash
    store.ts       hash-chained audit log + JSONL persistence
```

## Autonomous operation

`intervalMs` in the saved rules drives the loop. It is **not** started
automatically unless `AGENT_AUTOSTART=true` — a process that begins trading the
moment it boots is the wrong default for something holding a key.

```bash
curl -XPOST localhost:4545/api/agent/loop/start
curl localhost:4545/api/agent/loop        # cycles, errors, lastSummary
curl -XPOST localhost:4545/api/agent/loop/stop
```

Cycles never overlap: the next tick is scheduled from the previous one's
*completion*, so a cycle slower than the interval can't stack up a backlog or
double-spend the position budget.

## Demo without keys

**No key is needed for reads.** `GET /api/markets` returns real testnet spot data,
and `GET /api/markets/binary` + `/markets/:symbol/book` return live Event Contract
windows and order books — `privateKey` is optional in the SDK and only writes
need it. The agent runs in DRY_RUN (decisions + simulated orders recorded).
A key in `backend/.env` is required only to *place* orders.

To see the agent trade in dry-run on a *hypothesis*, set e.g. `FAIR_OVERRIDE_BTC=0.62`
in the environment — the signal will displace from consensus and produce BUY/SELL
decisions the broker still gate-checks and logs without sending anything.

## Endpoints, by network

| what | testnet | mainnet |
|---|---|---|
| RPC | `https://dream-rpc.somnia.network` | `https://api.infra.mainnet.somnia.network` |
| REST (spot only) | `https://stg.api.dreamdex.io/v0` | `https://api.dreamdex.io/v0` |
| Indexer (**GraphQL**, SDK) | `https://dev.smk.somnia.host/v1/graphql` | `https://prd.smk.somnia.host/v1/graphql` |
| Chain WS (SDK live tail) | `wss://api.infra.testnet.somnia.network/ws` | `wss://api.infra.mainnet.somnia.network/ws` |

Two traps worth knowing:

- The **REST API has no event-contract endpoints** — spot and perp only. Event
  Contracts come from the SDK. Overridable via `REST_URL` / `INDEXER_URL` / `WS_RPC_URL`.
- `indexerUrl` must be the **GraphQL** endpoint. Passing the REST base makes every
  SDK call fail with `indexer RegistryMarkets failed`.

### On depending on someone else's indexer

`dev.smk.somnia.host` is an upstream **dev** endpoint. It is not ours and its
uptime is not ours either — `fetch failed` was observed intermittently during
development. What the backend does about it:

- retries transient failures with backoff (`fetch failed`, DNS, resets),
- serves the last good market snapshot on failure rather than an empty board,
- returns a clear 503 with a hint instead of a bare stack trace,
- takes `INDEXER_URL` so you can repoint it without a code change.

What it cannot do is invent data during a full outage. If the board is empty
mid-demo, that is the honest reason — check `npm run doctor` first.

`@somnia-chain/markets-sdk` is pinned `>= 0.28.1` deliberately: below 0.28.0 the
unified verbs don't snap prices to the venue tick grid and orders revert
`InvalidPrice`; below 0.24.0 sub-lot sizes silently floor to zero.