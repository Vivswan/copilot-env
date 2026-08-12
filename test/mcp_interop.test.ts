// Interop: real MCP client libraries driving the real spawned `agent mcp --serve`
// process across the stdio boundary. Two eras, two clients:
//  - the v1 monolith SDK client (the same client library Claude Code embeds)
//    speaks the legacy `initialize` handshake;
//  - the v2 client pinned to 2026-07-28 must negotiate the modern era outright --
//    a pin forbids the silent legacy fallback, so a passing test proves the
//    modern path rather than a downgrade.
// Both transports spawn the server process themselves, so client and server
// objects never share a process.

import { join } from "node:path";

import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { StdioClientTransport as StdioTransportV2 } from "@modelcontextprotocol/client/stdio";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as StdioTransportV1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanupTmpDirs, mcpEnv } from "./helpers/mcp.ts";
import { denoRunArgs, ROOT } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

afterEach(cleanupTmpDirs);

/** Spawn parameters shared by both transports (their option shapes coincide). */
function serverParams() {
  return {
    command: Deno.execPath(),
    args: [...denoRunArgs(), join(ROOT, "src", "cli.ts"), "mcp", "--serve"],
    env: mcpEnv(),
    stderr: "pipe" as const,
  };
}

const WEB_SEARCH_INPUT_SCHEMA = {
  "type": "object" as const,
  "properties": { "query": { "type": "string", "description": "The web search query." } },
  "required": ["query"],
};

/** New wire output of the v2 port; without this assertion its removal would be silent. */
const WEB_SEARCH_ANNOTATIONS = { "readOnlyHint": true, "openWorldHint": true };

interface ToolCallView {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

test(
  "legacy era: the v1 SDK client lists web_search and gets the no-credential tool error",
  async () => {
    const client = new ClientV1({ name: "copilot-env-interop-v1", version: "0.0.0" });
    try {
      await client.connect(new StdioTransportV1(serverParams()));
      expect(client.getServerVersion()?.name).toBe("copilot-env");

      const { tools } = await client.listTools();
      expect(tools.map((t: { name: string }) => t.name)).toEqual(["web_search"]);
      expect(tools[0]?.inputSchema).toEqual(WEB_SEARCH_INPUT_SCHEMA);
      expect(tools[0]?.annotations).toEqual(WEB_SEARCH_ANNOTATIONS);

      // v1's callTool return is a union with the pre-2024 compatibility shape;
      // this server speaks the current shape, so view it structurally.
      const res = (await client.callTool({
        "name": "web_search",
        "arguments": { "query": "anything" },
      })) as ToolCallView;
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("agent auth");
    } finally {
      await client.close();
    }
  },
  20_000,
);

test(
  "modern era: the v2 client pinned to 2026-07-28 negotiates it and drives the same tool",
  async () => {
    const client = new ClientV2(
      { name: "copilot-env-interop-v2", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(new StdioTransportV2(serverParams()));
      // The pin makes connect() fail loudly unless server/discover offered exactly
      // this revision; assert the negotiated outcome anyway so a future SDK default
      // change cannot quietly turn this into a legacy test.
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

      const { tools } = await client.listTools();
      expect(tools.map((t: { name: string }) => t.name)).toEqual(["web_search"]);
      expect(tools[0]?.inputSchema).toEqual(WEB_SEARCH_INPUT_SCHEMA);
      expect(tools[0]?.annotations).toEqual(WEB_SEARCH_ANNOTATIONS);

      const res = (await client.callTool({
        "name": "web_search",
        "arguments": { "query": "anything" },
      })) as ToolCallView;
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("agent auth");
    } finally {
      await client.close();
    }
  },
  20_000,
);
