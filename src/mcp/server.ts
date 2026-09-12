// `web_search` proxies Copilot's /responses endpoint: the fix for Claude Code wired Direct, whose
// builtin WebSearch the Copilot host rejects. Clients namespace tools by server name, so the tool
// surfaces as `mcp__copilot-env__web_search` and future tools join under the same registration.
//
// serveStdio negotiates the protocol era per connection and may run the factory twice on a
// probe-then-fallback opening, so the factory must stay cheap and side-effect-free. stdout carries
// only JSON-RPC; logs go to stderr.
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
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

/** A missing or broken credential surfaces per tool call as an MCP tool error, not a startup crash:
 *  clients render tool errors, while a dead server just looks broken. */
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
        description: "Search the web via GitHub Copilot (the /responses web_search tool) and " +
          "return a concise answer with a Sources list of cited URLs.",
        // fromJsonSchema keeps the schema a plain JSON-Schema literal rather than pulling in a
        // schema library.
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
        // The SDK rejects unknown tools and schema violations before this runs; blank-but-valid
        // input is ours.
        if (query.trim() === "") {
          return toolError("web_search needs a non-empty string `query` argument.");
        }
        try {
          const answer = await webSearch(query, {
            profile: opts.profile,
            model: opts.model,
            // A client cancellation aborts the POST instead of letting it run to its own 120s
            // timeout.
            signal: ctx.mcpReq.signal,
          });
          return { content: [{ type: "text", text: answer }] };
        } catch (e) {
          // Never rethrow: a failed search must not kill the server. The credential errors already
          // say how to fix themselves.
          return toolError(errMessage(e));
        }
      },
    );

    return server;
  };

  const wire = new StdioServerTransport();
  const handle = serveStdio(factory, {
    transport: wire,
    // Reporting only, never written to the wire: malformed input, wire write failures, teardown
    // races.
    onerror: (e) => logger.debug(`mcp serve error: ${errMessage(e)}`),
  });
  logger.debug(`copilot-env MCP server up (v${packageVersion()})`);

  // The stdio transport only reads stdin "data": nothing closes the server when the client goes
  // away, so the process would linger. Every teardown path funnels through the transport's close(),
  // so its onclose (installed synchronously by serveStdio above) is the one exit signal.
  //   "end"   -> normal EOF
  //   "close" -> a destroyed stdin that never emits "end"; handle.close() is idempotent
  await new Promise<void>((resolve) => {
    const entryOnClose = wire.onclose;
    wire.onclose = () => {
      entryOnClose?.();
      resolve();
    };
    // If the entry's teardown rejects before it reaches wire.close(), onclose never fires and
    // re-entrant close() calls early-return: close the wire ourselves and settle, or the process
    // hangs holding stdin.
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
