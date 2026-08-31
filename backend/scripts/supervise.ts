import { spawn } from 'node:child_process';
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

function start(): void {
  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
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

// Forward Ctrl-C / termination to the child so `npm run start:supervised` stops
// cleanly instead of orphaning a server.
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

console.log('[supervisor] starting Somnus (auto-restart enabled)');
start();
