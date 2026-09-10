import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerReadTools } from './mcp/tools-read';
import { registerWriteTools } from './mcp/tools-write';
import { registerUserTools } from './mcp/tools-user';
import { acquireLock, LockHeldError, releaseLock } from './services/lock';
import { identityFromToken, perUserWalletsEnabled } from './mcp/identity';

/** Local MCP server — the full surface, over stdio.
 *
 *  This is the install for someone who wants Somnus to trade for them. Their coding
 *  agent launches this process on THEIR machine, reading THEIR backend/.env, signing
 *  with THEIR key. Nobody hands out a private key and nobody takes custody of
 *  anyone's funds — which is the whole reason this exists alongside the hosted
 *  read-only endpoint in mcp/http.ts.
 *
 *      claude mcp add somnus -- npx tsx backend/src/mcp-server.ts
 *
 *  Read AND write tools are registered here: on this side of the boundary, the
 *  person running the process is the person whose money is at stake.            */

// MCP speaks JSON-RPC over stdout. Anything else written there corrupts the framing
// and the client disconnects mid-handshake — and the agent's own logger writes to
// stdout by default. Reroute it to stderr BEFORE importing anything that might log,
// which is why this sits above the server construction rather than inside it.
const toStderr = console.error.bind(console);
console.log = (...args: unknown[]) => toStderr('[somnus]', ...args);
console.info = (...args: unknown[]) => toStderr('[somnus]', ...args);

const server = new McpServer({ name: 'somnus', version: '0.1.0' });

// Single-instance guard (H5): this process trades the same operator wallet and
// the same data dir as the HTTP backend, and every concurrency invariant in
// this codebase (one proof append, one cycle, one claim at a time) is module
// state — it holds within ONE process and not across two. Two processes on one
// data dir interleave proof-chain appends and double-spend the position budget,
// which is exactly the corruption the backend's lock file exists to prevent.
// So take the same lock, and DEGRADE rather than die when it is held: reads are
// harmless to share, writes are not. (Never exit here — an operator who left
// the backend running and then asked their coding agent to check a price would
// otherwise get a dead tool instead of a read-only one.)
let writeToolsEnabled = true;
try {
  acquireLock();
  // Give the lock back on a clean exit, or the next backend start reports a
  // phantom holder. A takeover after a kill is still safe (stale pid), just noisy.
  process.on('exit', () => releaseLock());
} catch (err) {
  if (err instanceof LockHeldError) {
    writeToolsEnabled = false;
    toStderr(`[somnus-mcp] DATA DIR LOCKED — ${err.message}`);
    toStderr(
      '[somnus-mcp] continuing READ-ONLY: the HTTP backend owns this data dir, so all ' +
        'trading tools (write + per-user wallet) are DISABLED in this process. Reads still ' +
        'work. Stop the backend first if you want this process to trade.',
    );
  } else {
    throw err;
  }
}

registerReadTools(server);
if (writeToolsEnabled) {
  registerWriteTools(server);
} else {
  toStderr('[somnus-mcp] write tools NOT registered — trading is disabled while the data dir is locked');
}

/** Derived-wallet tools, off by default locally.
 *
 *  A local install already owns a wallet, so a second one derived from a token is
 *  redundant here — and two wallets in one process is exactly the kind of ambiguity
 *  that gets money sent from the wrong one. Registered only when the operator sets
 *  BOTH halves explicitly, which makes it opt-in rather than incidental: useful for
 *  exercising the hosted path locally, silent otherwise.
 *
 *  Also skipped while read-only (H5): per-user orders still append to the SHARED
 *  proof chain, so they share the same cross-process hazard as any other write. */
const localToken = process.env.SOMNUS_USER_TOKEN;
const perUser = perUserWalletsEnabled() && typeof localToken === 'string' && localToken.length > 0;
if (perUser && writeToolsEnabled) {
  registerUserTools(server, () => identityFromToken(localToken as string));
} else if (perUser) {
  toStderr('[somnus-mcp] per-user wallet tools NOT registered — trading is disabled while the data dir is locked');
}

const transport = new StdioServerTransport();
await server.connect(transport);
toStderr(
  `[somnus-mcp] stdio server ready — read${writeToolsEnabled ? ' + write' : ' ONLY (write tools disabled: data dir locked)'}${perUser && writeToolsEnabled ? ' + per-user wallet' : ''} tools registered`,
);
