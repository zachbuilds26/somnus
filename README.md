# Somnus 🌙

**Governed, auditable AI trading agent for DreamDEX Event Contracts on Somnia.**

Somnus is the Somnia-native prediction-market copilot: it researches live Event
Contract books, decides *rationally*, trades *within written limits you set*, and
leaves **machine-readable proof** of every action.

Built for the **Somnia × DreamDEX Event Contracts Hackathon** (Aug 25 – Sep 8).
Backend-first architecture; testnet-first development.

## Repo layout
```
somnus/
├── PLAN.md              # the full build plan (read this first)
├── docs/
│   └── DESIGN_SYSTEM.md # Somnia brand tokens for the UIs
├── backend/             # Node 20+ / TS API + agent runtime  (BUILDING NOW)
└── web/                 # Vite + React landing page + app  (after backend)
```

## Run the backend (dev)
```bash
cd backend
npm install
cp ../.env.example .env   # keep NETWORK=testnet, DRY_RUN=true
npm run dev               # http://localhost:4545 (see .env)
```

## Status
- [x] Phase 0 — scaffold, config, live testnet connectivity verified
- [x] Phase 1 — market data service (REST spot markets, live Event Contract books via SDK)
- [x] Phase 2 — agent brain + governed broker (DRY_RUN by default; live submit gated behind `mode=live` + key)
- [x] Phase 3 — proof/audit trail + full API surface — hash chain **persisted** to `backend/data/proof-chain.jsonl`, restored on boot, `/proof/verify` re-verifies
- [x] Phase 3.5 — SDK layer actually works: **keyless** Event Contract reads on the
      GraphQL indexer, `markets-sdk >= 0.28.1`, retry + short cache over flaky reads,
      and the saved rules in `backend/data/agent-config.json` are what the broker
      enforces (limits set in the UI are no longer cosmetic)
- [_] Phase 4 — live testnet orders via session key (needs a key in `backend/.env`;
      see the open question on Down-leg inventory in `backend/README.md`)
- [_] Phase 5 — frontend: landing + app render live data and typecheck clean;
      still on default system fonts rather than the intended display type
- [_] Phase 6 — hardening, demo video, submission

Verified live on testnet (chain 50312): 3 spot markets, 8 active Event Contract
windows across BTC/ETH, real books (e.g. `bid 0.836 / ask 0.86`), a 12-decision
agent cycle, and a 78-entry proof chain that re-verifies.

See `backend/README.md` and `PLAN.md` for details.