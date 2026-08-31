import { useCallback, useEffect, useState } from 'react';
import { runAgent, getHealth } from '../api';
import AgentForm from './AgentForm';
import MarketBoard from './MarketBoard';
import ProofLog from './ProofLog';
import type { HealthResponse } from '../types';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      removeListener: (event: string, cb: (...args: unknown[]) => void) => void;
    };
  }
}

export default function Studio() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setHealth(await getHealth());
    } catch {
      /* backend offline */
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Check if already connected
    if (window.ethereum) {
      window.ethereum.request({ method: 'eth_accounts' }).then((accounts) => {
        const arr = accounts as string[];
        if (arr.length > 0) setAccount(arr[0] ?? null);
      }).catch(() => {});
    }
  }, [refresh]);

  // Listen for account changes
  useEffect(() => {
    if (!window.ethereum) return;
    const handleAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      setAccount(accounts.length > 0 ? (accounts[0] ?? null) : null);
    };
    window.ethereum.on('accountsChanged', handleAccounts);
    return () => { window.ethereum?.removeListener('accountsChanged', handleAccounts); };
  }, []);

  const connectWallet = async () => {
    if (!window.ethereum) {
      alert('Please install MetaMask to connect your wallet.');
      return;
    }
    setConnecting(true);
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[];
      if (accounts.length > 0) setAccount(accounts[0] ?? null);
    } catch (err) {
      console.error('Connection rejected:', err);
    } finally {
      setConnecting(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setLastRun('running…');
    try {
      const res = await runAgent();
      setLastRun(
        `${res.decisions.length} decisions · ${res.orders.length} orders · ${res.errors.length} errors`,
      );
      await refresh();
    } catch (e) {
      setLastRun((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  // Wallet not connected — show connect screen
  if (!account) {
    return (
      <main className="mx-auto max-w-screen-xl px-4 py-20 flex flex-col items-center justify-center" style={{ minHeight: 'calc(100dvh - 4rem)' }}>
        <div className="card p-8 sm:p-12 max-w-md w-full flex flex-col items-center gap-6 text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,0,213,0.1)' }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" color="#ff00d5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="6" width="20" height="14" rx="2" />
              <path d="M2 10h20" />
              <path d="M16 14h2" />
            </svg>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-heading text-2xl font-bold">Connect Your Wallet</h2>
            <p className="text-muted text-sm">
              Connect your MetaMask wallet to start trading on DreamDEX.
            </p>
          </div>
          <button
            onClick={connectWallet}
            disabled={connecting}
            className="btn-cta w-full justify-center disabled:opacity-50"
          >
            {connecting ? 'Connecting…' : 'Connect MetaMask'}
          </button>
          <p className="text-subtle text-xs">
            No private keys shared. Non-custodial — you stay in control.
          </p>
        </div>
      </main>
    );
  }

  // Wallet connected — show dashboard
  return (
    <main className="mx-auto max-w-screen-xl px-4 py-6">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-heading">Trading Dashboard</h1>
          <p className="text-sm text-muted">Connected: {account.slice(0, 6)}...{account.slice(-4)}</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          {health ? (
            <>
              <span className="mono">
                {health.network} · chain {health.chainId}
              </span>
              <span className="flex items-center gap-1.5">
                <span className={`status-dot ${health.dryRun ? '' : 'status-dot--live'}`} />
                {health.dryRun ? 'DRY RUN' : 'LIVE'}
              </span>
            </>
          ) : (
            <span className="status-dot bg-overlay" title="backend offline" />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-6">
          <AgentForm onChanged={refresh} />

          <div className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-heading">Run one cycle</h2>
              <span className="mono text-xs text-subtle">{lastRun || 'idle'}</span>
            </div>
            <p className="mt-1 text-xs text-muted">
              Books → signals → decisions → broker gate. DRY_RUN logs, sends nothing.
            </p>
            <button
              onClick={() => void handleRun()}
              disabled={running}
              className="btn-cta mt-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? 'Running…' : 'Run agent cycle'}
            </button>
          </div>
        </section>

        <section>
          <MarketBoard />
        </section>
      </div>

      <div className="mt-6">
        <ProofLog />
      </div>
    </main>
  );
}
