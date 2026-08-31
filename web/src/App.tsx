import { useEffect, useState } from 'react';
import Landing from './components/Landing';
import Studio from './components/Studio';

function useHash(): string {
  const [hash, setHash] = useState<string>(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hash;
}

function NavBar({ onConnect }: { onConnect: () => void }) {
  return (
    <header className="sticky top-0 z-50" style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(12px)' }}>
      <div className="mx-auto flex max-w-screen-xl items-center justify-between px-4 py-4">
        <a href="#/" className="flex items-center gap-2 font-semibold text-heading text-lg">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: 'linear-gradient(135deg,#ff00d5,#ff66e6)' }}
          />
          Somnus
        </a>
        <nav className="flex items-center gap-3 text-sm">
          <a href="#how-it-works" className="text-muted hover:text-heading transition-colors hidden sm:block">
            How It Works
          </a>
          <button onClick={onConnect} className="btn-cta text-sm">
            Launch App
          </button>
        </nav>
      </div>
    </header>
  );
}

export default function App() {
  const hash = useHash();
  const page = hash.startsWith('#/studio') ? 'studio' : 'landing';

  const handleConnect = () => {
    window.location.hash = '#/studio';
  };

  return (
    <div className="min-h-screen" style={{ background: '#000' }}>
      <NavBar onConnect={handleConnect} />
      {page === 'studio' ? <Studio /> : <Landing onConnect={handleConnect} />}
    </div>
  );
}
