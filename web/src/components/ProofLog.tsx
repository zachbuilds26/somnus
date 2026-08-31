import { useEffect, useState } from 'react';
import { getProof, verifyProof } from '../api';
import type { ProofEntry } from '../types';

export default function ProofLog() {
  const [entries, setEntries] = useState<ProofEntry[]>([]);
  const [anchor, setAnchor] = useState('');
  const [total, setTotal] = useState(0);
  const [verify, setVerify] = useState('');

  const refresh = async () => {
    try {
      const r = await getProof(15);
      setEntries(r.entries);
      setAnchor(r.anchor);
      setTotal(r.total);
      setVerify('');
    } catch (e) {
      setVerify((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const doVerify = async () => {
    setVerify('verifying…');
    try {
      const r = await verifyProof();
      setVerify(`verified ${r.checked}/${r.total} — ok ${r.ok}`);
    } catch (e) {
      setVerify((e as Error).message);
    }
  };

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-heading">Proof / Activity log</h2>
        <button onClick={() => void doVerify()} className="btn-ghost text-xs">
          Verify chain
        </button>
      </div>

      <div className="mono mt-2 text-xs text-subtle">
        {verify || `${total} entries · anchor ${anchor.slice(0, 12)}…`}
      </div>

      <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto">
        {entries.map((e) => (
          <div key={e.id} className="rounded-lg bg-raised px-3 py-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="mono text-heading">{e.kind}</span>
              <span className="mono text-subtle">{new Date(e.ts).toISOString().slice(11, 19)}</span>
            </div>
            <div className="mono mt-1 truncate text-subtle" title={e.payloadHash}>
              {e.payloadHash.slice(0, 40)}
            </div>
          </div>
        ))}
        {entries.length === 0 && <div className="text-sm text-muted">No proof entries yet.</div>}
      </div>
    </div>
  );
}