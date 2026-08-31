import { log, warn } from '../config';
import { effectiveDryRun, loadAgentConfig } from '../agent-config';
import { runCycle } from './agent';
import { riskStatus } from './risk';
import { tickFeedHealth } from './sdk';

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

/** Incremented on every start/stop. A tick that finishes after the loop was
 *  stopped-and-restarted belongs to the old generation and must not schedule:
 *  otherwise its `finally` and the new `startLoop` each arm a timer and the loop
 *  runs at double rate, quietly doubling the trade frequency. */
let generation = 0;

async function tick(gen: number): Promise<void> {
  if (!running || busy || gen !== generation) return; // never overlap
  busy = true;
  try {
    // A tripped circuit breaker should stop the loop, not be rediscovered by
    // every cycle. Without this the agent keeps waking up, reads a dozen books
    // and logs a rejection per market — burning indexer calls to learn something
    // it already knows, and looking busy while doing nothing.
    const risk = riskStatus();
    if (!risk.ok) {
      lastError = risk.blocked.join('; ');
      lastSummary = `halted by risk controls: ${lastError}`;
      warn(`loop halted — ${lastError}`);
      stopLoop();
      return;
    }
    // Heal a silently-dead price-feed socket before the cycle runs, so a blind
    // agent rebuilds its own feed instead of quietly trading on stale/empty spot.
    tickFeedHealth();
    const out = await withTimeout(runCycle(), CYCLE_TIMEOUT_MS);
    cycles++;
    lastRunAt = Date.now();
    lastSummary =
      `${out.decisions.length} decisions, ${out.orders.length} orders, ${out.errors.length} errors`;
    if (out.errors.length > 0) lastError = out.errors[0];
    log(`loop cycle ${cycles}: ${lastSummary}`);

    // Auto-claim: if any 5m/15m winners just settled, redeem them right away
    // so pnl winRate updates by itself — no manual /claim click needed.
    void (async () => {
      try {
        const rules2 = loadAgentConfig();
        if (rules2.claimEnabled && !effectiveDryRun(rules2)) {
          const { claimAll } = await import('./settlement');
          const r = await claimAll();
          if (r.claimed.length > 0) log(`auto-claimed ${r.claimed.length} winner(s) ${r.txHash ?? ''}`);
        }
      } catch {}
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
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  log('agent loop stopped');
  return loopStatus();
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
