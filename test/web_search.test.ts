import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import {
  CODEX_EXEC_USER_AGENT,
  directClientHeaders,
  resetIntegrationIdentityCache,
} from "../src/copilot_api/integration_identity.ts";
import { generateAliases, parseCatalogModels } from "../src/copilot_api/models.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import {
  DEFAULT_WEB_SEARCH_MODEL,
  parseResponsesOutput,
  resetWebSearchAliasCache,
  resolveWebSearchCredential,
  webSearch,
} from "../src/copilot_api/web_search.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

// The credential/config stores live under COPILOT_API_HOME, and the env-token
// fallback reads the GH token env vars -- isolate both per test (isolateProxyHome
// clears the token trio).
const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function tmpHome(): void {
  dir = isolateProxyHome("copilot-websearch-");
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

/** What `copilot-host auto` sees first: GET /models on the generic host under the identity the
 *  request will carry; a 2xx keeps that host. */
function hostProbeOk(): Response {
  return okJson({ data: [] });
}

// --- parseResponsesOutput ----------------------------------------------------

test("parseResponsesOutput: message text concatenated with deduped sources appended, plain text without citations, a throw when no message item carries text", () => {
  const cases: { name: string; body: unknown; text?: string; throws?: RegExp }[] = [
    {
      name: "citations",
      body: responsesFixture(),
      text: "Bun 1.3 shipped.\nIt is faster." +
        "\n\nSources:\n- Bun Blog: https://bun.sh/blog\n- https://example.com/x",
    },
    {
      name: "no citations",
      body: {
        "output": [
          { "type": "message", "content": [{ "type": "output_text", "text": "plain answer" }] },
        ],
      },
      text: "plain answer",
    },
    {
      name: "no message item",
      body: { "output": [{ "type": "web_search_call" }] },
      throws: /no answer text/,
    },
    { name: "no output at all", body: {}, throws: /no answer text/ },
  ];
  for (const c of cases) {
    if (c.throws !== undefined) {
      expect(() => parseResponsesOutput(c.body), c.name).toThrow(c.throws);
    } else expect(parseResponsesOutput(c.body), c.name).toBe(c.text);
  }
});

// --- webSearch request shape -------------------------------------------------

test("webSearch POSTs the verified request shape, no integration id for a gho_ token", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  const stub = fetchStub([hostProbeOk(), hostProbeOk(), okJson(responsesFixture())]);

  const answer = await webSearch("bun release", { fetchImpl: stub.fetchImpl });

  expect(answer).toContain("Bun 1.3 shipped.");
  // The identity probe (the codex identity accepted first) and the host probe (the same headers,
  // the generic host) precede the one POST.
  expect(stub.calls.map((c) => c.url)).toEqual([MODELS_URL, MODELS_URL, RESPONSES_URL]);
  const call = stub.calls[2];
  if (call === undefined) throw new Error("unreachable");
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

test("webSearch: a host `auto` moved to re-selects the identity there before the POST", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "github_pat_x");
  // The generic host 403s everything; the account's host accepts the CLI id alone. The POST must
  // go to the moved host under the id it accepts, never the generic host's default answer.
  const enterprise = "https://api.enterprise.githubcopilot.com";
  const posts: { url: string; id: string | null }[] = [];
  const answer = await webSearch("q", {
    fetchImpl: (input, init) => {
      const url = String(input);
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(
          new Response(JSON.stringify({ endpoints: { api: enterprise } }), { status: 200 }),
        );
      }
      if (new URL(url).origin !== enterprise) {
        return Promise.resolve(new Response("forbidden", { status: 403 }));
      }
      const id = new Headers(init?.headers).get("Copilot-Integration-Id");
      if (init?.method === "POST") posts.push({ url, id });
      if (id !== "copilot-developer-cli") {
        return Promise.resolve(new Response("PATs not supported", { status: 400 }));
      }
      return Promise.resolve(
        init?.method === "POST" ? okJson(responsesFixture()) : okJson({ data: [] }),
      );
    },
  });
  expect(answer).toContain("Bun 1.3 shipped.");
  expect(posts).toEqual([{ url: `${enterprise}/responses`, id: "copilot-developer-cli" }]);
});

test("webSearch sends the pinned integration id without probing", async () => {
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  new CopilotEnvConfig().setProfile(null, { identity: "copilot-developer-cli" });
  const stub = fetchStub([hostProbeOk(), okJson(responsesFixture())]);

  await webSearch("q", { fetchImpl: stub.fetchImpl });

  // The pin skips the identity probe; the host probe stays, and it already carries the pin.
  expect(stub.calls.map((c) => c.url)).toEqual([MODELS_URL, RESPONSES_URL]);
  for (const call of stub.calls) {
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
  }
});

/** A raw direct-catalog body for the alias-resolution tests. */
function catalogFixture(): unknown {
  return {
    "data": [{ "id": "gpt-6" }, { "id": "gpt-6-mini" }, { "id": "claude-fable-5" }],
  };
}

const MODELS_URL = "https://api.githubcopilot.com/models";
const RESPONSES_URL = "https://api.githubcopilot.com/responses";

test("webSearch model resolution: the flag beats the stored key, aliases resolve against the live catalog (asked under the request's identity), an unknown value or a failed catalog fetch passes the raw value through", async () => {
  // A configured model (flag or stored key) consults the live catalog first for alias resolution
  // (the proxy's semantics); the catalog fetch reuses the selected pair, so the probes are the
  // identity's and the host's alone, and a failed fetch is best-effort: the raw value goes out.
  const cases: {
    name: string;
    stored?: string;
    flag?: string;
    catalog: () => Response;
    model: string;
  }[] = [
    {
      name: "stored unknown value passes through",
      stored: "stored-model",
      catalog: () => okJson(catalogFixture()),
      model: "stored-model",
    },
    {
      name: "the flag beats the stored key",
      stored: "stored-model",
      flag: "flag-model",
      catalog: () => okJson(catalogFixture()),
      model: "flag-model",
    },
    {
      name: "a stored alias resolves",
      stored: "gpt-latest",
      catalog: () => okJson(catalogFixture()),
      model: "gpt-6",
    },
    {
      name: "a flag alias resolves",
      flag: "claude-latest",
      catalog: () => okJson(catalogFixture()),
      model: "claude-fable-5",
    },
    {
      name: "a failed catalog fetch sends the raw value",
      stored: "gpt-latest",
      catalog: () => new Response("nope", { status: 500, statusText: "Internal Server Error" }),
      model: "gpt-latest",
    },
    {
      name: "an exact catalog id passes through unchanged",
      flag: "gpt-6",
      catalog: () => okJson(catalogFixture()),
      model: "gpt-6",
    },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    tmpHome();
    new Credential(undefined, null).store("gh-token", "gho_stored");
    if (c.stored !== undefined) {
      new CopilotEnvConfig().set({ "proxy.message-websearch-model": c.stored });
    }
    const stub = fetchStub([hostProbeOk(), hostProbeOk(), c.catalog(), okJson(responsesFixture())]);

    const answer = await webSearch("q", { fetchImpl: stub.fetchImpl, model: c.flag });

    expect(answer, c.name).toContain("Bun 1.3 shipped.");
    // After the two probes: the catalog GET, asked under the SAME identity the /responses call
    // sends (Copilot gates the list per identity), then the POST.
    expect(stub.calls.map((call) => call.url), c.name).toEqual([
      MODELS_URL,
      MODELS_URL,
      MODELS_URL,
      RESPONSES_URL,
    ]);
    expect(stub.calls[2]?.init.headers, c.name).toEqual({
      ...directClientHeaders(CODEX_EXEC_USER_AGENT),
      Authorization: "Bearer gho_stored",
    });
    expect(JSON.parse(String(stub.calls[3]?.init.body)).model, c.name).toBe(c.model);
  }
});

test("the alias catalog is memoized per token, and a failed fetch is retried", async () => {
  // The injected-fetchImpl seam bypasses the memo, so this test stubs the GLOBAL
  // fetch to exercise the memo itself: failure eviction (a rejected catalog fetch
  // must not stick) and the single shared fetch across subsequent calls.
  tmpHome();
  new Credential(undefined, null).store("gh-token", "gho_stored");
  new CopilotEnvConfig().set({ "proxy.message-websearch-model": "gpt-latest" });
  const responses = [
    hostProbeOk(), // the host probe, memoized for the two calls after
    new Response("nope", { status: 500, statusText: "Internal Server Error" }), // catalog: fails
    okJson(responsesFixture()), // POST 1 (raw pass-through)
    okJson(catalogFixture()), // catalog: retried after eviction
    okJson(responsesFixture()), // POST 2 (resolved)
    okJson(responsesFixture()), // POST 3 (memo hit: no catalog call)
  ];
  const calls: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  resetWebSearchAliasCache();
  resetIntegrationIdentityCache();
  try {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = responses.shift();
      if (next === undefined) throw new Error("global fetch stub exhausted");
      return Promise.resolve(next);
    }) as typeof fetch;
    await webSearch("q");
    await webSearch("q");
    await webSearch("q");
  } finally {
    globalThis.fetch = realFetch;
    resetWebSearchAliasCache();
    resetIntegrationIdentityCache();
  }
  expect(calls.filter((c) => c.url === MODELS_URL)).toHaveLength(3);
  const posts = calls.filter((c) => c.url === RESPONSES_URL);
  expect(posts.map((c) => JSON.parse(String(c.init.body)).model)).toEqual([
    "gpt-latest",
    "gpt-6",
    "gpt-6",
  ]);
});

test("webSearch surfaces a non-2xx as a legible error naming the request, and caps a huge upstream body before it reaches the tool error", async () => {
  const cases: { name: string; response: () => Response; check: (message: string) => void }[] = [
    {
      name: "400 with a short body",
      response: () => new Response("model unsupported", { status: 400, statusText: "Bad Request" }),
      check: (message) =>
        expect(message).toBe(
          "POST https://api.githubcopilot.com/responses returned 400 Bad Request model unsupported",
        ),
    },
    {
      name: "502 with a huge body",
      response: () => new Response("x".repeat(5000), { status: 502, statusText: "Bad Gateway" }),
      check: (message) => {
        expect(message).toContain("502 Bad Gateway");
        expect(message.length).toBeLessThan(800);
        expect(message.endsWith("...")).toBe(true);
      },
    },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    tmpHome();
    new Credential(undefined, null).store("gh-token", "gho_stored");
    const stub = fetchStub([hostProbeOk(), hostProbeOk(), c.response()]);
    let message = "";
    try {
      await webSearch("q", { fetchImpl: stub.fetchImpl });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.length, c.name).toBeGreaterThan(0);
    c.check(message);
  }
});

// --- credential resolution ---------------------------------------------------

test("resolveWebSearchCredential: the store beats the env fallback, env counts only with no provider recorded, nothing resolving points at `agent auth`, and a named profile hard-fails rather than borrowing either", () => {
  const cases: {
    name: string;
    stored?: string;
    env?: Record<string, string>;
    profile: string | null;
    expected: string | RegExp;
  }[] = [
    {
      name: "store over env",
      stored: "gho_stored",
      env: { GH_TOKEN: "gho_env" },
      profile: null,
      expected: "gho_stored",
    },
    {
      name: "env with no provider recorded",
      env: { GITHUB_TOKEN: "gho_env" },
      profile: null,
      expected: "gho_env",
    },
    {
      name: "nothing resolves",
      profile: null,
      expected:
        /run `agent auth` to log in or set one of COPILOT_GITHUB_TOKEN \/ GH_TOKEN \/ GITHUB_TOKEN/,
    },
    {
      name: "a named profile never falls back to the default credential or env",
      stored: "gho_default",
      env: { GH_TOKEN: "gho_env" },
      profile: "work",
      expected: /never falls back to the default credential/,
    },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    tmpHome();
    if (c.stored !== undefined) new Credential(undefined, null).store("gh-token", c.stored);
    for (const [key, value] of Object.entries(c.env ?? {})) process.env[key] = value;
    const profile = c.profile === null ? null : parseProfileName(c.profile);
    if (typeof c.expected === "string") {
      expect(resolveWebSearchCredential(profile), c.name).toBe(c.expected);
    } else {
      expect(() => resolveWebSearchCredential(profile), c.name).toThrow(c.expected);
    }
  }
});

test("a cancelled call stops waiting for a hanging fetch instead of sitting it out: the cold PAT probe, and the alias catalog fetch a configured model routes through", async () => {
  // A probe fetch that never resolves: without the abort race the call would hang. A CONFIGURED
  // model routes through the alias-resolution race at the top of webSearch, so a hanging catalog
  // fetch must not outlive the client's cancellation either.
  const neverFetch = () => new Promise<Response>(() => {});
  const cases: { name: string; token: string; stored?: string }[] = [
    { name: "the cold PAT probe", token: "ghp_forces_a_probe" },
    { name: "the alias catalog fetch", token: "gho_stored", stored: "gpt-latest" },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    tmpHome();
    new Credential(undefined, null).store("gh-token", c.token);
    if (c.stored !== undefined) {
      new CopilotEnvConfig().set({ "proxy.message-websearch-model": c.stored });
    }
    // The caller's reason is preserved: MCP cancellations carry a plain string.
    const plain = new AbortController();
    plain.abort();
    await expect(webSearch("q", { fetchImpl: neverFetch, signal: plain.signal }), c.name).rejects
      .toThrow(/aborted|cancelled/i);
    const reasoned = new AbortController();
    reasoned.abort("client went away");
    await expect(webSearch("q", { fetchImpl: neverFetch, signal: reasoned.signal }), c.name)
      .rejects.toThrow("web_search was cancelled: client went away");
  }
});

test("DEFAULT_WEB_SEARCH_MODEL is a raw catalog id, never an alias", () => {
  // The default path deliberately skips alias resolution (fetch-free), so the
  // default must never be a value the alias map would remap (e.g. `gpt-latest`).
  const aliases = generateAliases(
    parseCatalogModels({
      "data": [
        { "id": DEFAULT_WEB_SEARCH_MODEL },
        { "id": "gpt-6" },
        { "id": "gpt-6-mini" },
        { "id": "claude-fable-5" },
        { "id": "claude-opus-4.8" },
      ],
    }),
  );
  expect(aliases[DEFAULT_WEB_SEARCH_MODEL]).toBeUndefined();
});

test("webSearch on a named profile reads THAT slot's stored pair: no probe, the catalog and the POST under the stored identity on the stored host", async () => {
  tmpHome();
  // The default slot stores the codex identity on the generic host; the work slot stores the
  // sandbox id on the account's host. A web search for work must send work's pair, never the
  // default's, and never probe: the pair is the truth.
  const state = new CopilotEnvState();
  new Credential(undefined, null).store("gh-token", "gho_default");
  state.setProfileDirectPair(null, { integrationId: null, host: "https://api.githubcopilot.com" });
  const work = parseProfileName("work");
  state.commitProfile(work, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });
  const enterprise = "https://api.enterprise.githubcopilot.com";
  state.setProfileDirectPair(work, {
    integrationId: "copilot-developer-sandbox",
    host: enterprise,
  });
  const stub = fetchStub([okJson(catalogFixture()), okJson(responsesFixture())]);

  await webSearch("q", { profile: work, fetchImpl: stub.fetchImpl, model: "gpt-latest" });

  expect(stub.calls.map((c) => c.url)).toEqual([`${enterprise}/models`, `${enterprise}/responses`]);
  for (const call of stub.calls) {
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-sandbox");
    expect(headers.Authorization).toBe("Bearer ghp_work");
  }
  expect(JSON.parse(String(stub.calls[1]?.init.body)).model).toBe("gpt-6");
});
