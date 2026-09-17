import { CODEX_IDENTITY_NAME } from "../src/copilot_api/env_config.ts";
import {
  CODEX_EXEC_USER_AGENT,
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  identityCandidates,
  type IdentitySurvey,
  type IdentityVerdict,
  INTEGRATION_ID_HEADER,
  type ProbeFetch,
  probeIntegrationIdentity,
  resetIntegrationIdentityCache,
  selectDirectIdentityAndHost,
  setIntegrationProbeFetch,
  surveyIntegrationIdentities,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { codexUserAgent } from "../src/codex/user_agent.ts";
import { expect, test } from "./helpers/testing.ts";

/** THE candidate list, as every mode probes it. */
const CANDIDATES = identityCandidates("codex_exec/1");

function stubFetch(opts: {
  accept: (id: string | null) => boolean;
  seen?: string[];
}): ProbeFetch {
  return (_input, init) => {
    const headers = new Headers(init?.headers);
    const id = headers.get(INTEGRATION_ID_HEADER);
    opts.seen?.push(id ?? "<none>");
    return Promise.resolve(
      opts.accept(id)
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("bad request: Personal Access Tokens are not supported", { status: 400 }),
    );
  };
}

test("probeIntegrationIdentity: first accepted candidate wins, in the one order: codex, cli, sandbox, vscode-chat", async () => {
  const seen: string[] = [];
  const res = await probeIntegrationIdentity("ghp_x", CANDIDATES, {
    fetchImpl: stubFetch({ accept: (id) => id === COPILOT_CLI_INTEGRATION_ID, seen }),
    apiBase: DEFAULT_COPILOT_API_BASE,
  });
  expect(res.identity?.name).toBe(COPILOT_CLI_INTEGRATION_ID);
  expect(res.conclusive).toBe(true);
  // The later candidates are never reached once the CLI id is accepted.
  expect(seen).toEqual(["<none>", COPILOT_CLI_INTEGRATION_ID]);

  // The last candidate is reached only after every earlier one answered without a 2xx.
  const seenAll: string[] = [];
  const last = await probeIntegrationIdentity("ghp_y", CANDIDATES, {
    fetchImpl: stubFetch({ accept: (id) => id === VSCODE_CHAT_INTEGRATION_ID, seen: seenAll }),
    apiBase: DEFAULT_COPILOT_API_BASE,
  });
  expect(last.identity?.name).toBe(VSCODE_CHAT_INTEGRATION_ID);
  expect(seenAll).toEqual([
    "<none>",
    COPILOT_CLI_INTEGRATION_ID,
    COPILOT_SANDBOX_INTEGRATION_ID,
    VSCODE_CHAT_INTEGRATION_ID,
  ]);
});

const ENTERPRISE_API_BASE = "https://api.enterprise.githubcopilot.com";

/** Headers as the server sees them (lowercased keys), minus the bearer the probe adds. */
function sentIdentityHeaders(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(
    [...new Headers(init?.headers)].filter(([name]) => name !== "authorization"),
  );
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** The survey's row shape (`agent auth --identities`): the candidates in the one header set every
 *  mode sends, plus an id no candidate list carries (a pin, or the slot's stored identity). */
const FOREIGN_ID = "my-custom-id";
const SURVEY_ROWS = [
  ...CANDIDATES,
  { name: FOREIGN_ID, headers: directClientHeaders("codex_exec/1", FOREIGN_ID) },
];

const CONFIGURED_API_BASE = "https://copilot.example";

test("surveyIntegrationIdentities: every candidate on every host that matters, no early stop, the exact headers", async () => {
  const seen: { host: string; headers: Record<string, string> }[] = [];
  const catalog = (size: number): Response =>
    new Response(
      JSON.stringify({ data: Array.from({ length: size }, (_, i) => ({ id: `m${i}` })) }),
      {
        status: 200,
      },
    );
  const fetchImpl: ProbeFetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ endpoints: { api: ENTERPRISE_API_BASE } }), { status: 200 }),
      );
    }
    const host = new URL(url).host;
    const headers = sentIdentityHeaders(init);
    seen.push({ host, headers });
    if (host === new URL(CONFIGURED_API_BASE).host) return Promise.resolve(catalog(9));
    const enterprise = host === new URL(ENTERPRISE_API_BASE).host;
    switch (headers[INTEGRATION_ID_HEADER.toLowerCase()]) {
      case undefined:
        return Promise.resolve(catalog(3));
      case COPILOT_CLI_INTEGRATION_ID:
        return Promise.resolve(catalog(enterprise ? 37 : 5));
      case VSCODE_CHAT_INTEGRATION_ID:
      case FOREIGN_ID:
        return Promise.resolve(
          new Response("Personal Access Tokens are not supported", { status: 400 }),
        );
      default:
        return enterprise
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(new Response("upstream", { status: 503 }));
    }
  };
  const survey = await surveyIntegrationIdentities("ghp_x", SURVEY_ROWS, {
    fetchImpl,
    configuredHost: CONFIGURED_API_BASE,
  });
  const rejected: IdentityVerdict = {
    kind: "rejected",
    detail: "400 Personal Access Tokens are not supported",
  };
  const accepted9: IdentityVerdict = { kind: "accepted", models: 9 };
  const expected: IdentitySurvey = {
    hosts: [
      {
        apiBase: DEFAULT_COPILOT_API_BASE,
        role: "generic",
        verdicts: [
          { name: CODEX_IDENTITY_NAME, verdict: { kind: "accepted", models: 3 } },
          { name: COPILOT_CLI_INTEGRATION_ID, verdict: { kind: "accepted", models: 5 } },
          {
            name: COPILOT_SANDBOX_INTEGRATION_ID,
            verdict: { kind: "inconclusive", detail: "503 upstream", status: 503 },
          },
          { name: VSCODE_CHAT_INTEGRATION_ID, verdict: rejected },
          { name: FOREIGN_ID, verdict: rejected },
        ],
      },
      {
        apiBase: ENTERPRISE_API_BASE,
        role: "designated",
        verdicts: [
          { name: CODEX_IDENTITY_NAME, verdict: { kind: "accepted", models: 3 } },
          { name: COPILOT_CLI_INTEGRATION_ID, verdict: { kind: "accepted", models: 37 } },
          {
            name: COPILOT_SANDBOX_INTEGRATION_ID,
            verdict: { kind: "inconclusive", detail: "network error: offline", status: null },
          },
          { name: VSCODE_CHAT_INTEGRATION_ID, verdict: rejected },
          { name: FOREIGN_ID, verdict: rejected },
        ],
      },
      {
        apiBase: CONFIGURED_API_BASE,
        role: "configured",
        verdicts: SURVEY_ROWS.map((c) => ({ name: c.name, verdict: accepted9 })),
      },
    ],
    designatedUnknown: false,
  };
  expect(survey).toEqual(expected);
  // Each host sees byte-for-byte what every mode sends (directClientHeaders: the codex identity
  // with NO id header, the versioned UA on every row).
  expect(
    seen.filter((s) => s.host === new URL(DEFAULT_COPILOT_API_BASE).host).map((s) => s.headers),
  ).toEqual(SURVEY_ROWS.map((c) => lowercaseKeys(c.headers)));
  // Fed the same stub, the selector lands on the first accepted candidate, the codex identity (no
  // header, 3 models), whatever the token shape; every answer keeps the generic host.
  for (const token of ["ghp_x", "gho_x"]) {
    expect(await selectDirectIdentityAndHost(token, "codex_exec/1", { fetchImpl })).toEqual({
      integrationId: null,
      apiBase: DEFAULT_COPILOT_API_BASE,
    });
  }
});

test("surveyIntegrationIdentities: the designated and configured columns appear only when they add a host", async () => {
  const stub = (lookup: Response): ProbeFetch => (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url.includes("/copilot_internal/user")
        ? lookup
        : new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
  };
  const rows = SURVEY_ROWS.slice(0, 1);
  const designated = (api: string): Response =>
    new Response(JSON.stringify({ endpoints: { api } }), { status: 200 });
  // The account is served on the generic host: one column, and nothing unknown.
  const same = await surveyIntegrationIdentities("ghp_x", rows, {
    fetchImpl: stub(designated(DEFAULT_COPILOT_API_BASE)),
  });
  expect(same.hosts.map((h) => h.role)).toEqual(["generic"]);
  expect(same.designatedUnknown).toBe(false);
  // A transient lookup failure hides the column and says so, rather than guessing "the same".
  const unknown = await surveyIntegrationIdentities("ghp_x", rows, {
    fetchImpl: stub(new Response("upstream", { status: 503 })),
  });
  expect(unknown.hosts.map((h) => h.role)).toEqual(["generic"]);
  expect(unknown.designatedUnknown).toBe(true);
  // A literal equal to the designated host is one column, in its account role.
  const merged = await surveyIntegrationIdentities("ghp_x", rows, {
    fetchImpl: stub(designated(ENTERPRISE_API_BASE)),
    configuredHost: ENTERPRISE_API_BASE,
  });
  expect(merged.hosts.map((h) => [h.role, h.apiBase])).toEqual([
    ["generic", DEFAULT_COPILOT_API_BASE],
    ["designated", ENTERPRISE_API_BASE],
  ]);
});

test("host rule: 2xx/400/401 keep the generic host; 403/404/5xx/network move to the account's host; a failed lookup stays", async () => {
  // Pinned, so the identity step probes nothing and every /models round below is the host rule's.
  const pinned = COPILOT_CLI_INTEGRATION_ID;
  const rule = async (
    status: number | "network",
    lookup: "ok" | "fail",
  ): Promise<{ host: string; lookedUp: boolean; probedAs: string | null }> => {
    let lookedUp = false;
    let probedAs: string | null = null;
    const fetchImpl: ProbeFetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        lookedUp = true;
        return Promise.resolve(
          lookup === "ok"
            ? new Response(JSON.stringify({ endpoints: { api: ENTERPRISE_API_BASE } }), {
              status: 200,
            })
            : new Response("upstream", { status: 503 }),
        );
      }
      expect(url).toBe(`${DEFAULT_COPILOT_API_BASE}/models`);
      probedAs = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
      if (status === "network") return Promise.reject(new Error("offline"));
      return Promise.resolve(new Response("body", { status }));
    };
    const { apiBase } = await selectDirectIdentityAndHost("ghp_x", "codex_exec/1", {
      pinned,
      fetchImpl,
      narrator: { info: () => {} },
    });
    return { host: apiBase, lookedUp, probedAs };
  };
  // Kept: a 2xx serves the credential; 400 is an identity rejection and 401 a bad token, both
  // identical on every host; a transient 408/429 says nothing about the host either.
  for (const status of [200, 400, 401, 408, 429]) {
    expect(await rule(status, "ok")).toEqual({
      host: DEFAULT_COPILOT_API_BASE,
      lookedUp: false,
      probedAs: COPILOT_CLI_INTEGRATION_ID,
    });
  }
  for (const status of [403, 404, 500, 503, "network"] as const) {
    expect(await rule(status, "ok")).toEqual({
      host: ENTERPRISE_API_BASE,
      lookedUp: true,
      probedAs: COPILOT_CLI_INTEGRATION_ID,
    });
  }
  expect(await rule(403, "fail")).toEqual({
    host: DEFAULT_COPILOT_API_BASE,
    lookedUp: true,
    probedAs: COPILOT_CLI_INTEGRATION_ID,
  });
  // A literal and a missing token both skip every probe; so does any pin, a custom id included.
  let called = false;
  const never: ProbeFetch = () => {
    called = true;
    return Promise.reject(new Error("should not be called"));
  };
  expect(
    await selectDirectIdentityAndHost("ghp_x", "codex_exec/1", {
      pinned,
      fixedHost: CONFIGURED_API_BASE,
      fetchImpl: never,
    }),
  ).toEqual({ integrationId: pinned, apiBase: CONFIGURED_API_BASE });
  expect(
    await selectDirectIdentityAndHost("ghp_x", "codex_exec/1", {
      pinned: FOREIGN_ID,
      fixedHost: DEFAULT_COPILOT_API_BASE,
      fetchImpl: never,
    }),
  ).toEqual({ integrationId: FOREIGN_ID, apiBase: DEFAULT_COPILOT_API_BASE });
  expect(
    await selectDirectIdentityAndHost(null, "codex_exec/1", { pinned, fetchImpl: never }),
  ).toEqual({ integrationId: pinned, apiBase: DEFAULT_COPILOT_API_BASE });
  expect(called).toBe(false);
});

test("probeIntegrationIdentity: a 400 is the definitive rejection; a network error, a transient 5xx/429/408/404, or a 403 (policy/seat, not identity) is inconclusive", async () => {
  // 400 is the verified "PATs not supported" identity rejection (401, a bad token, is the other
  // definitive answer); the statuses here say nothing about the identity, so no candidate is
  // rejected on them.
  const cases: { status: number | "network"; conclusive: boolean }[] = [
    { status: "network", conclusive: false },
    { status: 500, conclusive: false },
    { status: 429, conclusive: false },
    { status: 503, conclusive: false },
    { status: 408, conclusive: false },
    { status: 404, conclusive: false },
    { status: 403, conclusive: false },
    { status: 400, conclusive: true },
  ];
  for (const c of cases) {
    const res = await probeIntegrationIdentity("ghp_x", CANDIDATES, {
      fetchImpl: () =>
        c.status === "network"
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(new Response("nope", { status: c.status })),
      apiBase: DEFAULT_COPILOT_API_BASE,
    });
    expect({ status: c.status, identity: res.identity, conclusive: res.conclusive }).toEqual({
      status: c.status,
      identity: null,
      conclusive: c.conclusive,
    });
  }
});

test("selectDirectIdentityAndHost: every credential is probed through the one candidate list; a transient answer degrades to the codex identity, a PAT the codex identity refuses lands on the CLI id, one rejected everywhere throws", async () => {
  // The daemon launch rides the transient rows: a 5xx on the generic host is inconclusive for
  // every candidate (the codex identity stands) and moves the host rule to the account lookup,
  // whose own failure stays put.
  const lookupOk: ProbeFetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url.includes("/copilot_internal/user")
        ? new Response("{}", { status: 200 })
        : new Response("upstream", { status: 503 }),
    );
  };
  const cases: {
    name: string;
    token: string;
    fixedHost?: string;
    fetchImpl: ProbeFetch;
    seen?: string[];
    /** Every request stays on the generic host's /models: no account-host lookup. */
    genericOnly?: true;
    expected: { integrationId: string | null; apiBase: string } | RegExp;
  }[] = [
    {
      name: "a transient probe and a failed account lookup",
      token: "ghp_x",
      fetchImpl: () => Promise.resolve(new Response("upstream", { status: 503 })),
      expected: { integrationId: null, apiBase: DEFAULT_COPILOT_API_BASE },
    },
    {
      name: "a transient probe with the account lookup answering",
      token: "ghp_x",
      fetchImpl: lookupOk,
      expected: { integrationId: null, apiBase: DEFAULT_COPILOT_API_BASE },
    },
    {
      name: "a non-PAT credential: the codex identity accepted first is one request",
      token: "gho_oauth",
      fixedHost: DEFAULT_COPILOT_API_BASE,
      fetchImpl: stubFetch({ accept: (id) => id === null }),
      seen: ["<none>"],
      expected: { integrationId: null, apiBase: DEFAULT_COPILOT_API_BASE },
    },
    {
      name: "a PAT the codex identity refuses lands on the CLI id",
      token: "github_pat_x",
      fetchImpl: stubFetch({ accept: (i) => i === COPILOT_CLI_INTEGRATION_ID }),
      expected: { integrationId: COPILOT_CLI_INTEGRATION_ID, apiBase: DEFAULT_COPILOT_API_BASE },
    },
    {
      // Direct bakes DEFAULT_COPILOT_API_BASE as base_url, so the verdict is rendered against THAT
      // host: never a separately discovered account host the agents would not use.
      name: "a PAT rejected everywhere throws with the reason, selected on the host it bakes",
      token: "ghp_bad",
      fetchImpl: stubFetch({ accept: () => false }),
      genericOnly: true,
      expected: /rejects this credential under every known client identity/,
    },
  ];
  for (const c of cases) {
    resetIntegrationIdentityCache();
    const seen: string[] = [];
    const urls: string[] = [];
    const fetchImpl: ProbeFetch = (input, init) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      seen.push(new Headers(init?.headers).get(INTEGRATION_ID_HEADER) ?? "<none>");
      return c.fetchImpl(input, init);
    };
    const run = selectDirectIdentityAndHost(c.token, "codex_exec/1", {
      fixedHost: c.fixedHost,
      fetchImpl,
      narrator: { info: () => {} },
    });
    if (c.expected instanceof RegExp) await expect(run, c.name).rejects.toThrow(c.expected);
    else expect(await run, c.name).toEqual(c.expected);
    if (c.seen !== undefined) expect(seen, c.name).toEqual(c.seen);
    if (c.genericOnly) {
      expect(urls.length, c.name).toBeGreaterThan(0);
      expect(urls.every((u) => u === `${DEFAULT_COPILOT_API_BASE}/models`), c.name).toBe(true);
    }
  }
});

/** A request's header set lower-cased the way `Headers` reports names, Authorization included. */
function wireHeaders(headers: Record<string, string>, token: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...headers, Authorization: `Bearer ${token}` })
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
}

test("fetchRawModels(direct): a caller deadline aborts the identity probe chain itself", async () => {
  // The Codex catalog refresh runs inside `agent auth --get`'s bounded budget: its
  // deadline must end the pending REQUESTS (a PAT chains identity probes before the
  // GET), not just stop awaiting them, or the auth process outlives the budget.
  const { fetchRawModels } = await import("../src/copilot_api/catalog.ts");
  // Every request also carries its own 5s timeout, so the proof is the REASON the
  // pending request saw: the caller's sentinel, not a timeout.
  const abortReasons: unknown[] = [];
  const deadline = new AbortController();
  const sentinel = new Error("caller deadline");
  // The FIRST pending request trips the caller's deadline itself: deterministic, no timer.
  const hang = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_, reject) => {
      const abort = (): void => {
        abortReasons.push(init?.signal?.reason);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort);
      if (!deadline.signal.aborted) deadline.abort(sentinel);
    });
  setIntegrationProbeFetch(hang);
  const realFetch = globalThis.fetch;
  globalThis.fetch = hang as typeof fetch;
  try {
    await expect(fetchRawModels("direct", { directToken: "github_pat_x", signal: deadline.signal }))
      .rejects.toThrow();
  } finally {
    globalThis.fetch = realFetch;
    setIntegrationProbeFetch(null);
  }
  expect(abortReasons).toContain(sentinel);
});

test("fetchRawModels(direct) probes and fetches ONE host; with no consumer named it sends the version-free codex set", async () => {
  // A PAT's identity must be probed against the SAME host the catalog request then hits;
  // probing a discovered account host while fetching the public one renders the verdict
  // against a host this request never touches. With no identity named, the header set is the
  // one every mode sends, under the version-free codex UA.
  const { fetchRawModels } = await import("../src/copilot_api/catalog.ts");
  const modelsUrl = `${DEFAULT_COPILOT_API_BASE}/models`;

  const seen: string[] = [];
  const sent: Record<string, string>[] = [];
  const accepted: string[] = [];
  const respond = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const headers = new Headers(init?.headers);
    sent.push(Object.fromEntries(headers.entries()));
    const id = headers.get(INTEGRATION_ID_HEADER);
    // Only the CLI identity is accepted -- the PAT case, which forces a real probe.
    if (id !== COPILOT_CLI_INTEGRATION_ID) {
      return new Response("PATs not supported", { status: 400 });
    }
    accepted.push(id);
    return new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }] }), { status: 200 });
  };
  setIntegrationProbeFetch((input, init) => Promise.resolve(respond(input, init)));
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(respond(input, init))) as typeof fetch;
  try {
    const body = await fetchRawModels("direct", { directToken: "github_pat_x" });
    expect(body).toEqual({ data: [{ id: "gpt-5-mini" }] });
  } finally {
    globalThis.fetch = realFetch;
    setIntegrationProbeFetch(null);
  }

  expect(seen.length).toBeGreaterThan(1); // a probe happened, then the real fetch
  expect(seen.every((u) => u === modelsUrl)).toBe(true);
  expect(seen.some((u) => u.includes("/copilot_internal/user"))).toBe(false);
  // The winning identity probe (whose memoized verdict the host rule reads) and the catalog GET
  // both carried the settled identity.
  expect(accepted.length).toBe(2);
  expect(accepted.every((id) => id === COPILOT_CLI_INTEGRATION_ID)).toBe(true);
  const set = (id: string | null) =>
    wireHeaders(directClientHeaders(CODEX_EXEC_USER_AGENT, id), "github_pat_x");
  expect(sent[0]).toEqual(set(null));
  expect(sent[sent.length - 1]).toEqual(set(COPILOT_CLI_INTEGRATION_ID));
});

test("fetchRawModels(direct): a host `auto` moved to re-selects the identity there, for both consumers", async () => {
  // Copilot's concrete input: the generic host is blocked (403) for every identity, the account's
  // host accepts the CLI id alone. The first selection (generic) ends at the default, the host
  // moves, and the GET must carry the id the MOVED host accepts, not the generic host's answer.
  const { fetchRawModels } = await import("../src/copilot_api/catalog.ts");
  const enterprise = "https://api.enterprise.githubcopilot.com";
  const stub: ProbeFetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ endpoints: { api: enterprise } }), { status: 200 }),
      );
    }
    if (new URL(url).origin !== enterprise) {
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }
    return Promise.resolve(
      new Headers(init?.headers).get(INTEGRATION_ID_HEADER) === COPILOT_CLI_INTEGRATION_ID
        ? new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }] }), { status: 200 })
        : new Response("PATs not supported", { status: 400 }),
    );
  };
  for (const identity of [{ kind: "agents" as const, userAgent: codexUserAgent() }, undefined]) {
    const gets: { url: string; id: string | null }[] = [];
    const body = await fetchRawModels("direct", {
      directToken: "github_pat_x",
      identity,
      fetchImpl: (input, init) => {
        const url = String(input);
        if (url.endsWith("/models") && init?.method === undefined) {
          gets.push({ url, id: new Headers(init?.headers).get(INTEGRATION_ID_HEADER) });
        }
        return stub(input, init);
      },
    });
    expect(body).toEqual({ data: [{ id: "gpt-5-mini" }] });
    // The last /models request is the catalog GET: on the moved host, under the id it accepts.
    expect(gets.at(-1)).toEqual({ url: `${enterprise}/models`, id: COPILOT_CLI_INTEGRATION_ID });
  }
});

test("fetchRawModels(direct) under the agents' identity sends the exact header set Codex bakes", async () => {
  // Copilot gates the catalog per identity, so a consumer feeding an agent names that agent's
  // identity and gets its header set byte for byte: the versioned codex_exec UA, Openai-Intent, and
  // the baked id (none for the codex identity). Every credential is probed through the one
  // candidate list (the id-less codex one first); then the host probe under the settled set, then
  // the GET.
  const { fetchRawModels } = await import("../src/copilot_api/catalog.ts");
  const agents = (id: string | null, token: string) =>
    wireHeaders(directClientHeaders(codexUserAgent(), id), token);
  const cases: { token: string; expected: Record<string, string>[] }[] = [
    {
      token: "github_pat_x",
      expected: [
        agents(null, "github_pat_x"),
        agents(COPILOT_CLI_INTEGRATION_ID, "github_pat_x"),
        agents(COPILOT_CLI_INTEGRATION_ID, "github_pat_x"),
        agents(COPILOT_CLI_INTEGRATION_ID, "github_pat_x"),
      ],
    },
    {
      token: "gho_x",
      expected: [agents(null, "gho_x"), agents(null, "gho_x"), agents(null, "gho_x")],
    },
  ];
  for (const c of cases) {
    const sent: Record<string, string>[] = [];
    const body = await fetchRawModels("direct", {
      directToken: c.token,
      identity: { kind: "agents", userAgent: codexUserAgent() },
      fetchImpl: (_input, init) => {
        const headers = new Headers(init?.headers);
        sent.push(Object.fromEntries(headers.entries()));
        // A PAT is refused under the default identity and accepted under the CLI one.
        const ok = !c.token.startsWith("github_pat_") ||
          headers.get(INTEGRATION_ID_HEADER) === COPILOT_CLI_INTEGRATION_ID;
        return Promise.resolve(
          ok
            ? new Response(JSON.stringify({ data: [] }), { status: 200 })
            : new Response("PATs not supported", { status: 400 }),
        );
      },
    });
    expect({ token: c.token, body, sent }).toEqual({
      token: c.token,
      body: { data: [] },
      sent: c.expected,
    });
  }
});
