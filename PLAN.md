# Somnus — Backend Plan

> **Somnus** is a governed, auditable trading-agent backend for DreamDEX Event
> Contracts on Somnia.
>
> **One line:** Read live market data, form an explainable probability estimate,
> execute only within server-enforced limits, and preserve cryptographic proof of
> every decision and action.

## Product boundary

Somnus is intentionally **backend-only**.

It exposes a JSON API and an autonomous runtime for an operator-controlled trading
agent. There is no browser application, embeddable widget, Telegram integration,
or MCP server in this repository.

## Runtime architecture

```text
DreamDEX / Somnia data
        │
        ▼
services/sdk.ts ── live Event Contract windows, books, spot, candles
        │
        ▼
services/signal.ts ── independent fair probability estimate
        │
        ▼
services/pricing.ts + services/horizon.ts ── decision and evidence tier
        │
        ▼
services/broker.ts ── server-side risk gates and IOC execution
        │
        ├── services/sdk-live.ts ── optional testnet/live order submission
        ├── services/settlement.ts ── claims and position state
        ├── services/pnl.ts ── local fill/settlement ledger
        └── services/store.ts ── signed, hash-chained proof log
```

The enforced data flow is:

```text
markets → model → decision → broker → chain → proof
```

## Core behavior

1. **Market reads** use the Somnia Markets SDK. The REST API is spot/perp only;
   Event Contract discovery and books come from the SDK GraphQL indexer.
2. **Fair value** is estimated with driftless GBM using live spot, contract
   reference level, remaining time, and realized volatility.
3. **Horizon calibration** controls whether a timeframe is validated,
   provisional, or blocked. Provisional horizons require more edge and use less
   size.
4. **Broker gates** enforce saved agent rules on every action, including amount,
   open positions, open collateral, edge, freshness, daily loss, loss streak,
   execution failures, and the kill switch.
5. **Execution** only reaches the chain when both `DRY_RUN=false` and saved
   `mode=live` are present. Orders are IOC and never intentionally cross the
   agent's own fair value. Cost basis is recorded from the quantity the venue
   reports as filled, not from the quantity requested — an IOC may fill partially.
6. **Proof** stores each decision, order, claim, and config mutation in an
   append-only JSONL hash chain, optionally signed with secp256k1.

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness, network, feeds, risk, loop, and proof state |
| GET | `/api/markets` | DreamDEX spot markets |
| GET | `/api/markets/binary` | Live Event Contract windows |
| GET | `/api/markets/:symbol/book` | Top of book for a YES outcome |
| GET/PUT | `/api/agent/config` | Read or update enforced rules |
| POST | `/api/agent/run` | Execute one decision cycle |
| GET | `/api/agent/logs` | Recent decisions and orders |
| GET/POST | `/api/agent/loop` | Inspect/start/stop the autonomous loop |
| GET | `/api/agent/horizons` | Horizon evidence and policy table |
| GET | `/api/agent/pnl` | P&L ledger summary |
| GET | `/api/agent/report` | Performance report |
| GET/POST | `/api/agent/claimable`, `/api/agent/claim` | Inspect/redeem settled positions |
| GET | `/api/proof` | Proof-chain entries |
| POST | `/api/proof/verify` | Verify proof linkage and signatures |

## Safety model

- Safe defaults: `NETWORK=testnet`, `DRY_RUN=true`, `AGENT_MODE=dry-run`.
- A global environment safety floor and saved agent config must both permit live
  trading before an order can be submitted.
- The runtime binds to loopback by default. Set `HOST=0.0.0.0` only when you
  deliberately deploy it, and always configure `SOMNUS_API_KEY` for exposed
  environments.
- Use a dedicated trading wallet with only limited testnet capital.
- The loop is off by default. Start it with `POST /api/agent/loop/start` or set
  `AGENT_AUTOSTART=true` only after the config and key are verified.

## Development milestones

- [x] Live Event Contract reads and market normalization
- [x] Independent probability model and horizon-aware policy
- [x] Enforced broker gates, dry-run behavior, and optional live IOC execution
- [x] Persistent signed proof chain and local P&L ledger
- [x] Autonomous loop, settlement handling, and calibration tooling
- [x] Remove browser, Telegram, and MCP surfaces; retain backend-only runtime
- [ ] Final testnet operational runbook and demo evidence
