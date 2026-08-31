import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerSomnusTools } from './mcp-tools';
import { userIdFromAuth } from './services/sessions';
import { setPendingNotifier } from './services/pending.js';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  authToken?: string;
  userId?: string;
}

const sessions = new Map<string, Session>();

setPendingNotifier((p) => {
  for (const s of sessions.values()) {
    try {
      (s.server as any).server?.notification?.({ method: 'notifications/message', params: { level: 'info', data: `Somnus found: ${p.symbol} ${p.horizon} edge ${(p.edge * 100).toFixed(1)}% cost $${p.cost} payout $${p.payoutIfWin} — /api/agent/confirm {id:${p.id}}` } });
    } catch {}
  }
});

/**
 * Attach a remote (HTTP) MCP endpoint at `/mcp`. Unlike the stdio server (which is
 * machine-local), this lets any coding agent or website connect over the network.
 * Each client gets its own session (transport + server instance) keyed by the
 * session id the SDK issues during initialize.
 */
export function linkMcpSession(sessionId: string, userId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.userId = userId;
  return true;
}

export function broadcastMcpMessage(message: string): void {
  for (const s of sessions.values()) {
    try {
      (s.server as unknown as { server?: { notification?: (o: unknown) => void } }).server?.notification?.({
        method: 'notifications/message',
        params: { level: 'info', data: message },
      });
    } catch {}
  }
}

export function attachMcp(app: Express): void {
  // One-tap link: widget after signing does POST /api/mcp/link {mcpSession, token} → ties JWT to that MCP session
  app.post('/api/mcp/link', (req, res) => {
    const { mcpSession, token } = req.body ?? {};
    if (typeof mcpSession !== 'string' || typeof token !== 'string') {
      res.status(400).json({ ok: false, error: 'need {mcpSession, token}' });
      return;
    }
    const userId = userIdFromAuth(`Bearer ${token}`);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'invalid token' });
      return;
    }
    const ok = linkMcpSession(mcpSession, userId);
    res.json({ ok, linked: ok, userId });
  });

  const handler = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const existing = sid ? sessions.get(sid) : undefined;
    if (existing) {
      return existing.transport.handleRequest(req as never, res as never, req.body);
    }
    if (!sid && req.method === 'POST') {
      let sessionId: string | undefined;
      let session: Session | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessionId = id;
          const userId = userIdFromAuth(req.headers['authorization'] as string | undefined);
          session = {
            server,
            transport,
            authToken: req.headers['authorization'] as string | undefined,
            userId: userId ?? undefined,
          };
          sessions.set(id, session!);
        },
      });
      transport.onclose = () => {
        if (sessionId) sessions.delete(sessionId);
      };
      const server = new McpServer({ name: 'somnus', version: '0.1.0' });
      registerSomnusTools(server, { getUserId: () => session?.userId ?? null });
      await server.connect(transport);
      await transport.handleRequest(req as never, res as never, req.body);
      return;
    }
    res.status(400).json({ error: 'Invalid MCP request: missing or unknown session id' });
  };

  app.post('/mcp', handler);
  app.get('/mcp', handler);
  app.delete('/mcp', handler);
}
