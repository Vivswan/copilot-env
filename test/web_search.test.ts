import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  DEFAULT_WEB_SEARCH_MODEL,
  parseResponsesOutput,
  resolveWebSearchCredential,
  webSearch,
} from "../src/copilot_api/web_search.ts";

// The credential/config stores live under COPILOT_API_HOME, and the env-token
// fallback reads the GH token env vars -- isolate both per test.
const SAVED = {
  home: process.env.COPILOT_API_HOME,
  copilotToken: process.env.COPILOT_GITHUB_TOKEN,
  ghToken: process.env.GH_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
};
let dir = "";

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("COPILOT_API_HOME", SAVED.home);
  restore("COPILOT_GITHUB_TOKEN", SAVED.copilotToken);
  restore("GH_TOKEN", SAVED.ghToken);
  restore("GITHUB_TOKEN", SAVED.githubToken);
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpHome(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-websearch-"));
  process.env.COPILOT_API_HOME = dir;
  delete process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records every call and replies with `response` (or a queue). */
function fetchStub(responses: Response[]): {
  calls: CapturedRequest[];
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
} {
  const calls: CapturedRequest[] = [];
  return {
    calls,
    fetchImpl: (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = responses.shift();
      if (next === undefined) throw new Error("fetch stub exhausted");
      return Promise.resolve(next);
    },
  };
}

function responsesFixture(): unknown {
  return {
    "output": [
      { "type": "web_search_call", "status": "completed" },
      {
        "type": "message",
        "content": [
          {
            "type": "output_text",
            "text": "Bun 1.3 shipped.",
            "annotations": [
              { "type": "url_citation", "url": "https://bun.sh/blog", "title": "Bun Blog" },
              { "type": "url_citation", "url": "https://bun.sh/blog", "title": "Bun Blog (dupe)" },
            ],
          },
          {
            "type": "output_text",
            "text": "It is faster.",
            "annotations": [{ "type": "url_citation", "url": "https://example.com/x" }],
          },
        ],
      },
    ],
  };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// --- parseResponsesOutput ----------------------------------------------------

test("parseResponsesOutput concatenates message text and appends deduped sources", () => {
  const text = parseResponsesOutput(responsesFixture());
  expect(text).toBe(
    "Bun 1.3 shipped.\nIt is faster." +
      "\n\nSources:\n- Bun Blog: https://bun.sh/blog\n- https://example.com/x",
  );
});

test("parseResponsesOutput returns plain text when there are no citations", () => {
  const body = {
    "output": [
      { "type": "message", "content": [{ "type": "output_text", "text": "plain answer" }] },
    ],
  };
  expect(parseResponsesOutput(body)).toBe("plain answer");
});

test("parseResponsesOutput throws when no message item carries text", () => {
  expect(() => parseResponsesOutput({ "output": [{ "type": "web_search_call" }] })).toThrow(
    /no answer text/,
  );
  expect(() => parseResponsesOutput({})).toThrow(/no answer text/);
});

// --- webSearch request shape -------------------------------------------------

test("webSearch POSTs the verified request shape, no integration id for a gho_ token", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  const stub = fetchStub([okJson(responsesFixture())]);

  const answer = await webSearch("bun release", { fetchImpl: stub.fetchImpl });

  expect(answer).toContain("Bun 1.3 shipped.");
  expect(stub.calls).toHaveLength(1);
  const call = stub.calls[0];
  if (call === undefined) throw new Error("unreachable");
  expect(call.url).toBe("https://api.githubcopilot.com/responses");
  expect(call.init.method).toBe("POST");
  const headers = call.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer gho_stored");
  expect(headers["Content-Type"]).toBe("application/json");
  expect(headers["Openai-Intent"]).toBe("conversation-edits");
  expect(headers["User-Agent"]).toBe("codex_exec");
  expect(headers["Copilot-Integration-Id"]).toBeUndefined();
  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  expect(body).toEqual({
    "model": DEFAULT_WEB_SEARCH_MODEL,
    "stream": false,
    "reasoning": { "effort": "low" },
    "tools": [{ "type": "web_search" }],
    "tool_choice": { "type": "web_search" }, // forced: the answer must come from a real search
    "instructions": body.instructions,
    "input": "bun release",
  });
  expect(String(body.instructions)).toContain("cite");
});

test("webSearch sends the pinned integration id without probing", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  new CopilotEnvConfig().set({ integrationId: "copilot-developer-cli" });
  const stub = fetchStub([okJson(responsesFixture())]);

  await webSearch("q", { fetchImpl: stub.fetchImpl });

  // Exactly one call: the pin skips the probe entirely.
  expect(stub.calls).toHaveLength(1);
  const headers = stub.calls[0]?.init.headers as Record<string, string>;
  expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
});

test("webSearch model precedence: explicit beats stored beats built-in default", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  new CopilotEnvConfig().set({ messageApiWebSearchModel: "stored-model" });

  const stored = fetchStub([okJson(responsesFixture())]);
  await webSearch("q", { fetchImpl: stored.fetchImpl });
  expect(JSON.parse(String(stored.calls[0]?.init.body)).model).toBe("stored-model");

  const explicit = fetchStub([okJson(responsesFixture())]);
  await webSearch("q", { fetchImpl: explicit.fetchImpl, model: "flag-model" });
  expect(JSON.parse(String(explicit.calls[0]?.init.body)).model).toBe("flag-model");
});

test("webSearch surfaces non-2xx as a legible error", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  const stub = fetchStub([
    new Response("model unsupported", { status: 400, statusText: "Bad Request" }),
  ]);

  await expect(webSearch("q", { fetchImpl: stub.fetchImpl })).rejects.toThrow(
    "POST https://api.githubcopilot.com/responses returned 400 Bad Request model unsupported",
  );
});

// --- credential resolution ---------------------------------------------------

test("resolveWebSearchCredential prefers the store over the env fallback", () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  process.env.GH_TOKEN = "gho_env";
  expect(resolveWebSearchCredential(null)).toBe("gho_stored");
});

test("resolveWebSearchCredential falls back to env ONLY when no provider is recorded", () => {
  tmpHome();
  process.env.GITHUB_TOKEN = "gho_env";
  expect(resolveWebSearchCredential(null)).toBe("gho_env");
});

test("resolveWebSearchCredential errors with a pointer when nothing resolves", () => {
  tmpHome();
  expect(() => resolveWebSearchCredential(null)).toThrow(
    /run `agent auth` to log in or set GH_TOKEN/,
  );
});

test("a named profile hard-fails instead of using the default credential or env", () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_default");
  process.env.GH_TOKEN = "gho_env";
  expect(() => resolveWebSearchCredential("work")).toThrow(
    /never falls back to the default credential/,
  );
});

test("a huge upstream error body is capped before it reaches the tool error", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  const stub = fetchStub([
    new Response("x".repeat(5000), { status: 502, statusText: "Bad Gateway" }),
  ]);

  let message = "";
  try {
    await webSearch("q", { fetchImpl: stub.fetchImpl });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("502 Bad Gateway");
  expect(message.length).toBeLessThan(800);
  expect(message.endsWith("...")).toBe(true);
});

test("a cancelled call stops waiting for a cold PAT probe instead of sitting it out", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "ghp_forces_a_probe");
  // A probe fetch that never resolves: without the abort race the call would hang.
  const neverFetch = () => new Promise<Response>(() => {});

  // Rejects promptly (the probe fetch never resolves, so anything other than the
  // abort race would hang past the test timeout), preserving the caller's reason --
  // MCP cancellations carry a plain string.
  const plain = new AbortController();
  plain.abort();
  await expect(webSearch("q", { fetchImpl: neverFetch, signal: plain.signal })).rejects.toThrow(
    /aborted|cancelled/i,
  );
  const reasoned = new AbortController();
  reasoned.abort("client went away");
  await expect(webSearch("q", { fetchImpl: neverFetch, signal: reasoned.signal })).rejects.toThrow(
    "web_search was cancelled: client went away",
  );
});
