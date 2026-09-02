import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log, warn } from '../config';
import { registerReadTools } from './tools-read';

/** Hosted MCP endpoint — READ-ONLY, no credential required.
 *
 *  Anyone can point their coding agent at this URL:
 *
 *      claude mcp add --transport http somnus https://<host>/mcp
 *
 *  and then ask, in English, what the agent is doing and whether it can prove it.
 *  Only the read half of the tool surface is registered, which is what makes that
 *  safe to publish: there is no key to leak, nothing to spend, and no way for a
 *  stranger who knows the address to make this wallet trade. Anyone who wants the
 *  agent to trade runs the local stdio install with their own key instead — see
 *  mcp-server.ts.
 *
 *  Stateless on purpose (`sessionIdGenerator: undefined`): each request carries its
 *  own transport, so there is no server-side session map to grow without bound, and
 *  a restart cannot orphan a client mid-conversation. The cost is no server-initiated
 *  notifications, which a read-only surface does not need.                       */
export function mountMcp(app: Express): void {
  const handler = async (req: Request, res: Response): Promise<void> => {
    // A fresh server+transport per request. Reusing one transport across concurrent
    // requests interleaves their JSON-RPC framing; construction is cheap because the
    // tools close over module state rather than holding any of their own.
    const server = new McpServer({ name: 'somnus', version: '0.1.0' });
    registerReadTools(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      // `req.body` is already parsed by express.json() upstream; the transport would
      // otherwise try to read a consumed stream and hang the request open.
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      warn('mcp request failed:', (err as Error).message ?? String(err));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null,
        });
      }
    }
  };

  // POST carries every JSON-RPC call. GET is the spec's server-push channel — answered
  // so a client that opens it gets a clean 405 rather than express's HTML 404, which
  // some clients surface as "server is broken" instead of "no push here".
  app.post('/mcp', handler);
  app.get('/mcp', (_req, res) => {
    res
      .status(405)
      .set('allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'This endpoint is stateless: POST JSON-RPC requests. No server-push stream.',
        },
        id: null,
      });
  });

  log('MCP endpoint mounted at POST /mcp (read-only tools, no key required)');
}
