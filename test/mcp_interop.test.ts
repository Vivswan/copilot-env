// Real MCP client libraries drive the real spawned `agent profile mcp --serve` process over stdio, so
// client and server never share a process.
//   v1 monolith SDK client (what Claude Code embeds)  -> the legacy `initialize` handshake
//   v2 client pinned to 2026-07-28                    -> the modern era outright; the pin forbids the silent legacy fallback

import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { StdioClientTransport as StdioTransportV2 } from "@modelcontextprotocol/client/stdio";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as StdioTransportV1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanupTmpDirs, mcpEnv } from "./helpers/mcp.ts";
import { CLI_ENTRY, denoRunArgs } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

afterEach(cleanupTmpDirs);

/** Spawn parameters shared by both transports (their option shapes coincide). */
function serverParams() {
  return {
    command: Deno.execPath(),
    args: [...denoRunArgs(), CLI_ENTRY, "profile", "mcp", "--serve"],
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

/** What the shared body needs of a client, whichever era's library built it. */
interface InteropClient {
  listTools(): Promise<{ tools: { name: string; inputSchema?: unknown; annotations?: unknown }[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

/** Connects, then runs that era's negotiation asserts; a failed connect or assert still closes
 *  the client (and with it the stdio server the transport spawned). */
async function connected<T, C extends InteropClient & { connect(transport: T): Promise<void> }>(
  client: C,
  transport: T,
  negotiated: (client: C) => void,
): Promise<C> {
  try {
    await client.connect(transport);
    negotiated(client);
  } catch (e) {
    await client.close();
    throw e;
  }
  return client;
}

/** One row per client era: connect() performs that era's handshake and its own negotiation asserts. */
const eras: { era: string; connect: () => Promise<InteropClient> }[] = [
  {
    era: "legacy: the v1 SDK client",
    connect: () =>
      connected(
        new ClientV1({ name: "copilot-env-interop-v1", version: "0.0.0" }),
        new StdioTransportV1(serverParams()),
        (client) => expect(client.getServerVersion()?.name).toBe("copilot-env"),
      ),
  },
  {
    era: "modern: the v2 client pinned to 2026-07-28",
    connect: () =>
      connected(
        new ClientV2(
          { name: "copilot-env-interop-v2", version: "0.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        ),
        new StdioTransportV2(serverParams()),
        (client) => {
          // The pin makes connect() fail loudly unless the server offered exactly this revision;
          // asserted anyway so a future SDK default change cannot quietly make this a legacy test.
          expect(client.getProtocolEra()).toBe("modern");
          expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
        },
      ),
  },
];

for (const { era, connect } of eras) {
  test(
    `${era} lists web_search and gets the no-credential tool error`,
    async () => {
      const client = await connect();
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(["web_search"]);
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
}
