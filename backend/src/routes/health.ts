import { Router } from 'express';
import { config } from '../config';
import { effectiveDryRun, loadAgentConfig } from '../agent-config';
import { fetchSpotMarkets } from '../services/markets';
import { loopStatus } from '../services/loop';
import { feedHealthReport, feedStaleMs, userClientCount } from '../services/sdk';
import { riskStatus } from '../services/risk';
import { clockState } from '../services/clock';
import { walletSnapshot } from '../services/wallet';
import { maxUserStake, userTradingMode } from '../services/user-trading';
import { perUserWalletsEnabled } from '../mcp/identity';
import { alertsConfigured, recentAlerts } from '../services/alerts';
import { lockInfo } from '../services/lock';
import { currentAnchor, count } from '../services/store';

export const healthRouter: Router = Router();

/** Health is the most-polled endpoint (the UI hits it on every render), and it
 *  reaches out to the DreamDEX REST API to report indexer state. Uncached, that
 *  turns a page refresh into an external request and a liveness check into a
 *  dependency on someone else's uptime. Cache the probe briefly. */
const INDEXER_PROBE_TTL_MS = 10_000;
let probe: { state: 'ok' | 'down' | 'idle'; ts: number } | undefined;

async function indexerState(): Promise<'ok' | 'down' | 'idle'> {
  if (probe && Date.now() - probe.ts < INDEXER_PROBE_TTL_MS) return probe.state;
  let state: 'ok' | 'down' | 'idle';
  try {
    const markets = await fetchSpotMarkets();
    state = markets.length > 0 ? 'ok' : 'idle';
  } catch {
    state = 'down';
  }
  probe = { state, ts: Date.now() };
  return state;
}

healthRouter.get('/health', async (_req, res) => {
  const indexer = await indexerState();
  const rules = loadAgentConfig();
  const stale = feedStaleMs();
  const risk = riskStatus(rules);
  const clock = clockState();
  // Cached (10s TTL), so the most-polled endpoint on the service does not turn every
  // page refresh into a pair of RPC calls.
  const wallet = await walletSnapshot();
  res.json({
    ok: true,
    name: 'somnus-backend',
    network: config.network,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    dryRun: effectiveDryRun(rules),
    agentMode: rules.mode,
    indexer,
    feedStaleSec: stale === undefined ? undefined : Math.round(stale / 1000),
    // Per-source, so "the agent stopped trading" can be traced to the exact input
    // that went quiet instead of guessing between oracle, candles and book.
    feeds: feedHealthReport(),
    // Whether the agent is currently allowed to trade, and if not, why.
    risk: {
      ok: risk.ok,
      paused: risk.paused,
      pauseReason: risk.pauseReason,
      blocked: risk.blocked,
      lossToday: risk.lossToday,
      consecutiveLosses: risk.consecutiveLosses,
      executionFailures: risk.executionFailures,
      // Collateral committed right now, against the ceiling. A daily loss limit
      // cannot see this: binaries only realise at settlement, so a batch placed
      // inside one interval is invisible to it until every window has resolved.
      openNotional: risk.openNotional,
      maxOpenNotional: risk.limits.maxOpenNotional,
      drawdown: risk.drawdown,
      maxDrawdown: risk.limits.maxDrawdown,
      // How old the loss data behind those breakers is. Every limit above reads the
      // P&L ledger, and only a settlement sweep writes settled outcomes into it — so
      // a stale sweep means these numbers stopped moving, which is not the same as
      // a flat day.
      settlementAgeSec:
        risk.settlementAgeMs === undefined ? undefined : Math.round(risk.settlementAgeMs / 1000),
      lastSweepError: risk.lastSweepError,
      // Age of the last order book we could actually read. Everything the agent
      // decides is derived from the book, so this being stale means blind, not
      // degraded — and it blocks trading rather than only colouring a dashboard.
      bookAgeSec: risk.bookAgeMs === undefined ? undefined : Math.round(risk.bookAgeMs / 1000),
    },
    // Expiry arithmetic is only as good as the clock behind it.
    clock: {
      skewSec: clock.skewSec,
      ok: clock.ok,
      blocking: clock.blocking,
      checkedAt: clock.checkedAt,
      error: clock.error,
    },
    wallet: {
      collateral: wallet.collateral,
      collateralCode: wallet.collateralCode,
      native: wallet.native,
      nativeCode: wallet.nativeCode,
      readAt: wallet.ts,
      error: wallet.error,
    },
    alerts: {
      // An unattended agent with no alerting is one you find out about in the
      // morning, so make the absence visible rather than implied.
      configured: alertsConfigured(),
      // Level, title and time only. The `detail` payloads carry pause reasons and
      // loss figures, and /health is deliberately unauthenticated so dashboards and
      // load balancers can poll it — that is the wrong place to publish them.
      recent: recentAlerts(5).map((a) => ({
        level: a.level,
        title: a.title,
        ts: a.ts,
        delivered: a.delivered,
      })),
    },
    instance: lockInfo(),
    loop: loopStatus(),
    // Per-user wallets: whether this deployment derives them at all, whether their
    // orders actually reach the chain, and how many signing clients are cached. The
    // last one matters because each client holds a chain WebSocket, so a leak shows
    // up here as a climbing number rather than as unexplained memory growth.
    perUserWallets: {
      enabled: perUserWalletsEnabled(),
      mode: userTradingMode(),
      maxPerTrade: maxUserStake(),
      cachedClients: userClientCount(),
    },
    proofAnchor: currentAnchor(),
    proofEntries: count(),
    ts: Date.now(),
  });
});