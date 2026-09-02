/** In-process event bus, for the SSE stream.
 *
 *  Every panel a dashboard wants — decisions arriving, orders filling, a breaker
 *  tripping — is something this process already knows the instant it happens. Without
 *  a push channel a UI has to poll `/agent/logs`, which means it is always between
 *  0 and `interval` seconds stale, and every open tab re-reads the whole tail of the
 *  proof chain to find the one row it did not have.
 *
 *  Deliberately not an EventEmitter subclass and deliberately not persistent: this is
 *  a fan-out to whoever is currently watching. The proof chain is the durable record,
 *  and a subscriber that missed an event reads it from there. Keeping those two roles
 *  separate is what stops the stream growing into a second, unverified source of
 *  truth.                                                                          */

export type AgentEventKind =
  | 'decision'
  | 'order'
  | 'fill'
  | 'settlement'
  | 'cycle'
  | 'risk'
  | 'alert';

export interface AgentEvent {
  kind: AgentEventKind;
  ts: number;
  data: Record<string, unknown>;
}

type Listener = (event: AgentEvent) => void;

const listeners = new Set<Listener>();

/** Last few events, so a client that connects mid-cycle has immediate context
 *  instead of an empty pane until the next tick. Bounded and in-memory only. */
const buffer: AgentEvent[] = [];
const MAX_BUFFER = 50;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentEvents(limit = MAX_BUFFER): AgentEvent[] {
  return buffer.slice(-limit);
}

export function subscriberCount(): number {
  return listeners.size;
}

/** Publish an event. Never throws into the caller: these are called from the
 *  trading path, and a broken subscriber must not be able to fail a trade or, worse,
 *  interrupt the code between a fill and its ledger write. */
export function publish(kind: AgentEventKind, data: Record<string, unknown>): void {
  const event: AgentEvent = { kind, ts: Date.now(), data };
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* a dead client is not the trading loop's problem */
    }
  }
}

export function __resetEventsForTests(): void {
  listeners.clear();
  buffer.length = 0;
}
