import { Router } from 'express';
import { config } from '../config';
import { effectiveDryRun, loadAgentConfig } from '../agent-config';
import { fetchSpotMarkets } from '../services/markets';
import { loopStatus } from '../services/loop';
import { feedHealthReport, feedStaleMs } from '../services/sdk';
import { riskStatus } from '../services/risk';
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
    },
    loop: loopStatus(),
    proofAnchor: currentAnchor(),
    proofEntries: count(),
    ts: Date.now(),
  });
});