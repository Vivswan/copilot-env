import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consola } from "consola";

import { redirectConsolaToStderr } from "../src/utils/logger.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `copilot-mcp-${tag}-`));
  dirs.push(d);
  return d;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Drive the spawned server over NEWLINE-DELIMITED JSON-RPC (the stdio MCP framing --
 *  no Content-Length headers), collecting every stdout line for purity checks. */
class McpClient {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly decoder = new TextDecoder();
  // Structural reader type: Bun and node:stream/web disagree on the full
  // ReadableStreamDefaultReader shape; read() is all this driver needs.
  private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  private buffer = "";
  readonly stdoutLines: string[] = [];

  constructor(args: string[] = []) {
    this.proc = Bun.spawn(["bun", "src/cli.ts", "mcp", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: mcpEnv(),
    });
    this.reader = this.proc.stdout.getReader();
  }

  private send(msg: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    this.proc.stdin.flush();
  }

  /** Send a request and read messages until its response arrives. */
  async request(id: number, method: string, params?: unknown): Promise<JsonRpcMessage> {
    this.send({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const line = await this.nextLine(deadline);
      const msg = JSON.parse(line) as JsonRpcMessage;
      if (msg.id === id) return msg;
    }
  }

  notify(method: string): void {
    this.send({ "jsonrpc": "2.0", "method": method });
  }

  private async nextLine(deadline: number): Promise<string> {
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        this.stdoutLines.push(line);
        return line;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for a server response");
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error("server stdout closed early");
      this.buffer += this.decoder.decode(chunk.value);
    }
  }

  /** Close stdin (client disconnect) and wait for the process to exit. */
  async closeAndWait(): Promise<number> {
    this.proc.stdin.end();
    return await this.proc.exited;
  }

  kill(): void {
    this.proc.kill();
  }
}

function mcpEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  // Hermetic stores + no ambient credential: the no-credential tool error is the point.
  env.COPILOT_API_HOME = tmpDir("home");
  env.CLAUDE_CONFIG_DIR = tmpDir("claude");
  env.CONSOLA_LEVEL = "5"; // consola self-silences under test otherwise
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

async function initialized(client: McpClient): Promise<JsonRpcMessage> {
  const res = await client.request(1, "initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "copilot-env-test", "version": "0.0.0" },
  });
  client.notify("notifications/initialized");
  return res;
}

test("handshake: initialize + tools/list expose web_search; stdout stays pure JSON; EOF exits", async () => {
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
}, 20_000);

test("tools/call: no credential -> isError pointing at agent auth; unknown tool -> protocol error; bad query -> isError", async () => {
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
}, 20_000);

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
