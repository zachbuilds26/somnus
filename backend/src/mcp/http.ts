import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log, warn } from '../config';
import { registerReadTools } from './tools-read';
import { registerUserTools } from './tools-user';
import { IdentityError, identityFromHeaders, perUserWalletsEnabled, TOKEN_HEADER } from './identity';
import { userTradingMode } from '../services/user-trading';

/** Hosted MCP endpoint — read tools for everyone, plus the caller's own wallet.
 *
 *  Anyone can point their coding agent at this URL:
 *
 *      claude mcp add --transport http somnus https://<host>/mcp
 *
 *  and ask, in English, what the agent is doing and whether it can prove it. That
 *  half needs no credential: the read tools sign nothing, spend nothing and change
 *  no saved rule, so publishing the address hands out no authority over the
 *  operator's wallet.
 *
 *  Add an `x-somnus-token` header and six more tools appear, backed by a wallet
 *  DERIVED from that token (see identity.ts). The token is the only thing that
 *  controls it, so the tools are registered per request rather than per process —
 *  each request's server closes over that request's headers, and a caller can never
 *  reach a wallet other than their own. With no SOMNUS_USER_SECRET configured they
 *  are not registered at all, because a deployment should not advertise a wallet it
 *  cannot derive.
 *
 *  Stateless on purpose (`sessionIdGenerator: undefined`): each request carries its
 *  own transport, so there is no server-side session map to grow without bound, and
 *  a restart cannot orphan a client mid-conversation. The cost is no server-initiated
 *  notifications, which this surface does not need.                              */

/** What a caller sees when they use a per-user tool with no token. It is the whole
 *  onboarding path, so it says how to set the header rather than just what is wrong. */
const NO_TOKEN =
  `no wallet token on this request. Per-user wallets are derived from a token you choose, so ` +
  `send one as the \`${TOKEN_HEADER}\` header:\n\n` +
  `    claude mcp add --transport http somnus <this-url> \\\n` +
  `      --header "${TOKEN_HEADER}: <a long random string you keep>"\n\n` +
  `The same token always derives the same wallet, and it is the ONLY thing protecting ` +
  `the funds in it — treat it like a password, and use at least 24 characters. The read-only ` +
  `tools work without any of this.`;

export function mountMcp(app: Express): void {
  const handler = async (req: Request, res: Response): Promise<void> => {
    // A fresh server+transport per request. Reusing one transport across concurrent
    // requests interleaves their JSON-RPC framing; construction is cheap because the
    // tools close over module state rather than holding any of their own.
    const server = new McpServer({ name: 'somnus', version: '0.1.0' });
    registerReadTools(server);
    if (perUserWalletsEnabled()) {
      registerUserTools(server, () => {
        const identity = identityFromHeaders(req.headers);
        if (!identity) throw new IdentityError(NO_TOKEN);
        return identity;
      });
    }
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
  if (perUserWalletsEnabled()) {
    log(
      `MCP per-user wallets enabled: send ${TOKEN_HEADER} to derive one ` +
        `(orders are ${userTradingMode() === 'live' ? 'LIVE' : 'priced but not sent'})`,
    );
  } else {
    log('MCP per-user wallets disabled (set SOMNUS_USER_SECRET to enable)');
  }
}
