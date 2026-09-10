import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Process supervisor: runs the Somnus server as a child and restarts it if it
 *  exits, so a crash (or an OOM, or a transient indexer meltdown) doesn't leave
 *  an "awake while you sleep" agent silently dead. This is the single-process
 *  substitute for a container/systemd supervisor — no external dependency.
 *
 *  Usage: npm run start:supervised   (kills with Ctrl-C to stop both) */

const cwd = fileURLToPath(new URL('..', import.meta.url));
const MAX_RESTARTS = Number(process.env.SUPERVISE_MAX ?? 1000);
const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;

let restarts = 0;
let child: ChildProcess | undefined;
/** True once the supervisor itself is shutting down — the child's exit then is
 *  expected and must not schedule a restart. */
let stopping = false;

function start(): void {
  if (stopping) return;
  child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    child = undefined;
    if (stopping) return;
    if (restarts >= MAX_RESTARTS) {
      console.error('[supervisor] max restarts reached — giving up');
      process.exit(1);
    }
    restarts++;
    const delay = Math.min(BASE_DELAY * restarts, MAX_DELAY);
    console.log(`[supervisor] server exited (code=${code ?? signal}); restart #${restarts} in ${delay}ms`);
    setTimeout(start, delay);
  });

  child.on('error', (err) => {
    console.error('[supervisor] failed to spawn server:', err.message);
  });
}

/** Stop the child first and await its exit before exiting ourselves. The old
 *  handlers called process.exit(0) directly, orphaning the server: it kept the
 *  data-dir lock and kept trading while the operator believed everything was
 *  stopped — and the next start then refused on a "held" lock. SIGKILL is the
 *  backstop if the child does not exit within 10s (its own shutdown grace is
 *  30s for an in-flight cycle, so a slow exit here means a cycle is finishing,
 *  not a hang — but the supervisor must still terminate). */
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  const c = child;
  if (!c || c.exitCode !== null || c.signalCode !== null) {
    process.exit(0);
    return;
  }
  console.log(`[supervisor] ${signal} — stopping the server and waiting for it to exit...`);
  const force = setTimeout(() => {
    console.error('[supervisor] server did not exit in 10s — killing it');
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 10_000);
  c.once('exit', () => {
    clearTimeout(force);
    process.exit(0);
  });
  try {
    c.kill(signal);
  } catch {
    clearTimeout(force);
    process.exit(0);
  }
}

// Forward Ctrl-C / termination to the child so `npm run start:supervised` stops
// cleanly instead of orphaning a server.
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[supervisor] starting Somnus (auto-restart enabled)');
start();
