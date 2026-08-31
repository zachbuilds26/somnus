import type { Decision } from '../types';

// A trade the bot found but is waiting for your Yes/No.
export interface PendingTrade {
  id: string;
  decision: Decision;
  cost: number;
  payoutIfWin: number;
  price: number;
  size: number;
  symbol: string;
  fair: number;
  mid: number;
  ask: number;
  bid: number;
  edge: number;
  requiredEdge: number;
  horizon?: string;
  createdAt: number;
  preset?: string;
}

const pending = new Map<string, PendingTrade>();

const notifiers: Array<(p: PendingTrade) => void> = [];
export function setPendingNotifier(fn: (p: PendingTrade) => void): void {
  notifiers.push(fn);
}

export function addPending(p: PendingTrade): void {
  pending.set(p.id, p);
  for (const fn of notifiers) try { fn(p); } catch {}
  // auto-expire after 90s — window will be stale anyway
  setTimeout(() => pending.delete(p.id), 90_000).unref?.();
}

export function getPending(id: string): PendingTrade | undefined {
  return pending.get(id);
}

export function popPending(id: string): PendingTrade | undefined {
  const p = pending.get(id);
  if (p) pending.delete(id);
  return p;
}

export function listPending(): PendingTrade[] {
  return [...pending.values()];
}

export function clearPending(): void {
  pending.clear();
}
