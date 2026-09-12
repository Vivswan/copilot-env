// The corpus hammers serveStdio's opening-exchange classifier with malformed input; nothing here
// closes the transport, so categories share one server. The assertions pin LESS than the server
// does today: for garbage a spec-shaped error and a silent drop are both acceptable (an SDK patch
// may trade one for the other), and exact codes are pinned only where the JSON-RPC spec mandates
// them.
//
// invalid JSON, raw bytes, non-JSON-RPC values, early responses, id:null  -> dropped silently
// malformed _meta envelope claim                                          -> -32602 InvalidParams
// unsupported revision claim                                              -> error response, code unpinned
// unknown method with a valid id                                          -> -32601 MethodNotFound
// ~1MB request (under the transport's 10MB buffer)                        -> answered normally

import {
  cleanupTmpDirs,
  expectStdoutPurity,
  type JsonRpcMessage,
  McpClient,
} from "./helpers/mcp.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

afterEach(cleanupTmpDirs);

/** Fixed seed: every run generates the identical corpus. Bump only on purpose. */
const FUZZ_SEED = 271828183;

/** xorshift32 -- tiny deterministic PRNG; NEVER Math.random/Date.now here. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/** Printable-ASCII line noise; the pool cannot spell "jsonrpc" by construction. */
function garbageLine(rnd: () => number): string {
  const pool = "abcdefghXYZ0123456789 {}[]:,\"'<>!@#$%^&*()_+-=\\|;.?";
  const len = 1 + Math.floor(rnd() * 40);
  let s = "";
  for (let i = 0; i < len; i++) s += pool[Math.floor(rnd() * pool.length)];
  return s;
}

function generatedCorpus(rnd: () => number, count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const pick = Math.floor(rnd() * 4);
    if (pick === 0) {
      lines.push(garbageLine(rnd));
    } else if (pick === 1) {
      const whole = JSON.stringify({ "key": garbageLine(rnd), "n": Math.floor(rnd() * 1e6) });
      lines.push(whole.slice(0, 1 + Math.floor(rnd() * (whole.length - 2))));
    } else if (pick === 2) {
      lines.push(JSON.stringify([Math.floor(rnd() * 100), garbageLine(rnd)]));
    } else {
      lines.push(JSON.stringify({ "method": garbageLine(rnd), "id": Math.floor(rnd() * 100) }));
    }
  }
  return lines;
}

/** Bytes forming no valid UTF-8 sequence. */
function binaryGarbage(): Uint8Array {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 128) % 256 || 1;
  return bytes;
}

function envelopeProbe(id: number, meta: Record<string, unknown>): string {
  const params = { "_meta": meta };
  return JSON.stringify({ "jsonrpc": "2.0", "id": id, "method": "tools/list", "params": params });
}

function classifierCorpus(): string[] {
  return [
    JSON.stringify({ "jsonrpc": "2.0", "id": 99, "result": {} }),
    envelopeProbe(101, { [PROTOCOL_VERSION_KEY]: "2026-07-28" }),
    envelopeProbe(102, { [PROTOCOL_VERSION_KEY]: 12345, [CLIENT_CAPABILITIES_KEY]: {} }),
    envelopeProbe(103, { [PROTOCOL_VERSION_KEY]: "2099-01-01", [CLIENT_CAPABILITIES_KEY]: {} }),
    JSON.stringify({ "jsonrpc": "2.0", "id": null, "method": "whatever" }),
    JSON.stringify({ "jsonrpc": "2.0", "method": "totally/unknown" }),
    JSON.stringify({ "jsonrpc": "2.0", "id": "str-1", "method": "no/such/method" }),
  ];
}

async function expectFullRecovery(client: McpClient): Promise<void> {
  const init = await client.request(1001, "initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "copilot-env-fuzz", "version": "0.0.0" },
  });
  const serverInfo = (init.result as { serverInfo?: { name?: string } }).serverInfo;
  expect(serverInfo?.name).toBe("copilot-env");
  client.notify("notifications/initialized");

  const list = await client.request(1002, "tools/list");
  const tools = (list.result as { tools: { name: string }[] }).tools;
  expect(tools.map((t) => t.name)).toEqual(["web_search"]);

  const call = await client.request(1003, "tools/call", {
    "name": "web_search",
    "arguments": { "query": "anything" },
  });
  const result = call.result as { isError?: boolean; content: { text: string }[] };
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("agent auth");
}

function isErrorResponse(msg: JsonRpcMessage): boolean {
  return (
    msg.jsonrpc === "2.0" &&
    msg.result === undefined &&
    typeof msg.error?.code === "number" &&
    typeof msg.error.message === "string"
  );
}

// Garbage may draw a spec-shaped error or nothing; a result for a request we never sent is the one
// unacceptable answer.
function expectNoUnsolicitedResults(client: McpClient, knownIds: (number | string)[]): void {
  for (const line of client.stdoutLines) {
    const msg = JSON.parse(line) as JsonRpcMessage;
    if (msg.id !== undefined && msg.id !== null && knownIds.includes(msg.id)) continue;
    if (msg.id === undefined && msg.method !== undefined) continue;
    expect(isErrorResponse(msg)).toBe(true);
  }
}

test(
  "opening classifier: bad envelopes and early responses get the documented answers, era stays unpinned",
  async () => {
    const client = new McpClient();
    try {
      for (const line of classifierCorpus()) client.sendRaw(line);

      // Processing is serial, so these arriving proves every earlier line was consumed. The
      // unsupported-revision code is the SDK's choice, so only the error shape is pinned there.
      const badEnvelope = await client.waitFor(101);
      expect(badEnvelope.error?.code).toBe(-32602);

      const nonStringClaim = await client.waitFor(102);
      expect(nonStringClaim.error?.code).toBe(-32602);

      const unsupported = await client.waitFor(103);
      expect(isErrorResponse(unsupported)).toBe(true);

      const unknownMethod = await client.waitFor("str-1");
      expect(unknownMethod.error?.code).toBe(-32601);

      expect(client.exitCode).toBeNull();
      await expectFullRecovery(client);

      // The early response (id 99) and the null-id request may be dropped or refused, never answered.
      expectNoUnsolicitedResults(client, [101, 102, 103, "str-1", 1001, 1002, 1003]);
      expectStdoutPurity(client);
    } catch (e) {
      client.kill();
      throw e;
    }
    expect(await client.closeAndWait()).toBe(0);
  },
  20_000,
);

test(
  "line noise: raw bytes, invalid JSON, and non-JSON-RPC values are dropped without a reply",
  async () => {
    const rnd = makePrng(FUZZ_SEED);
    const client = new McpClient();
    try {
      client.sendRaw(binaryGarbage());
      for (const line of ["not json at all", '{"truncated": ', "[1,2,3]", "42", '"bare"']) {
        client.sendRaw(line);
      }
      for (const line of generatedCorpus(rnd, 50)) client.sendRaw(line);

      expect(client.exitCode).toBeNull();
      await expectFullRecovery(client);

      expectNoUnsolicitedResults(client, [1001, 1002, 1003]);
      expectStdoutPurity(client);
    } catch (e) {
      client.kill();
      throw e;
    }
    expect(await client.closeAndWait()).toBe(0);
  },
  20_000,
);

test("a ~1MB request (under the 10MB transport buffer) is answered normally", async () => {
  const client = new McpClient();
  try {
    const big = await client.request("big-1", "no/such/method", { "blob": "x".repeat(1_000_000) });
    expect(big.error?.code).toBe(-32601);

    expect(client.exitCode).toBeNull();
    await expectFullRecovery(client);
    expectStdoutPurity(client);
  } catch (e) {
    client.kill();
    throw e;
  }
  expect(await client.closeAndWait()).toBe(0);
}, 20_000);

test("interleaved corpus in seeded-shuffle order: the server survives and recovers", async () => {
  const rnd = makePrng(FUZZ_SEED ^ 0x5f5f5f5f);
  const corpus = [
    ...classifierCorpus(),
    "not json at all",
    '{"truncated": ',
    "[1,2,3]",
    "42",
    '"bare"',
    '{"foo":"bar"}',
    ...generatedCorpus(rnd, 30),
  ];
  // Fisher-Yates on the seeded PRNG: a fixed but arbitrary interleaving.
  for (let i = corpus.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = corpus[i] as string;
    corpus[i] = corpus[j] as string;
    corpus[j] = a;
  }

  const client = new McpClient();
  try {
    for (const line of corpus) client.sendRaw(line);
    // The answered classifier probes may arrive in any order relative to the
    // shuffle; waiting on the unknown-method probe drains everything before it.
    await client.waitFor("str-1");

    expect(client.exitCode).toBeNull();
    await expectFullRecovery(client);
    expectStdoutPurity(client);
  } catch (e) {
    client.kill();
    throw e;
  }
  expect(await client.closeAndWait()).toBe(0);
}, 20_000);
