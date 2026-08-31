import { useEffect, useState } from 'react';
import { getAgentConfig, putAgentConfig } from '../api';
import type { AgentConfigDoc } from '../types';

export default function AgentForm({ onChanged }: { onChanged?: () => void }) {
  const [cfg, setCfg] = useState<AgentConfigDoc | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>('');

  useEffect(() => {
    getAgentConfig()
      .then((r) => setCfg(r.config))
      .catch((e: Error) => setMsg(e.message));
  }, []);

  if (!cfg) {
    return <div className="card p-5 text-sm text-muted">{msg || 'Loading config…'}</div>;
  }

  const set = (patch: Partial<AgentConfigDoc>) => setCfg((c) => (c ? { ...c, ...patch } : c));

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const r = await putAgentConfig(cfg);
      setCfg(r.config);
      setMsg('Saved ✓');
      onChanged?.();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-heading">Governing rules</h2>
      <p className="mt-1 text-xs text-muted">
        Enforced server-side by the broker — not just in the UI. DRY_RUN stays on until you flip it.
      </p>

      <div className="mt-4 grid gap-3">
        <label className="block text-xs text-muted">
          Symbols (comma-separated, e.g. BTC,ETH)
          <input
            className="mt-1 w-full rounded-lg bg-raised px-3 py-2 text-sm text-body outline-none focus:ring-1 focus:ring-line-strong"
            value={cfg.symbols.join(',')}
            onChange={(e) =>
              set({ symbols: e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) })
            }
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-xs text-muted">
            Max size ($)
            <input
              type="number"
              className="mt-1 w-full rounded-lg bg-raised px-3 py-2 text-sm text-body outline-none focus:ring-1 focus:ring-line-strong"
              value={cfg.maxTradeSize}
              onChange={(e) => set({ maxTradeSize: Number(e.target.value) })}
            />
          </label>
          <label className="block text-xs text-muted">
            Max open
            <input
              type="number"
              className="mt-1 w-full rounded-lg bg-raised px-3 py-2 text-sm text-body outline-none focus:ring-1 focus:ring-line-strong"
              value={cfg.maxOpenPositions}
              onChange={(e) => set({ maxOpenPositions: Number(e.target.value) })}
            />
          </label>
          <label className="block text-xs text-muted">
            Min edge
            <input
              type="number"
              step="0.01"
              className="mt-1 w-full rounded-lg bg-raised px-3 py-2 text-sm text-body outline-none focus:ring-1 focus:ring-line-strong"
              value={cfg.minEdge}
              onChange={(e) => set({ minEdge: Number(e.target.value) })}
            />
          </label>
        </div>

        <label className="block text-xs text-muted">
          Mode
          <select
            className="mt-1 w-full rounded-lg bg-raised px-3 py-2 text-sm text-body outline-none focus:ring-1 focus:ring-line-strong"
            value={cfg.mode}
            onChange={(e) => set({ mode: e.target.value as AgentConfigDoc['mode'] })}
          >
            <option value="dry-run">dry-run (safe)</option>
            <option value="view">view</option>
            <option value="live">live (needs key + MODE)</option>
          </select>
        </label>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <button onClick={() => void save()} disabled={saving} className="btn-cta disabled:opacity-50">
          {saving ? 'Saving…' : 'Save limits'}
        </button>
        <span className="mono text-xs text-subtle">{msg}</span>
      </div>
    </div>
  );
}