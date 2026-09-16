import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_IDENTITY_NAME } from "../src/copilot_api/env_config.ts";
import {
  autoIdentityFor,
  bakedIntegrationId,
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  directIdentityCandidates,
  INTEGRATION_ID_HEADER,
  PASSTHROUGH_IDENTITY_CANDIDATES,
  type ProbeFetch,
  probeIntegrationIdentity,
  resetIntegrationIdentityCache,
  resolveDirectIntegrationId,
  resolvePassthroughIntegrationId,
  setIntegrationProbeFetch,
  surveyIntegrationIdentities,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { ROOT } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

function stubFetch(opts: {
  accept: (id: string | null) => boolean;
  apiBase?: string;
  seen?: string[];
}): ProbeFetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      const body = opts.apiBase ? { endpoints: { api: opts.apiBase } } : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
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

test("probeIntegrationIdentity: first accepted candidate wins, in order", async () => {
  const seen: string[] = [];
  const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
    fetchImpl: stubFetch({ accept: (id) => id === COPILOT_CLI_INTEGRATION_ID, seen }),
  });
  expect(res.identity?.name).toBe(COPILOT_CLI_INTEGRATION_ID);
  expect(res.conclusive).toBe(true);
  // The sandbox candidate is never reached once the CLI id is accepted.
  expect(seen).toEqual([VSCODE_CHAT_INTEGRATION_ID, COPILOT_CLI_INTEGRATION_ID]);
});

test("probeIntegrationIdentity: probes the account's designated API base", async () => {
  let probedUrl = "";
  const fetchImpl: ProbeFetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ endpoints: { api: "https://api.enterprise.githubcopilot.com" } }),
          {
            status: 200,
          },
        ),
      );
    }
    probedUrl = url;
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  };
  const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
    fetchImpl,
  });
  expect(res.apiBase).toBe("https://api.enterprise.githubcopilot.com");
  expect(probedUrl).toBe("https://api.enterprise.githubcopilot.com/models");
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

test("surveyIntegrationIdentities: every candidate on both hosts, no early stop, the agents' exact headers", async () => {
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
    const enterprise = host === new URL(ENTERPRISE_API_BASE).host;
    switch (headers[INTEGRATION_ID_HEADER.toLowerCase()]) {
      case undefined:
        return Promise.resolve(catalog(3));
      case COPILOT_CLI_INTEGRATION_ID:
        return Promise.resolve(catalog(enterprise ? 37 : 5));
      case VSCODE_CHAT_INTEGRATION_ID:
        return Promise.resolve(
          new Response("Personal Access Tokens are not supported", { status: 400 }),
        );
      default:
        return enterprise
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(new Response("upstream", { status: 503 }));
    }
  };
  const survey = await surveyIntegrationIdentities("ghp_x", {
    direct: directIdentityCandidates("codex_exec/1"),
    passthrough: PASSTHROUGH_IDENTITY_CANDIDATES,
  }, { fetchImpl });
  expect(survey).toEqual({
    direct: {
      apiBase: DEFAULT_COPILOT_API_BASE,
      verdicts: [
        { name: CODEX_IDENTITY_NAME, verdict: { kind: "accepted", models: 3 } },
        { name: COPILOT_CLI_INTEGRATION_ID, verdict: { kind: "accepted", models: 5 } },
        {
          name: COPILOT_SANDBOX_INTEGRATION_ID,
          verdict: { kind: "inconclusive", detail: "503 upstream" },
        },
      ],
    },
    passthrough: {
      apiBase: ENTERPRISE_API_BASE,
      verdicts: [
        {
          name: VSCODE_CHAT_INTEGRATION_ID,
          verdict: { kind: "rejected", detail: "400 Personal Access Tokens are not supported" },
        },
        { name: COPILOT_CLI_INTEGRATION_ID, verdict: { kind: "accepted", models: 37 } },
        {
          name: COPILOT_SANDBOX_INTEGRATION_ID,
          verdict: { kind: "inconclusive", detail: "network error: offline" },
        },
      ],
    },
  });
  // The Direct column sends byte-for-byte what the agents bake (directClientHeaders), with the
  // default identity carrying NO id header.
  expect(
    seen.filter((s) => s.host === new URL(DEFAULT_COPILOT_API_BASE).host).map((s) => s.headers),
  ).toEqual(
    [null, COPILOT_CLI_INTEGRATION_ID, COPILOT_SANDBOX_INTEGRATION_ID].map((id) =>
      lowercaseKeys(directClientHeaders("codex_exec/1", id))
    ),
  );
  // The star `agent auth --identities` draws off a column is the identity a LAUNCH sends: fed the
  // same stub, each mode's resolver lands where autoIdentityFor says (the codex name is Direct's
  // null header; a non-PAT credential is never probed by either).
  const direct = autoIdentityFor("ghp_x", survey.direct);
  expect(await resolveDirectIntegrationId("ghp_x", "codex_exec/1", { fetchImpl })).toBe(
    direct === CODEX_IDENTITY_NAME ? null : direct,
  );
  for (const token of ["ghp_x", "gho_x"]) {
    expect(await resolvePassthroughIntegrationId(token, { fetchImpl })).toBe(
      autoIdentityFor(token, survey.passthrough),
    );
  }
});

test("surveyIntegrationIdentities: a transient account-host lookup downgrades the fallback host's rejections", async () => {
  const fetchImpl: ProbeFetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url.includes("/copilot_internal/user")
        ? new Response("upstream", { status: 503 })
        : new Response("PATs not supported", { status: 400 }),
    );
  };
  const survey = await surveyIntegrationIdentities("ghp_x", {
    direct: directIdentityCandidates("codex_exec/1").slice(0, 1),
    passthrough: PASSTHROUGH_IDENTITY_CANDIDATES.slice(0, 1),
  }, { fetchImpl });
  // Direct never looks the host up, so its 400 stays definitive; the fallback host may not be
  // where this credential is served, so the proxy column's 400 must not read as a verdict.
  expect(survey.direct.verdicts[0]?.verdict).toEqual({
    kind: "rejected",
    detail: "400 PATs not supported",
  });
  expect(survey.passthrough.verdicts[0]?.verdict).toEqual({
    kind: "inconclusive",
    detail: "400 PATs not supported (account host lookup failed; probed the fallback host)",
  });
  // "No pick" on Direct is the launch's refusal: the resolver throws on the same stub.
  expect(autoIdentityFor("ghp_x", survey.direct)).toBeNull();
  await expect(resolveDirectIntegrationId("ghp_x", "codex_exec/1", { fetchImpl })).rejects
    .toThrow(/rejects this credential/);
});

test("probeIntegrationIdentity: a network error is inconclusive, not a rejection", async () => {
  const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
    fetchImpl: () => Promise.reject(new Error("offline")),
  });
  expect(res.identity).toBeNull();
  expect(res.conclusive).toBe(false);
});

test("probeIntegrationIdentity: a transient 5xx/429 is inconclusive, a 400 is definitive", async () => {
  const status = (code: number): ProbeFetch => (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return Promise.resolve(new Response("nope", { status: code }));
  };
  for (const code of [500, 429, 503, 408, 404]) {
    const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
      fetchImpl: status(code),
    });
    expect(res.conclusive).toBe(false);
  }
  // 400 is the verified "PATs not supported" identity rejection.
  const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
    fetchImpl: status(400),
  });
  expect(res.conclusive).toBe(true);
});

test("probeIntegrationIdentity: a 403 on a candidate is inconclusive (policy/seat, not identity)", async () => {
  const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
    fetchImpl: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    },
  });
  expect(res.conclusive).toBe(false);
});

test("probeIntegrationIdentity: a transient host-discovery failure makes an all-reject inconclusive", async () => {
  // /copilot_internal/user 503s (real host unknown), then the fallback host 400s every
  // candidate. Because discovery was transient, this must NOT read as definitive.
  const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
    fetchImpl: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(new Response("upstream", { status: 503 }));
      }
      return Promise.resolve(new Response("PATs not supported", { status: 400 }));
    },
  });
  expect(res.identity).toBeNull();
  expect(res.conclusive).toBe(false);
});

test("resolveDirectIntegrationId: probes the host it BAKES, with no account-host lookup", async () => {
  resetIntegrationIdentityCache();
  const probed: string[] = [];
  await expect(
    resolveDirectIntegrationId("ghp_x", "codex_exec/1", {
      fetchImpl: (input) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url;
        probed.push(url);
        return Promise.resolve(new Response("PATs not supported", { status: 400 }));
      },
    }),
  ).rejects.toThrow(/rejects this credential/);
  // Direct bakes DEFAULT_COPILOT_API_BASE as base_url, so the verdict must be rendered
  // against THAT host -- never a separately discovered account host the agents won't use.
  expect(probed.every((u) => u.startsWith(`${DEFAULT_COPILOT_API_BASE}/models`))).toBe(true);
  expect(probed.some((u) => u.includes("/copilot_internal/user"))).toBe(false);
});

test("resolvePassthroughIntegrationId: a transient discovery failure degrades to default, never throws", async () => {
  resetIntegrationIdentityCache();
  // Passthrough DOES discover the account host (matching what the daemon resolves), so a
  // transient lookup failure + an all-reject on the fallback must not hard-fail the launch.
  const id = await resolvePassthroughIntegrationId("ghp_x", {
    fetchImpl: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(new Response("upstream", { status: 503 }));
      }
      return Promise.resolve(new Response("PATs not supported", { status: 400 }));
    },
  });
  expect(id).toBe(VSCODE_CHAT_INTEGRATION_ID);
});

test("resolveDirectIntegrationId: a transient failure degrades to the default, never throws", async () => {
  resetIntegrationIdentityCache();
  const id = await resolveDirectIntegrationId("ghp_x", "codex_exec/1", {
    fetchImpl: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return Promise.resolve(new Response("upstream", { status: 503 }));
    },
  });
  expect(id).toBeNull();
});

test("resolveDirectIntegrationId: a non-PAT credential uses the default (no fetch)", async () => {
  resetIntegrationIdentityCache();
  let called = false;
  const id = await resolveDirectIntegrationId("gho_oauth", "codex_exec/1", {
    fetchImpl: () => {
      called = true;
      return Promise.reject(new Error("should not be called"));
    },
  });
  expect(id).toBeNull();
  expect(called).toBe(false);
});

test("resolveDirectIntegrationId: a PAT probes and bakes the accepted id", async () => {
  resetIntegrationIdentityCache();
  const id = await resolveDirectIntegrationId("github_pat_x", "codex_exec/1", {
    fetchImpl: stubFetch({ accept: (i) => i === COPILOT_CLI_INTEGRATION_ID }),
  });
  expect(id).toBe(COPILOT_CLI_INTEGRATION_ID);
});

test("resolveDirectIntegrationId: the config pin wins without any probe", async () => {
  resetIntegrationIdentityCache();
  let called = false;
  const id = await resolveDirectIntegrationId("ghp_x", "codex_exec/1", {
    pinned: "my-custom-id",
    fetchImpl: () => {
      called = true;
      return Promise.reject(new Error("should not be called"));
    },
  });
  expect(id).toBe("my-custom-id");
  expect(called).toBe(false);
});

test("resolveDirectIntegrationId: a PAT rejected everywhere throws with the reason", async () => {
  resetIntegrationIdentityCache();
  await expect(
    resolveDirectIntegrationId("ghp_bad", "codex_exec/1", {
      fetchImpl: stubFetch({ accept: () => false }),
    }),
  ).rejects.toThrow(/rejects this credential under every known client identity/);
});

test("resolvePassthroughIntegrationId: non-PAT stays on vscode-chat (no fetch)", async () => {
  resetIntegrationIdentityCache();
  let called = false;
  const id = await resolvePassthroughIntegrationId("gho_oauth", {
    fetchImpl: () => {
      called = true;
      return Promise.reject(new Error("should not be called"));
    },
  });
  expect(id).toBe(VSCODE_CHAT_INTEGRATION_ID);
  expect(called).toBe(false);
});

test("resolvePassthroughIntegrationId: a PAT resolves to the accepted id", async () => {
  resetIntegrationIdentityCache();
  const id = await resolvePassthroughIntegrationId("ghp_x", {
    fetchImpl: stubFetch({ accept: (i) => i === COPILOT_CLI_INTEGRATION_ID }),
  });
  expect(id).toBe(COPILOT_CLI_INTEGRATION_ID);
});

test("directIdentityCandidates: the default candidate carries the detected UA and no id", () => {
  const [dflt, cli] = directIdentityCandidates("codex_exec/9.9.9");
  expect(dflt?.headers["User-Agent"]).toBe("codex_exec/9.9.9");
  expect(bakedIntegrationId(dflt!)).toBeNull();
  expect(bakedIntegrationId(cli!)).toBe(COPILOT_CLI_INTEGRATION_ID);
  // The version rides the passed UA -- the candidate name is just a stable label.
  expect(cli?.headers["User-Agent"]).toBe("codex_exec/9.9.9");
});

test("the preload's copied header literal stays in step with the module's (drift guard)", async () => {
  // The --preload shim stays import-free (it must not drag CLI modules into the daemon), so it
  // re-declares this contract as a literal; nothing but this test ties the copy to the original.
  // The shim's env-key literal is pinned the same way by test/daemon_env_keys.test.ts.
  const shim = readFileSync(join(ROOT, "src", "scripts", "pat_passthrough_preload.ts"), "utf8");
  expect(shim).toContain(`const INTEGRATION_ID_HEADER = "${INTEGRATION_ID_HEADER}"`);
});

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

test("fetchRawModels(direct) probes and fetches ONE host, with the resolved identity", async () => {
  // A PAT's identity must be probed against the SAME host the catalog request then hits;
  // probing a discovered account host while fetching the public one renders the verdict
  // against a host this request never touches.
  const { fetchRawModels, DIRECT_MODELS_URL } = await import("../src/copilot_api/catalog.ts");

  const seen: string[] = [];
  const accepted: string[] = [];
  const respond = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
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
  expect(seen.every((u) => u === DIRECT_MODELS_URL)).toBe(true);
  expect(seen.some((u) => u.includes("/copilot_internal/user"))).toBe(false);
  // The winning probe and the catalog GET both carried the settled identity.
  expect(accepted.length).toBe(2);
  expect(accepted.every((id) => id === COPILOT_CLI_INTEGRATION_ID)).toBe(true);
});
