import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { debug } from '../config';
import type { Report } from '../types';

export type { Report };

/** Shared plumbing for the MCP tool surface.
 *
 *  Somnus already exposes everything over HTTP. MCP adds a menu: a coding agent
 *  asks what this server can do, gets a typed list back, and calls the entries
 *  itself. The value is not new capability — it is that a person can ask
 *  "is it trading, and can it prove it?" in English and get an answer.
 *
 *  Tools are split into READ and WRITE for one reason: the hosted deployment
 *  serves only the read half, so the public URL needs no key and cannot move
 *  money. The write half ships only in the local install, where the person
 *  running it owns the wallet. See mcp/http.ts and mcp-server.ts.              */

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** A successful result. Agents read this text, so JSON is pretty-printed rather
 *  than minified — a model parses either, but a human reading the transcript
 *  only stands a chance with the former. */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Plain prose result, for tools whose answer is a sentence rather than a shape. */
export function say(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A failure the agent should see and can act on.
 *
 *  `isError` matters: without it a thrown-and-stringified error reads to the model
 *  as a successful call that happened to return the word "Error", and it carries on
 *  as though the tool worked. */
export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Run a tool body, turning any throw into a visible tool error.
 *
 *  Every tool here reaches the network or the chain, so every tool can throw. An
 *  unhandled rejection inside a tool handler takes down the transport, which for
 *  the hosted server means one bad market read disconnects every client. */
export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}

/** Register a tool that takes no arguments.
 *
 *  Most of the read surface is argument-free, and the SDK's empty-shape handling is
 *  fiddly enough to be worth hiding behind one helper. */
export function simpleTool(
  server: McpServer,
  name: string,
  description: string,
  run: (report: Report) => Promise<ToolResult>,
): void {
  server.registerTool(name, { description, inputSchema: {} }, (_args, extra) =>
    guard(() => run(reporter(extra))),
  );
}

/** Tell the caller what a slow tool is doing WHILE it does it.
 *
 *  `somnus_my_quote` reads an order book per window — eight by default — and every
 *  one is a network round trip. That is tens of seconds during which the protocol
 *  says nothing at all, so the caller's agent shows a spinner and then, abruptly, an
 *  answer. The fix belongs HERE and not in any one client's settings: a progress
 *  notification is part of MCP, so doing it server-side means every client that
 *  renders progress gets it, from any editor or agent, with nothing to configure.
 *
 *  Report is deliberately a plain function rather than an object: a tool body should
 *  be able to call it without caring whether anyone is listening. The type lives in
 *  types.ts so a service can accept one without importing this layer. */

/** The `extra` argument the SDK hands a tool callback, narrowed to what is used here.
 *  Structural rather than imported so a test can pass a stub, and so an SDK bump that
 *  widens the real type cannot break this file. */
export interface ToolExtra {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification?: (n: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/** Build a reporter for one tool call.
 *
 *  Two things make this safe to sprinkle through business logic. It is a NO-OP unless
 *  the client actually asked for progress by sending a `progressToken` — the spec is
 *  explicit that a server must not send progress unrequested, and a tool must behave
 *  identically without one. And it never throws or blocks: notifications are
 *  fire-and-forget, so a client that hung up mid-call cannot turn a successful trade
 *  into a failed tool. A dropped progress line is a cosmetic loss; a dropped fill is
 *  not.                                                                          */
export function reporter(extra: ToolExtra | undefined): Report {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return () => undefined;

  // Monotonic fallback so a caller that only has prose still produces a rising
  // counter — some clients render the number and ignore the message.
  let seq = 0;
  return (message, progress, total) => {
    seq += 1;
    void Promise.resolve(
      send({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: progress ?? seq,
          ...(total !== undefined ? { total } : {}),
          message,
        },
      }),
    ).catch((err: unknown) => {
      // Swallowed on purpose, but not silently — a client that never sees progress
      // and a server that cannot send it look identical from the outside.
      debug('mcp: progress notification failed:', (err as Error).message ?? String(err));
    });
  };
}
