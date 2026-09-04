import { debug, log, warn } from '../config';
import { effectiveDryRun, loadAgentConfig } from '../agent-config';
import { isCycleInFlight, runCycle } from './agent';
import { riskStatus } from './risk';
import { feedHealthReport, probeFeeds, resetReadExchange, tickFeedHealth } from './sdk';
import { sweepSettlements } from './settlement';
import { checkClockSkew } from './clock';
import { raiseAlert } from './alerts';
import { publish } from './events';

/** How often to reconcile chain state against the ledger. Every cycle would be a
 *  portfolio read per minute for a check that only catches crash-shaped bugs. */
const RECONCILE_EVERY_CYCLES = Number(process.env.AGENT_RECONCILE_EVERY_CYCLES ?? 30);

/** The autonomous loop — the thing that makes "awake while you sleep" true.
 *
 *  `intervalMs` was previously stored, clamped and displayed while nothing
 *  consumed it, so the agent only ever acted when a human POSTed /agent/run.
 *
 *  Design notes:
 *  - Cycles never overlap. A cycle reads a dozen order books and can outlast a
 *    short interval; re-entering would double-spend the position budget because
 *    the open-position gate counts only what is already logged.
 *  - The interval is re-read every tick, so changing it in Agent Studio takes
 *    effect without a restart.
 *  - A thrown cycle is logged and the loop continues. One bad indexer read must
 *    not silently stop an agent the operator believes is running.             */

export interface LoopStatus {
  running: boolean;
  /** True while a cycle is mid-flight. */
  busy: boolean;
  intervalMs: number;
  cycles: number;
  errors: number;
  /** Trades still authorised; null = unlimited. */
  tradesRemaining: number | null;
  lastRunAt?: number;
  lastError?: string;
  lastSummary?: string;
  startedAt?: number;
}

let timer: NodeJS.Timeout | undefined;
let running = false;
let busy = false;
let cycles = 0;
let errors = 0;
let lastRunAt: number | undefined;
let lastError: string | undefined;
let lastSummary: string | undefined;
let startedAt: number | undefined;

export function loopStatus(): LoopStatus {
  const rules = loadAgentConfig();
  return {
    running,
    busy,
    intervalMs: rules.intervalMs,
    cycles,
    errors,
    tradesRemaining: rules.tradeQuota,
    lastRunAt,
    lastError,
    lastSummary,
    startedAt,
  };
}

/** Hard ceiling on one cycle. A cycle reads a dozen books over the network; if
 *  one call wedges, `busy` would stay true forever and the loop would sit dead
 *  while still reporting running:true — the worst failure mode for something you
 *  left unattended. Time it out, log it, carry on.                            */
const CYCLE_TIMEOUT_MS = 300_000;

/** How long a transient block may persist before the alert turns critical. A blip
 *  is a warning; half an hour blind is an incident. */
const WAIT_ESCALATE_MS = Number(process.env.AGENT_WAIT_ESCALATE_MS ?? 1_800_000);

/** When the current run of transient blocks began, so the alert can say how long
 *  the agent has actually been unable to trade. */
let waitingSince: number | undefined;

/** Incremented on every start/stop. A tick that finishes after the loop was
 *  stopped-and-restarted belongs to the old generation and must not schedule:
 *  otherwise its `finally` and the new `startLoop` each arm a timer and the loop
 *  runs at double rate, quietly doubling the trade frequency. */
let generation = 0;

async function tick(gen: number): Promise<void> {
  if (!running || busy || gen !== generation) return; // never overlap
  busy = true;
  try {
    // Realise settled outcomes BEFORE reading the breakers. The loss limits are
    // computed from the P&L ledger, and only a sweep writes settled positions into
    // it — checking the breakers first would grade the session on everything except
    // what just happened. This is also what keeps those limits honest when claiming
    // is broken or switched off: settlement determines P&L, redemption only moves
    // the collateral.
    const sweep = await sweepSettlements();
    if (sweep.realized > 0) {
      publish('settlement', { realized: sweep.realized, winners: sweep.winners, losers: sweep.losers, pnl: sweep.pnl });
    }
    // Expiry arithmetic is only as good as the clock behind it, and a drifting host
    // clock makes every "seconds left" decision wrong without ever erroring.
    await checkClockSkew();

    // A tripped circuit breaker should stop the loop, not be rediscovered by
    // every cycle. Without this the agent keeps waking up, reads a dozen books
    // and logs a rejection per market — burning indexer calls to learn something
    // it already knows, and looking busy while doing nothing.
    //
    // But only for conditions a human has to clear. Stopping for a dead book feed
    // or host clock drift turned a ten-minute indexer blip into an agent that was
    // off until somebody noticed — and the books really did fail for twenty hours
    // on 2026-09-02 while every other feed stayed green. Those are waited out
    // below, with an active attempt to heal, because a scheduler that skips the
    // cycle also skips the read whose staleness caused the skip.
    const risk = riskStatus();
    if (risk.halting.length > 0) {
      lastError = risk.halting.join('; ');
      lastSummary = `halted by risk controls: ${lastError}`;
      warn(`loop halted — ${lastError}`);
      publish('risk', { halted: true, blocked: risk.halting });
      raiseAlert({
        level: 'critical',
        key: 'loop-halted',
        title: `agent loop HALTED — ${lastError}`,
        detail: { blocked: risk.halting, cycles, lastRunAt },
      });
      stopLoop();
      return;
    }
    if (risk.waiting.length > 0) {
      waitingSince ??= Date.now();
      const waitedMs = Date.now() - waitingSince;
      lastError = risk.waiting.join('; ');
      lastSummary = `waiting ${Math.round(waitedMs / 1000)}s for: ${lastError}`;
      warn(`loop waiting — ${lastSummary}`);
      publish('risk', { waiting: risk.waiting, waitedMs });
      // Escalate once the wait stops looking like a blip. A separate key so the
      // 15-minute dedupe cannot swallow the louder message.
      const long = waitedMs > WAIT_ESCALATE_MS;
      raiseAlert({
        level: long ? 'critical' : 'warning',
        key: long ? 'loop-waiting-long' : 'loop-waiting',
        title: long
          ? `agent loop has been unable to trade for ${Math.round(waitedMs / 60_000)}m — ${lastError}`
          : `agent loop waiting on transient conditions — ${lastError}`,
        detail: { waiting: risk.waiting, waitedMs, cycles },
      });
      // Try to heal rather than just re-checking. A dead chain socket does not
      // recover on its own, and the aggregate feed timer cannot see a book-only
      // outage because spot and candles keep it looking fresh.
      if (risk.blocks.some((b) => b.code === 'book-stale')) resetReadExchange();
      const probe = await probeFeeds();
      if (!probe.ok) debug('loop: recovery probe still failing:', probe.error);
      return;
    }
    // Cleared — forget the wait so the next one measures from its own start.
    waitingSince = undefined;
    // Heal a silently-dead price-feed socket before the cycle runs, so a blind
    // agent rebuilds its own feed instead of quietly trading on stale/empty spot.
    tickFeedHealth();

    // A blind agent is worse than a stopped one. The freshness gate will refuse
    // every execution anyway, so say why instead of logging silent inaction.
    const feeds = feedHealthReport();
    if (feeds.sources.length > 0 && feeds.sources.every((s) => !s.ok)) {
      raiseAlert({
        level: 'critical',
        key: 'feeds-all-down',
        title: 'every market-data feed is failing — the agent is trading blind',
        detail: { sources: feeds.sources.map((s) => ({ source: s.source, error: s.error })) },
      });
    }

    const out = await withTimeout(runCycle(), CYCLE_TIMEOUT_MS);
    cycles++;
    lastRunAt = Date.now();
    lastSummary =
      `${out.decisions.length} decisions, ${out.orders.length} orders, ${out.errors.length} errors`;
    if (out.errors.length > 0) lastError = out.errors[0];
    log(`loop cycle ${cycles}: ${lastSummary}`);
    publish('cycle', {
      cycle: cycles,
      decisions: out.decisions.length,
      orders: out.orders.length,
      errors: out.errors,
    });

    // Periodic reconciliation: a fill whose ledger write was lost is invisible to
    // every limit, and the only way to find it is to ask the chain what we hold.
    if (cycles % RECONCILE_EVERY_CYCLES === 0) {
      const { reconcile } = await import('./reconcile');
      const report = await reconcile();
      if (!report.ok) warn(`reconcile: ${report.summary}`);
    }

    // Auto-claim: if any 5m/15m winners just settled, redeem them right away
    // so the collateral comes back. P&L no longer depends on this succeeding —
    // the sweep above already recorded the outcome — so a claim failure costs
    // custody, not correctness.
    void (async () => {
      try {
        const rules2 = loadAgentConfig();
        if (rules2.claimEnabled && !effectiveDryRun(rules2)) {
          const { claimAll } = await import('./settlement');
          const r = await claimAll();
          if (r.claimed.length > 0) log(`auto-claimed ${r.claimed.length} winner(s) ${r.txHash ?? ''}`);
        }
      } catch (err) {
        // Custody, not correctness: the sweep above already recorded the P&L. Still
        // say something — a claim that silently never works leaves winnings sitting
        // as outcome tokens and nothing to explain why.
        debug('auto-claim failed:', (err as Error).message ?? String(err));
      }
    })();

    // "Do exactly N trades" should finish by itself. Leaving the loop spinning
    // after the quota is spent means every later cycle logs nothing but quota
    // rejections, which looks like a malfunction.
    const remaining = loadAgentConfig().tradeQuota;
    if (remaining !== null && remaining <= 0) {
      log('trade quota reached — stopping the loop');
      stopLoop();
      return;
    }
  } catch (err) {
    errors++;
    lastError = (err as Error).message ?? String(err);
    warn('loop cycle failed:', lastError);
  } finally {
    busy = false;
    if (gen === generation) schedule(); // chain from completion, not a fixed clock
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`cycle exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Schedule the next tick relative to when the last one FINISHED, so a slow
 *  cycle can't queue a backlog of overdue runs. */
function schedule(): void {
  if (!running) return;
  if (timer) clearTimeout(timer);
  const { intervalMs } = loadAgentConfig();
  const gen = generation;
  timer = setTimeout(() => void tick(gen), intervalMs);
}

export function startLoop(): LoopStatus {
  if (running) return loopStatus();
  const rules = loadAgentConfig();
  generation++;
  running = true;
  startedAt = Date.now();
  const mode = effectiveDryRun(rules) ? 'DRY_RUN' : 'LIVE — real orders';
  log(`agent loop started: every ${rules.intervalMs}ms, ${mode}`);
  if (!effectiveDryRun(rules)) {
    warn(`agent loop is LIVE: it will place real orders every ${rules.intervalMs}ms`);
  }
  schedule();
  return loopStatus();
}

export function stopLoop(): LoopStatus {
  generation++;
  running = false;
  // A fresh start should measure its own wait, not inherit the last one's.
  waitingSince = undefined;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  log('agent loop stopped');
  return loopStatus();
}

/** Wait for an in-flight cycle to finish.
 *
 *  Shutdown used to be `stopLoop(); process.exit(0)`, which cancels the next tick and
 *  then kills the process wherever the current one happens to be. If that was
 *  between a live order landing on-chain and its ledger write, the position exists
 *  and nothing local knows about it — the exact drift `reconcile()` was written to
 *  detect. Better to spend a few seconds waiting than to create work for the
 *  reconciler on every deploy.
 *
 *  Bounded: a wedged cycle must not turn a restart into a hang. `CYCLE_TIMEOUT_MS`
 *  already caps a cycle, and this caps the wait. */
export async function waitForIdle(timeoutMs = 30_000): Promise<boolean> {
  // BOTH guards, not just the loop's. A manual POST /agent/run runs under agent.ts's
  // own in-flight guard and never sets `busy`, so watching only `busy` meant shutdown
  // walked straight through a manual cycle — the one case this was written for.
  const inFlight = (): boolean => busy || isCycleInFlight();
  const deadline = Date.now() + timeoutMs;
  while (inFlight() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (inFlight()) warn(`shutdown: cycle still in flight after ${timeoutMs}ms — exiting anyway`);
  return !inFlight();
}

/** Opt-in autostart. Defaults OFF: a process that starts trading the moment it
 *  boots is the wrong default for something holding a key. */
export function maybeAutostart(): void {
  const raw = (process.env.AGENT_AUTOSTART ?? '').toLowerCase();
  if (raw === 'true' || raw === '1') {
    log('AGENT_AUTOSTART set — starting agent loop');
    startLoop();
  }
}

export const __loopInternals = { tick, currentGeneration: () => generation };
