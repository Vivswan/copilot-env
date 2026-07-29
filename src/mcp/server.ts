// The copilot-env MCP stdio server: the process behind `agent mcp`, registered in
// Claude Code (and registerable in Codex, Cursor, or any MCP client). One tool so
// far, `web_search`, proxying through Copilot's /responses endpoint -- the fix for
// Claude Code wired Direct, whose builtin WebSearch the Copilot host rejects.
// Server name "copilot-env" on purpose: clients namespace tools by server, so the
// tool surfaces as `mcp__copilot-env__web_search` and future tools join under the
// same name without any re-registration.
//
// stdout carries ONLY newline-delimited JSON-RPC; every log line goes to stderr
// (see redirectConsolaToStderr below).
//
// The SDK ships no root entry (its "." export points at a file that does not
// exist), so these subpath imports resolve through the package's `./*` wildcard
// export -- fine for bun/tsc, but biome's import resolver cannot follow it, so
// biome.json carries a noUnresolvedImports override scoped to this file.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
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

  // The low-level Server (not McpServer) is deliberate although 1.29 deprecates it:
  // it takes the tool input schema as a plain JSON-Schema literal, while McpServer
  // requires a zod schema -- a second direct dependency for one tool.
  const server = new Server(
    { name: MCP_SERVER_NAME, version: packageVersion() },
    { capabilities: { "tools": {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: WEB_SEARCH_TOOL,
        description:
          "Search the web via GitHub Copilot (the /responses web_search tool) and " +
          "return a concise answer with a Sources list of cited URLs.",
        inputSchema: {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "The web search query." },
          },
          "required": ["query"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Parse once at the boundary; unknown tool is a PROTOCOL error (the SDK's own
    // high-level server does the same), a bad argument is a tool-level error.
    if (request.params.name !== WEB_SEARCH_TOOL) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }
    const query = request.params.arguments?.query;
    if (typeof query !== "string" || query.trim() === "") {
      return toolError("web_search needs a non-empty string `query` argument.");
    }
    try {
      const answer = await webSearch(query, {
        profile: opts.profile,
        model: opts.model,
        // A client cancellation aborts the in-flight POST instead of letting it
        // run to its own 120s timeout.
        signal: extra.signal,
      });
      return { content: [{ type: "text", text: answer }] };
    } catch (e) {
      // Never rethrow: a failed search (no credential, HTTP error, timeout) must not
      // kill the server. The credential errors already say how to fix themselves.
      return toolError(errMessage(e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.debug(`copilot-env MCP server up (v${packageVersion()})`);

  // The stdio transport only reads stdin "data"; nothing closes the server when the
  // client goes away, so hook EOF ourselves or the process would linger forever.
  await new Promise<void>((resolve) => {
    server.onclose = resolve;
    process.stdin.on("end", () => {
      void server.close().finally(resolve);
    });
  });
}

function toolError(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}
