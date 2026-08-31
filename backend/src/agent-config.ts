import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, DATA_DIR } from './config';
import type { AgentConfigDoc } from './types';

/** The agent's governing rules — the single source of truth for every limit
 *  check. Env vars seed the defaults; whatever the operator saves in Agent
 *  Studio is persisted here and takes precedence.
 *
 *  This lives outside routes/ deliberately: the broker and the agent loop must
 *  read the SAME document the UI writes. Reading `config.agent` (env) directly
 *  in the enforcement path means a user's written limits are displayed but
 *  never enforced — exactly the failure this product claims to prevent.     */

const CONFIG_FILE = join(DATA_DIR, 'agent-config.json');

const PRESET_TO_EDGE: Record<string, number> = {
  'very-sure': 0.07,
  middle: 0.05,
  'a-bit-sure': 0.03,
};
// Deprecated: presets kept for compat but agent now auto-hunts edge without asking.
// minEdge alone drives the gate; loop stays on until signal found.

export function defaultAgentConfig(): AgentConfigDoc {
  // Simple trader mental model: "$ per bet" + "how much can I lose today" + "how sure".
  // Advanced gates (per-market, per-cycle caps, execution failures, data age) still
  // exist but are hidden behind Advanced — sensible defaults so a newbie never sees them.
  // tradeQuota is DEPRECATED: it meant "total trades ever" and at 1 blocked after one
  // fill forever. Kept for compat but always null (unlimited) unless explicitly set.
  return {
    ...config.agent,
    claimEnabled: true,
    maxOrdersPerCycle: Number(process.env.AGENT_MAX_ORDERS_PER_CYCLE ?? 0),
    maxPerMarket: Number(process.env.AGENT_MAX_PER_MARKET ?? 1),
    tradeQuota: null,
    // $1000 cap: user can lose up to $1000/day then pauses; $1000 per trade max.
    // Re-enables breaker that was 0 (unlimited). Tighten via env if needed.
    maxDailyLoss: Number(process.env.AGENT_MAX_DAILY_LOSS ?? 1000),
    maxConsecutiveLosses: Number(process.env.AGENT_MAX_CONSECUTIVE_LOSSES ?? 10),
    maxExecutionFailures: Number(process.env.AGENT_MAX_EXECUTION_FAILURES ?? 5),
    maxDataAgeMs: Number(process.env.AGENT_MAX_DATA_AGE_MS ?? 15_000),
    tradingPaused: false,
    edgePreset: 'middle',
  };
}

export function loadAgentConfig(): AgentConfigDoc {
  if (existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<AgentConfigDoc>;
      return sanitize({ ...defaultAgentConfig(), ...saved });
    } catch {
      /* corrupt file → fall back to env defaults rather than trading unbounded */
    }
  }
  return defaultAgentConfig();
}

export function saveAgentConfig(doc: AgentConfigDoc): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(sanitize(doc), null, 2), 'utf8');
}

/** Clamp anything that could widen the risk envelope past a sane bound, so a
 *  bad PUT (or a hand-edited file) can't hand the agent an unlimited mandate.
 *
 *  Also WHITELISTS the known fields. Spreading caller input let a PUT of `[1,2,3]`
 *  persist keys "0","1","2" into the config file and into the proof chain — junk
 *  that survives restarts and pollutes the audit record. Build a clean document
 *  instead of filtering a dirty one. */
export function sanitize(doc: AgentConfigDoc): AgentConfigDoc {
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };
  const d = defaultAgentConfig();
  const quota =
    doc?.tradeQuota === null || doc?.tradeQuota === undefined
      ? doc && 'tradeQuota' in doc
        ? null
        : d.tradeQuota
      : Math.max(0, Math.floor(num(doc.tradeQuota, 0, 0, 1_000_000)));
  // A data-age limit of 0 means "don't check". Anything else is floored at one
  // second: a sub-second freshness bar would reject every real read (an oracle
  // round-trip alone takes longer than that) and silently stop the agent trading.
  const rawAge = Math.floor(num(doc?.maxDataAgeMs, d.maxDataAgeMs, 0, 3_600_000));
  const paused = Boolean(doc?.tradingPaused);
  const reason = typeof doc?.pauseReason === 'string' ? doc.pauseReason.trim().slice(0, 300) : '';
  const pausedAt = Number(doc?.pausedAt);
  const presetRaw = typeof doc?.edgePreset === 'string' ? doc.edgePreset.toLowerCase().trim() : '';
  const preset = presetRaw === 'very-sure' || presetRaw === 'middle' || presetRaw === 'a-bit-sure' ? (presetRaw as AgentConfigDoc['edgePreset']) : d.edgePreset;
  // Simple choice for newbies — preset overrides the raw number so
  // "very sure / middle / a bit sure" is the only thing they need to pick.
  const edgeFromPreset = preset ? PRESET_TO_EDGE[preset] ?? d.minEdge : d.minEdge;
  const requestedEdge = doc && 'minEdge' in doc ? num(doc?.minEdge, edgeFromPreset, 0, 1) : edgeFromPreset;
  // If they sent a preset, it wins unless they also sent an explicit minEdge that differs from the preset — then respect the number.
  const finalEdge = doc && 'edgePreset' in doc && preset ? (doc && 'minEdge' in doc && Number(doc.minEdge) !== PRESET_TO_EDGE[preset] ? requestedEdge : edgeFromPreset) : requestedEdge;
  return {
    maxTradeSize: num(doc?.maxTradeSize, d.maxTradeSize, 0, 10_000),
    maxOpenPositions: num(doc?.maxOpenPositions, d.maxOpenPositions, 0, 100),
    minEdge: finalEdge,
    edgePreset: preset,
    intervalMs: num(doc?.intervalMs, d.intervalMs, 5_000, 3_600_000),
    maxOrdersPerCycle: Math.floor(num(doc?.maxOrdersPerCycle, d.maxOrdersPerCycle, 0, 100)),
    maxPerMarket: Math.floor(num(doc?.maxPerMarket, d.maxPerMarket, 0, 100)),
    tradeQuota: quota,
    maxDailyLoss: num(doc?.maxDailyLoss, d.maxDailyLoss, 0, 1_000_000),
    maxConsecutiveLosses: Math.floor(num(doc?.maxConsecutiveLosses, d.maxConsecutiveLosses, 0, 100)),
    maxExecutionFailures: Math.floor(num(doc?.maxExecutionFailures, d.maxExecutionFailures, 0, 100)),
    maxDataAgeMs: rawAge === 0 ? 0 : Math.max(1_000, rawAge),
    tradingPaused: paused,
    // Pause metadata only exists while paused. Clearing the switch clears the
    // explanation with it, so a resumed agent can't display a stale reason — and
    // a caller can't smuggle a fake pause reason onto a running agent.
    ...(paused
      ? {
          pauseReason: reason || 'paused (no reason recorded)',
          ...(Number.isFinite(pausedAt) && pausedAt > 0 ? { pausedAt } : { pausedAt: Date.now() }),
        }
      : {}),
    symbols: Array.isArray(doc?.symbols)
      ? doc.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
      : d.symbols,
    mode: doc?.mode === 'live' || doc?.mode === 'view' ? doc.mode : 'dry-run',
    claimEnabled: Boolean(doc?.claimEnabled),
  };
}

/** Spend one unit of the trade quota, persisting immediately.
 *
 *  Written through on every accepted order rather than at the end of a cycle: a
 *  crash or restart mid-cycle must not hand back trades the operator already
 *  authorised away. Returns the remaining quota (null = unlimited).           */
export function consumeTradeQuota(): number | null {
  const doc = loadAgentConfig();
  if (doc.tradeQuota === null) return null;
  const next = Math.max(0, doc.tradeQuota - 1);
  saveAgentConfig({ ...doc, tradeQuota: next });
  return next;
}

/** DRY_RUN is a floor, not a preference: env can force it on globally, and the
 *  agent must also be explicitly in `live` mode before anything is sent.     */
export function effectiveDryRun(doc: AgentConfigDoc = loadAgentConfig()): boolean {
  return config.dryRun || doc.mode !== 'live';
}
