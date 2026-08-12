import { consola } from "consola";
import { redirectConsolaToStderr } from "../src/utils/logger.ts";
import { cleanupTmpDirs, type JsonRpcMessage, McpClient } from "./helpers/mcp.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

afterEach(cleanupTmpDirs);

async function initialized(client: McpClient): Promise<JsonRpcMessage> {
  const res = await client.request(1, "initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "copilot-env-test", "version": "0.0.0" },
  });
  client.notify("notifications/initialized");
  return res;
}

test(
  "handshake: initialize + tools/list expose web_search; stdout stays pure JSON; EOF exits",
  async () => {
    const client = new McpClient();
    try {
      const init = await initialized(client);
      const serverInfo = (init.result as { serverInfo?: { name?: string } }).serverInfo;
      expect(serverInfo?.name).toBe("copilot-env");

      const list = await client.request(2, "tools/list");
      const tools = (list.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
      expect(tools.map((t) => t.name)).toEqual(["web_search"]);
      expect(tools[0]?.inputSchema).toEqual({
        "type": "object",
        "properties": { "query": { "type": "string", "description": "The web search query." } },
        "required": ["query"],
      });

      // Every stdout line of the whole session must be JSON-RPC (nothing may leak).
      for (const line of client.stdoutLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } catch (e) {
      client.kill();
      throw e;
    }
    expect(await client.closeAndWait()).toBe(0);
  },
  20_000,
);

test(
  "tools/call: no credential -> isError pointing at agent auth; unknown tool -> protocol error; bad query -> isError",
  async () => {
    const client = new McpClient();
    try {
      await initialized(client);

      const noCred = await client.request(3, "tools/call", {
        "name": "web_search",
        "arguments": { "query": "anything" },
      });
      const noCredResult = noCred.result as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      expect(noCredResult.isError).toBe(true);
      expect(noCredResult.content[0]?.text).toContain("agent auth");

      const unknown = await client.request(4, "tools/call", {
        "name": "nope",
        "arguments": {},
      });
      expect(unknown.result).toBeUndefined();
      expect(unknown.error?.message).toContain("not found");

      const badQuery = await client.request(5, "tools/call", {
        "name": "web_search",
        "arguments": { "query": "   " },
      });
      const badQueryResult = badQuery.result as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      expect(badQueryResult.isError).toBe(true);
      expect(badQueryResult.content[0]?.text).toContain("query");

      for (const line of client.stdoutLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } catch (e) {
      client.kill();
      throw e;
    }
    expect(await client.closeAndWait()).toBe(0);
  },
  20_000,
);

test("a named profile without a credential hard-fails per call, never falling back", async () => {
  const client = new McpClient(["--profile", "work"]);
  try {
    await initialized(client);
    const res = await client.request(3, "tools/call", {
      "name": "web_search",
      "arguments": { "query": "anything" },
    });
    const result = res.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("never falls back to the default credential");
  } catch (e) {
    client.kill();
    throw e;
  }
  expect(await client.closeAndWait()).toBe(0);
}, 20_000);

test("redirectConsolaToStderr moves global consola info lines off stdout", () => {
  const savedStdout = consola.options.stdout;
  const savedLevel = consola.level;
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array) => {
    out.push(String(s));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array) => {
    err.push(String(s));
    return true;
  };
  try {
    consola.level = 3; // ensure info is not self-silenced under bun test
    redirectConsolaToStderr();
    consola.info("narration that must not corrupt the JSON-RPC stream");
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    consola.options.stdout = savedStdout;
    consola.level = savedLevel;
  }
  expect(out).toEqual([]);
  expect(err.join("")).toContain("narration that must not corrupt");
});
