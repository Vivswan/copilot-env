// The copilot-env MCP stdio server: the process behind `agent mcp --serve`,
// registered in Claude Code (and registerable in Codex, Cursor, or any MCP client).
// One tool so far, `web_search`, proxying through Copilot's /responses endpoint --
// the fix for Claude Code wired Direct, whose builtin WebSearch the Copilot host
// rejects.
// Server name "copilot-env" on purpose: clients namespace tools by server, so the
// tool surfaces as `mcp__copilot-env__web_search` and future tools join under the
// same name without any re-registration.
//
// Served through v2's `serveStdio`, which negotiates the protocol era per
// connection: a classic `initialize` handshake gets the 2025-era serving today's
// clients expect, while a request carrying a modern `_meta` envelope (or a
// `server/discover` probe) gets the stateless 2026-07-28 protocol. The factory
// below is built once per connection -- twice on a probe-then-fallback opening --
// so it must stay cheap and side-effect-free.
//
// stdout carries ONLY newline-delimited JSON-RPC; every log line goes to stderr
// (see redirectConsolaToStderr below).
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Profile } from "../copilot_api/profile.ts";
import { webSearch } from "../copilot_api/web_search.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger, redirectConsolaToStderr } from "../utils/logger.ts";
import { packageVersion } from "../utils/version.ts";

const logger = createStderrLogger();

export const MCP_SERVER_NAME = "copilot-env";
const WEB_SEARCH_TOOL = "web_search";

export interface McpServerOptions {
  /** Credential slot the tools resolve; a named profile never falls back. */
  profile: Profile;
  /** Per-process web-search model override (beats the stored config key). */
  model?: string;
}

/**
 * Run the stdio server until the client disconnects (stdin EOF). A missing or
 * broken credential surfaces per TOOL CALL as an MCP tool error, not a startup
 * crash -- clients render tool errors, while a dead server just looks broken.
 */
export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  redirectConsolaToStderr();

  const factory = () => {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: packageVersion() },
      { capabilities: { "tools": {} } },
    );

    server.registerTool(
      WEB_SEARCH_TOOL,
      {
        description:
          "Search the web via GitHub Copilot (the /responses web_search tool) and " +
          "return a concise answer with a Sources list of cited URLs.",
        // fromJsonSchema keeps the schema a plain JSON-Schema literal (the wire
        // contract) instead of forcing a schema-library dependency on us.
        inputSchema: fromJsonSchema<{ query: string }>({
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "The web search query." },
          },
          "required": ["query"],
        }),
        annotations: { "readOnlyHint": true, "openWorldHint": true },
      },
      async ({ query }, ctx) => {
        // Error taxonomy: an unknown tool is a protocol error (the SDK's); schema
        // violations are tool-level errors the SDK raises before the handler runs;
        // semantically blank-but-schema-valid input is ours to reject here.
        if (query.trim() === "") {
          return toolError("web_search needs a non-empty string `query` argument.");
        }
        try {
          const answer = await webSearch(query, {
            profile: opts.profile,
            model: opts.model,
            // A client cancellation aborts the in-flight POST instead of letting it
            // run to its own 120s timeout.
            signal: ctx.mcpReq.signal,
          });
          return { content: [{ type: "text", text: answer }] };
        } catch (e) {
          // Never rethrow: a failed search (no credential, HTTP error, timeout) must not
          // kill the server. The credential errors already say how to fix themselves.
          return toolError(errMessage(e));
        }
      },
    );

    return server;
  };

  const wire = new StdioServerTransport();
  const handle = serveStdio(factory, {
    transport: wire,
    // Reporting-only (never written to the wire): malformed input, wire write
    // failures, teardown races.
    onerror: (e) => logger.debug(`mcp serve error: ${errMessage(e)}`),
  });
  logger.debug(`copilot-env MCP server up (v${packageVersion()})`);

  // The stdio transport only reads stdin "data"; nothing closes the server when the
  // client goes away, so hook EOF ourselves or the process would linger forever.
  // "close" covers a destroyed stdin that never emits "end"; handle.close() is
  // idempotent, so hearing both is safe. Every teardown path (stdin EOF/teardown,
  // instance-side close, wire error) funnels through the transport's close(), so
  // chaining its onclose -- which serveStdio installed synchronously above -- is
  // the one exit signal.
  await new Promise<void>((resolve) => {
    const entryOnClose = wire.onclose;
    wire.onclose = () => {
      entryOnClose?.();
      resolve();
    };
    // If the entry's teardown rejects before it reaches wire.close(), onclose never
    // fires and re-entrant close() calls early-return -- close the wire ourselves
    // and settle, or the process would hang holding stdin.
    const shutdown = () => {
      handle.close().catch(() => {
        void wire.close().catch(() => {});
        resolve();
      });
    };
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
  });
}

function toolError(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}
