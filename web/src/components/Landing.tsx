import { useEffect, useRef, useState } from 'react';

function HeroCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let animId: number;
    let t = 0;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = canvas.parentElement?.offsetHeight ?? window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    const draw = () => {
      t += 0.003;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const orbs = [
        { x: 0.3, y: 0.4, r: 200, color: 'rgba(255,0,213,0.08)' },
        { x: 0.7, y: 0.3, r: 250, color: 'rgba(198,163,255,0.06)' },
        { x: 0.5, y: 0.6, r: 180, color: 'rgba(255,102,230,0.07)' },
      ];
      for (const orb of orbs) {
        const cx = canvas.width * orb.x + Math.sin(t + orb.x * 5) * 60;
        const cy = canvas.height * orb.y + Math.cos(t + orb.y * 5) * 40;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, orb.r);
        grad.addColorStop(0, orb.color);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fillRect(cx - orb.r, cy - orb.r, orb.r * 2, orb.r * 2);
      }
      ctx.strokeStyle = 'rgba(255,0,213,0.03)';
      ctx.lineWidth = 1;
      const spacing = 80;
      for (let x = 0; x < canvas.width; x += spacing) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += spacing) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      }
      animId = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={canvasRef} className="absolute inset-0 block w-full h-full" style={{ opacity: 0.7 }} />;
}

const icons = {
  brain: <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a5 5 0 0 1 5 5c0 1.1-.4 2.1-1 2.9.6.8 1 1.8 1 2.9a5 5 0 0 1-2 4v1.2a2 2 0 0 1-2 2h0a2 2 0 0 1-2-2V12.8a5 5 0 0 1-2-4c0-1.1.4-2.1 1-2.9A5 5 0 0 1 7 7a5 5 0 0 1 5-5Z"/><path d="M12 2v20"/></svg>,
  shield: <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 4v6c0 5.25-3.5 9.74-8 11-4.5-1.26-8-5.75-8-11V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>,
  zap: <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  chart: <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  wallet: <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M16 14h2"/></svg>,
  globe: <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  lock: <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  arrowRight: <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>,
  copy: <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>,
  check: <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>,
};

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="card p-6 flex flex-col gap-4 h-full">
      <div className="text-accent">{icon}</div>
      <h4 className="text-heading font-semibold text-lg">{title}</h4>
      <p className="text-muted text-sm leading-relaxed">{desc}</p>
    </div>
  );
}
function StepCard({ n, title, desc }: { n: string; title: string; desc: string }) {
  return (
    <div className="flex gap-4 items-start">
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-sm">{n}</div>
      <div className="flex flex-col gap-1">
        <h4 className="text-heading font-semibold">{title}</h4>
        <p className="text-muted text-sm leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

export default function Landing({ onConnect }: { onConnect?: () => void }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const mcpUrl = 'http://127.0.0.1:4545/mcp';
  useEffect(() => { setVisible(true); }, []);
  const copy = async () => {
    await navigator.clipboard.writeText(mcpUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex flex-col w-full">
      {/* Hero — Paybox style: Give your AI a trading wallet */}
      <section className="relative w-full overflow-hidden" style={{ minHeight: 'calc(100dvh - 4rem)' }}>
        <HeroCanvas />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24" style={{ background: 'linear-gradient(to bottom, #000, transparent)' }} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24" style={{ background: 'linear-gradient(to top, #000, transparent)' }} />
        <div className="z-20 flex flex-col items-center justify-center absolute inset-0 px-4">
          <div className="flex flex-col gap-6 items-center text-center max-w-3xl" style={{ opacity: visible ? 1 : 0, transform: visible ? 'translateY(0)' : 'translateY(20px)', transition: 'all 0.8s ease' }}>
            <div className="flex items-center gap-2 px-4 py-2 rounded-full border border-line-strong bg-surface/50 backdrop-blur-sm text-xs text-muted">
              <span className="status-dot status-dot--live" /> Live on Somnia Testnet · MCP native
            </div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-heading leading-tight">
              Give your AI a<br />trading wallet
            </h1>
            <p className="text-lg sm:text-xl text-body max-w-xl">
              Somnus connects <span className="text-heading font-medium">ChatGPT, Claude, Cursor, Codex</span> to DreamDEX Event Contracts — non-custodial, $1000 cap, every trade signed on-chain.
            </p>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-line bg-surface/80 backdrop-blur text-xs sm:text-sm w-full max-w-md mt-2">
              <span className="text-muted truncate flex-1 text-left mono">{mcpUrl}</span>
              <button onClick={copy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-black font-semibold text-xs shrink-0">
                {copied ? icons.check : icons.copy} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-muted text-xs">One URL for any coding agent — no API key, wallet stays yours.</p>
            <div className="flex flex-wrap gap-3 justify-center mt-1">
              <button onClick={onConnect} className="btn-cta text-base">Connect Wallet to Trade {icons.arrowRight}</button>
              <a href="#setup" className="btn-ghost text-base">How to add to AI</a>
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-muted">
              <span className="px-2 py-1 rounded-full border border-line">ChatGPT</span>
              <span className="px-2 py-1 rounded-full border border-line">Claude</span>
              <span className="px-2 py-1 rounded-full border border-line">Cursor</span>
              <span className="px-2 py-1 rounded-full border border-line">Codex</span>
            </div>
          </div>
        </div>
      </section>

      {/* Setup — 4 steps like Paybox */}
      <section id="setup" className="w-full max-w-screen-xl mx-auto px-4 py-20 sm:py-28">
        <div className="flex flex-col gap-4 mb-12">
          <span className="text-accent text-xs font-semibold uppercase tracking-wider">Setup in 2 minutes</span>
          <h2 className="text-heading text-3xl sm:text-4xl font-bold">Add Somnus to your AI</h2>
          <p className="text-muted text-base max-w-xl">Works with any MCP agent — ChatGPT, Claude Desktop, Cursor, Codex. Your AI then trades via your funded session wallet.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          <StepCard n="01" title="Copy MCP URL" desc={`${mcpUrl} — one URL for all agents. No repo clone needed.`} />
          <StepCard n="02" title="Add to your AI" desc="ChatGPT: Settings → Developers → Add MCP Server. Claude: claude_desktop_config.json → mcpServers.somnus. Cursor: Settings → MCP." />
          <StepCard n="03" title="Connect wallet" desc="In chat say “Trade $50” → AI shows Connect Wallet → opens widget → sign nonce → trading wallet created. Fund with tUSDC + 0.02 STT." />
          <StepCard n="04" title="Trade in chat" desc="Say “Trade $50” or “Scan markets” or “Show P&L”. Agent stays on until edge, auto-claims wins, pushes win/loss + profit." />
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href="https://chatgpt.com/#settings" target="_blank" rel="noreferrer" className="btn-ghost text-sm">Open ChatGPT Settings</a>
          <button onClick={onConnect} className="btn-cta text-sm">Open Connect Wallet {icons.arrowRight}</button>
        </div>
      </section>

      {/* What your AI can do — paybox use-case grid */}
      <section className="w-full max-w-screen-xl mx-auto px-4 py-20 sm:py-28">
        <div className="flex flex-col gap-4 mb-12">
          <span className="text-accent text-xs font-semibold uppercase tracking-wider">In one chat</span>
          <h2 className="text-heading text-3xl sm:text-4xl font-bold">Trade, scan, claim — all in chat</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="card p-6 flex flex-col gap-3">
            <span className="text-xs uppercase tracking-wider text-accent">Trading · One-tap</span>
            <h4 className="text-heading font-semibold">“Trade $50”</h4>
            <p className="text-muted text-sm">Agent finds 5m/15m edge ≥5%, places IOC via your session wallet. Shows <span className="text-heading">Placed $49.74 BTC UP @0.266 tx 0x...</span></p>
          </div>
          <div className="card p-6 flex flex-col gap-3">
            <span className="text-xs uppercase tracking-wider text-accent">Scan · No trade</span>
            <h4 className="text-heading font-semibold">“Scan markets”</h4>
            <p className="text-muted text-sm">Lists live windows with books: <span className="text-heading">BTC 5m mid 0.51 fair 0.58 edge 7pp</span> — preview before you pay.</p>
          </div>
          <div className="card p-6 flex flex-col gap-3">
            <span className="text-xs uppercase tracking-wider text-accent">P&L · Auto-claim</span>
            <h4 className="text-heading font-semibold">“Show positions”</h4>
            <p className="text-muted text-sm">Open, claimable, settled. Wins auto-claimed <span className="text-heading">+990 tUSDC tx 0x42af...</span> and pushed to chat — no manual claim.</p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="w-full max-w-screen-xl mx-auto px-4 py-20 sm:py-28">
        <div className="flex flex-col gap-4 mb-12">
          <span className="text-accent text-xs font-semibold uppercase tracking-wider">Why Somnus</span>
          <h2 className="text-heading text-3xl sm:text-4xl font-bold">Governed, not gambling</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          <FeatureCard icon={icons.brain} title="GBM fair price" desc="Driftless GBM from live spot + horizon vol. Trades only when edge vs book — 5m validated 58% win, Brier 0.189." />
          <FeatureCard icon={icons.shield} title="Momentum breaker" desc="Skips when book collapses 8pp against you in 10m — avoids falling knife the model can't see." />
          <FeatureCard icon={icons.zap} title="IOC + STT check" desc="Crosses touch by up to 50% edge, capped at fair. Checks 0.02 STT before approve — no wasted gas." />
          <FeatureCard icon={icons.chart} title="Proof chain" desc="Every decision/order hash-chained + secp256k1 signed. Verify via somnus_proof_verify — 1700 entries anchored on-chain." />
          <FeatureCard icon={icons.wallet} title="Per-user session" desc="Your main wallet signs nonce → derived trading wallet 0xSession funded with tUSDC. Operator TRADE_KEY never touches your funds. Revoke in 1 tap." />
          <FeatureCard icon={icons.globe} title="Stay-on hunter" desc="No very-sure/middle picker — agent stays on until signal, auto-retries next 5m window. $1000/day + $1000/trade cap." />
        </div>
      </section>

      {/* Security */}
      <section className="w-full max-w-screen-xl mx-auto px-4 py-20 sm:py-28">
        <div className="card p-8 sm:p-12 flex flex-col sm:flex-row gap-8 items-center">
          <div className="text-accent flex-shrink-0">{icons.lock}</div>
          <div className="flex flex-col gap-3">
            <h3 className="text-heading text-2xl font-bold">Non-custodial by design</h3>
            <p className="text-muted leading-relaxed">Session key from <span className="mono text-heading">sessionPrivateKey(seed)</span> can only <span className="text-heading">buy</span> on DreamDEX via SomniaMarkets SDK — cannot transfer, approve, or touch other contracts. You fund it, you revoke it at <span className="mono">/widget</span>. Matches Paybox MPC sharding — scoped, revocable, auditable.</p>
          </div>
        </div>
      </section>

      <section className="w-full max-w-screen-xl mx-auto px-4 py-20 sm:py-28">
        <div className="flex flex-col items-center text-center gap-6">
          <h2 className="text-heading text-3xl sm:text-4xl font-bold">Give your AI a trading wallet</h2>
          <p className="text-muted text-lg max-w-md">Copy the MCP URL, add to ChatGPT/Claude/Cursor, connect wallet, say Trade $50.</p>
          <div className="flex gap-3">
            <button onClick={onConnect} className="btn-cta text-base mt-2">Connect Wallet {icons.arrowRight}</button>
            <button onClick={copy} className="btn-ghost text-base mt-2">{copied ? 'Copied ✓' : 'Copy MCP URL'}</button>
          </div>
        </div>
      </section>

      <footer className="w-full border-t border-line mt-16">
        <div className="max-w-screen-xl mx-auto px-4 py-12 flex flex-col sm:flex-row justify-between gap-8">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 font-semibold text-heading text-lg"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'linear-gradient(135deg,#ff00d5,#ff66e6)' }} /> Somnus</div>
            <p className="text-muted text-sm max-w-xs">AI trading agent for DreamDEX Event Contracts — MCP native for any coding agent.</p>
          </div>
          <div className="flex gap-12">
            <div className="flex flex-col gap-3"><span className="text-heading font-semibold text-sm">Product</span><a href="#setup" className="text-muted text-sm hover:text-heading transition-colors">Setup</a><a href="http://127.0.0.1:4545/widget" className="text-muted text-sm hover:text-heading transition-colors">Connect Wallet</a><a href="http://127.0.0.1:4545/api/health" className="text-muted text-sm hover:text-heading transition-colors">Health</a></div>
            <div className="flex flex-col gap-3"><span className="text-heading font-semibold text-sm">MCP</span><span className="text-muted text-sm mono">{mcpUrl}</span><span className="text-muted text-xs">Claude · ChatGPT · Cursor · Codex</span></div>
          </div>
        </div>
        <div className="max-w-screen-xl mx-auto px-4 pb-8 flex justify-between items-center gap-4 border-t border-line pt-6">
          <span className="text-subtle text-xs">Built for Somnia × DreamDEX · Testnet 50312</span>
          <span className="text-subtle text-xs">Non-custodial · $1000 cap · Proof 1700</span>
        </div>
      </footer>
    </div>
  );
}
