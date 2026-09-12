// The one MCP harness for every stdio-server suite: a credential env var scrubbed here is
// scrubbed for all of them, so no test can pick up an ambient credential and reach the network.
import { join } from "node:path";
import { denoRunArgs, ROOT, spawnChild } from "./run.ts";
import { expect, removeDir, tempDir } from "./testing.ts";

let dirs: string[] = [];

/** Remove every temp dir handed out since the last call; suites call this in afterEach. */
export function cleanupTmpDirs(): void {
  for (const d of dirs) removeDir(d);
  dirs = [];
}

function mcpTempDir(tag: string): string {
  const d = tempDir(`copilot-mcp-${tag}-`);
  dirs.push(d);
  return d;
}

export function mcpEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Hermetic stores + no ambient credential: the no-credential tool error is the point.
  env.COPILOT_API_HOME = mcpTempDir("home");
  env.CLAUDE_CONFIG_DIR = mcpTempDir("claude");
  env.CONSOLA_LEVEL = "5"; // consola self-silences under test otherwise
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Drives the server over newline-delimited JSON-RPC: the stdio MCP framing has no
 *  Content-Length headers. */
export class McpClient {
  private readonly proc: Deno.ChildProcess;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private exit: number | null = null;
  private buffer = "";
  readonly stdoutLines: string[] = [];

  constructor(args: string[] = []) {
    // clearEnv matters: mcpEnv() scrubs the credential trio by DELETING keys, and
    // Deno.Command merges `env` over the inherited environment by default, which
    // would quietly restore an ambient GH_TOKEN.
    this.proc = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), join(ROOT, "src", "cli.ts"), "mcp", "--serve", ...args],
      cwd: ROOT,
      clearEnv: true,
      env: mcpEnv(),
      stdin: "piped",
      stdout: "piped",
      // An unread deno pipe would backpressure a chatty server into a deadlock.
      stderr: "null",
    });
    this.reader = this.proc.stdout.getReader();
    this.writer = this.proc.stdin.getWriter();
    this.proc.status.then((status) => {
      this.exit = status.code;
    });
  }

  /** null while the process is still running. */
  get exitCode(): number | null {
    return this.exit;
  }

  sendRaw(line: string | Uint8Array): void {
    const bytes = typeof line === "string" ? this.encoder.encode(line) : line;
    const payload = new Uint8Array(bytes.length + 1);
    payload.set(bytes);
    payload[bytes.length] = 0x0a;
    // Fire-and-forget: the writer queues in order, and a write refused by an
    // already-exited server surfaces on the read side, not here.
    this.writer.write(payload).catch(() => {});
  }

  private send(msg: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify(msg));
  }

  async request(id: number | string, method: string, params?: unknown): Promise<JsonRpcMessage> {
    this.send({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    return await this.waitFor(id);
  }

  async waitFor(id: number | string): Promise<JsonRpcMessage> {
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
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for a server response");
      // Race the read against the deadline: a live-but-silent server must fail
      // fast here, not wait out the whole per-test timeout on a blocked read.
      const chunk = await this.readWithTimeout(remaining);
      if (chunk.done) throw new Error("server stdout closed early");
      this.buffer += this.decoder.decode(chunk.value);
    }
  }

  private async readWithTimeout(ms: number): Promise<{ done: boolean; value?: Uint8Array }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("server is alive but silent: no stdout within the deadline")),
        ms,
      );
    });
    try {
      return await Promise.race([this.reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A client disconnect, as the server sees it. */
  async closeAndWait(): Promise<number> {
    await this.writer.close().catch(() => {});
    return (await this.proc.status).code;
  }

  kill(): void {
    this.proc.kill();
  }
}

/** Error responses pass; a corrupted frame fails. Only lines a request consumed are recorded,
 *  so output after the last awaited response is never checked. */
export function expectStdoutPurity(client: McpClient): void {
  for (const line of client.stdoutLines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
}
