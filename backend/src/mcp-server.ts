import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSomnusTools } from './mcp-tools';
import { setPendingNotifier } from './services/pending.js';

// MCP speaks JSON-RPC over stdout; any app log on stdout would corrupt the
// protocol. Route console.log/info to stderr so the channel stays clean.
const _err = console.error.bind(console);
console.log = (...a: unknown[]) => _err('[somnus]', ...a);
console.info = (...a: unknown[]) => _err('[somnus]', ...a);

const server = new McpServer({ name: 'somnus', version: '0.1.0' });
registerSomnusTools(server, { getUserId: () => null });

export function broadcastStdioMessage(message: string): void {
  try {
    (server as unknown as { server?: { notification?: (o: unknown) => void } }).server?.notification?.({
      method: 'notifications/message',
      params: { level: 'info', data: message },
    });
  } catch {}
}

setPendingNotifier((p) => {
  try {
    // Push to any coding agent connected via MCP — shows inside Claude/Cursor chat
    (server as any).server?.notification?.({ method: 'notifications/message', params: { level: 'info', data: `Somnus found: ${p.symbol} ${p.horizon} edge ${(p.edge * 100).toFixed(1)}% cost $${p.cost} payout $${p.payoutIfWin} — confirm ${p.id}` } });
  } catch {}
  console.error(`[somnus] pending ${p.id} ${p.symbol} edge ${(p.edge * 100).toFixed(1)}%`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[somnus-mcp] stdio MCP server running');
