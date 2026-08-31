import { useEffect, useState } from 'react';
import { getBinaryMarkets, getBook } from '../api';
import type { BookTicker, NormalizedMarket } from '../types';

export default function MarketBoard() {
  const [markets, setMarkets] = useState<NormalizedMarket[]>([]);
  const [books, setBooks] = useState<Record<string, BookTicker>>({});
  const [state, setState] = useState<'loading' | 'ok' | 'down'>('loading');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await getBinaryMarkets();
        if (!alive) return;
        const slice = res.markets.slice(0, 8);
        setMarkets(slice);
        setState('ok');
        for (const m of slice) {
          getBook(m.symbol)
            .then((b) => {
              if (alive) setBooks((prev) => ({ ...prev, [m.symbol]: b.book }));
            })
            .catch(() => {});
        }
      } catch {
        if (alive) setState('down');
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-heading">Event Contract windows</h2>
        <span className="mono text-xs text-subtle">Up probabilities</span>
      </div>

      {state === 'down' && (
        <p className="mt-4 text-sm text-muted">
          Couldn't reach the Event Contract indexer. Reads need no wallet key — check that the
          backend is running and online.
        </p>
      )}
      {state === 'loading' && <div className="mt-4 h-20 animate-pulse rounded-lg bg-raised" />}
      {state === 'ok' && markets.length === 0 && (
        <div className="mt-4 text-sm text-muted">No binary windows returned.</div>
      )}

      <div className="mt-4 space-y-2">
        {markets.map((m) => {
          const b = books[m.symbol];
          const mid = b?.mid;
          return (
            <div
              key={m.symbol}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-raised px-3 py-2"
            >
              <span className="mono text-xs text-body">{m.symbol}</span>
              <span className="mono text-xs text-subtle">
                {b ? `bid ${b.bid?.toFixed(4) ?? '—'} · ask ${b.ask?.toFixed(4) ?? '—'}` : '—'}
              </span>
              <span className="mono text-xs text-muted">
                {typeof mid === 'number' ? `mid ${mid.toFixed(4)}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}