import { debug, warn } from '../config';
import { describeNetworkError, fetchWithTimeout } from '../http';

/** Outbound alerts — the missing half of "runs while you sleep".
 *
 *  Every breaker in this codebase pauses correctly and writes a warning to a log
 *  file, and then nothing happens. An agent that halted at 03:00 is indistinguishable
 *  from one that traded all night until somebody opens a terminal. A halt you find
 *  out about eight hours later has already cost you the eight hours.
 *
 *  Deliberately minimal: one env var, one POST, no dependency, no queue. Anything
 *  that accepts a JSON webhook works (Slack, Discord, ntfy, a Lambda). Failures are
 *  logged and swallowed — an unreachable webhook must never take down a trading
 *  loop, because "the alarm is broken" is not a reason to stop trading safely.   */

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || undefined;
const TIMEOUT_MS = Number(process.env.ALERT_TIMEOUT_MS ?? 5_000);

/** Suppress a repeat of the SAME alert inside this window.
 *
 *  A tripped breaker is re-evaluated every cycle, and a feed blackout re-detected
 *  every tick. Without dedupe a single incident becomes a message a minute, which
 *  trains you to mute the channel — and a muted channel is worse than no channel,
 *  because you believe you are covered. */
const DEDUPE_MS = Number(process.env.ALERT_DEDUPE_MS ?? 900_000);

export type AlertLevel = 'info' | 'warning' | 'critical';

export interface Alert {
  level: AlertLevel;
  /** Stable key for deduping — the incident, not the wording. */
  key: string;
  title: string;
  detail?: Record<string, unknown>;
}

const lastSent = new Map<string, number>();
/** Every alert raised this process, newest last. Surfaced on /health so the
 *  operator can see what WOULD have been sent when no webhook is configured. */
const recent: Array<Alert & { ts: number; delivered: boolean }> = [];
const MAX_RECENT = 50;

export function alertsConfigured(): boolean {
  return WEBHOOK_URL !== undefined;
}

export function recentAlerts(limit = 20): Array<Alert & { ts: number; delivered: boolean }> {
  return recent.slice(-limit).reverse();
}

/** Raise an alert. Fire-and-forget by design: callers are risk paths that must not
 *  await a third-party HTTP round-trip before halting. */
export function raiseAlert(alert: Alert): void {
  const now = Date.now();
  const previous = lastSent.get(alert.key);
  if (previous !== undefined && now - previous < DEDUPE_MS) {
    debug(`alert suppressed (deduped ${Math.round((now - previous) / 1000)}s): ${alert.key}`);
    return;
  }
  lastSent.set(alert.key, now);

  const record = { ...alert, ts: now, delivered: false };
  recent.push(record);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);

  // Always log it, whether or not a webhook exists. An alert that only ever went
  // to an unconfigured webhook left no trace at all.
  warn(`ALERT [${alert.level}] ${alert.title}`);

  if (!WEBHOOK_URL) return;
  void deliver(WEBHOOK_URL, record);
}

async function deliver(url: string, record: Alert & { ts: number; delivered: boolean }): Promise<void> {
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` duplicates the title so Slack-shaped and generic consumers both
        // render something useful without per-provider formatting logic here.
        body: JSON.stringify({
          text: `[somnus:${record.level}] ${record.title}`,
          level: record.level,
          key: record.key,
          title: record.title,
          detail: record.detail,
          ts: record.ts,
        }),
      },
      TIMEOUT_MS,
    );
    record.delivered = res.ok;
    if (!res.ok) warn(`alert webhook returned ${res.status}`);
  } catch (err) {
    warn('alert webhook failed:', describeNetworkError(err));
  }
}

/** Drop dedupe state. For tests. */
export function __resetAlertsForTests(): void {
  lastSent.clear();
  recent.length = 0;
}
