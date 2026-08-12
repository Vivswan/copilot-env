// Shared harness for the MCP stdio server suites (mcp_server, mcp_interop,
// mcp_fuzz): ONE hermetic environment builder and ONE wire-level client.
// The consolidation is the point -- a credential env var scrubbed here is
// scrubbed for every suite, so no test can silently pick up an ambient
// credential and start making real network calls.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denoRunArgs, ROOT } from "./run.ts";
import { expect } from "./testing.ts";

let dirs: string[] = [];

/** Remove every temp dir handed out since the last call; suites call this in afterEach. */
export function cleanupTmpDirs(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
}

export function tmpDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `copilot-mcp-${tag}-`));
  dirs.push(d);
  return d;
}

export function mcpEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Hermetic stores + no ambient credential: the no-credential tool error is the point.
  env.COPILOT_API_HOME = tmpDir("home");
  env.CLAUDE_CONFIG_DIR = tmpDir("claude");
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

/** Drive the spawned server over NEWLINE-DELIMITED JSON-RPC (the stdio MCP framing --
 *  no Content-Length headers), collecting every stdout line for purity checks. */
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
    this.proc = new Deno.Command(Deno.execPath(), {
      args: [...denoRunArgs(), join(ROOT, "src", "cli.ts"), "mcp", "--serve", ...args],
      cwd: ROOT,
      clearEnv: true,
      env: mcpEnv(),
      stdin: "piped",
      stdout: "piped",
      // Discarded, matching the old pipe-and-never-read: an unread deno pipe would
      // backpressure a chatty server into a deadlock instead.
      stderr: "null",
    }).spawn();
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

  /** Write one raw line (or raw bytes) plus the newline straight onto stdin. */
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

  /** Send a request and read messages until its response arrives. */
  async request(id: number | string, method: string, params?: unknown): Promise<JsonRpcMessage> {
    this.send({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    return await this.waitFor(id);
  }

  /** Read messages until the response with the given id arrives. */
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

  /** Close stdin (client disconnect) and wait for the process to exit. */
  async closeAndWait(): Promise<number> {
    await this.writer.close().catch(() => {});
    return (await this.proc.status).code;
  }

  kill(): void {
    this.proc.kill();
  }
}

/** Every stdout line the client read this session must parse as JSON --
 *  error responses are fine, corrupted frames are not. (Only lines a
 *  request/waitFor actually consumed are recorded; the harness never sees
 *  output the server might emit after the last awaited response.) */
export function expectStdoutPurity(client: McpClient): void {
  for (const line of client.stdoutLines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
}
