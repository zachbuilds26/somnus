import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerReadTools } from './mcp/tools-read';
import { registerWriteTools } from './mcp/tools-write';
import { registerUserTools } from './mcp/tools-user';
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
registerReadTools(server);
registerWriteTools(server);

/** Derived-wallet tools, off by default locally.
 *
 *  A local install already owns a wallet, so a second one derived from a token is
 *  redundant here — and two wallets in one process is exactly the kind of ambiguity
 *  that gets money sent from the wrong one. Registered only when the operator sets
 *  BOTH halves explicitly, which makes it opt-in rather than incidental: useful for
 *  exercising the hosted path locally, silent otherwise. */
const localToken = process.env.SOMNUS_USER_TOKEN;
const perUser = perUserWalletsEnabled() && typeof localToken === 'string' && localToken.length > 0;
if (perUser) {
  registerUserTools(server, () => identityFromToken(localToken as string));
}

const transport = new StdioServerTransport();
await server.connect(transport);
toStderr(
  `[somnus-mcp] stdio server ready — read + write${perUser ? ' + per-user wallet' : ''} tools registered`,
);
