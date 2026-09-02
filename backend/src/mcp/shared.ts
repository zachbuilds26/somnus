import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
  run: () => Promise<ToolResult>,
): void {
  server.registerTool(name, { description, inputSchema: {} }, () => guard(run));
}
