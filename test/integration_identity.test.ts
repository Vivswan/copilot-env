import { expect, test } from "bun:test";
import {
  bakedIntegrationId,
  COPILOT_CLI_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  directIdentityCandidates,
  INTEGRATION_ID_HEADER,
  PASSTHROUGH_IDENTITY_CANDIDATES,
  type ProbeFetch,
  probeIntegrationIdentity,
  resetIntegrationIdentityCache,
  resolveDirectIntegrationId,
  resolvePassthroughIntegrationId,
  setIntegrationProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";

/** A fetch stub: `accept(id)` decides which integration id the fake endpoint accepts on
 *  `/models`; `/copilot_internal/user` returns `apiBase` (or 404 to force the fallback).
 *  Records every requested integration id so tests can assert probe ORDER. */
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
  // vscode-chat tried first (rejected), then the CLI id (accepted) -- sandbox never reached.
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

test("probeIntegrationIdentity: a network error is inconclusive, not a rejection", async () => {
  const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
    fetchImpl: () => Promise.reject(new Error("offline")),
  });
  expect(res.identity).toBeNull();
  expect(res.conclusive).toBe(false);
});

test("probeIntegrationIdentity: a transient 5xx/429 is inconclusive, a 400 is definitive", async () => {
  const status =
    (code: number): ProbeFetch =>
    (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return Promise.resolve(new Response("nope", { status: code }));
    };
  // A 500/429 on every candidate must NOT read as "definitively rejected".
  for (const code of [500, 429, 503, 408, 404]) {
    const res = await probeIntegrationIdentity("ghp_x", PASSTHROUGH_IDENTITY_CANDIDATES, {
      fetchImpl: status(code),
    });
    expect(res.conclusive).toBe(false);
  }
  // A 400 (the verified "PATs not supported" identity rejection) IS definitive.
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
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
  // The bun --preload shim stays import-free (a shim must not drag CLI modules into the
  // daemon), so it re-declares this contract as a literal. Nothing but this test ties the
  // copy to the original -- a rename here fails loudly instead of silently disabling the
  // header rewrite in the daemon. (The shim's env-key literal, INTEGRATION_ID_ENV, is
  // pinned the same way by test/daemon_env_keys.test.ts.)
  const shim = await Bun.file(
    new URL("../src/scripts/pat_passthrough_preload.ts", import.meta.url),
  ).text();
  expect(shim).toContain(`const INTEGRATION_ID_HEADER = "${INTEGRATION_ID_HEADER}"`);
});

test("fetchRawModels(direct) probes and fetches ONE host, with the resolved identity", async () => {
  // The real consumer, end to end: a PAT-shaped credential must have its identity probed
  // against the SAME host the catalog request then hits. Probing a discovered account host
  // while fetching the public one would render the verdict against a host this request
  // never touches (and would silently 400 for a PAT).
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
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(respond(input, init))) as typeof fetch;
  try {
    const body = await fetchRawModels("direct", { directToken: "github_pat_x" });
    expect(body).toEqual({ data: [{ id: "gpt-5-mini" }] });
  } finally {
    globalThis.fetch = realFetch;
    setIntegrationProbeFetch(null);
  }

  // EVERY request -- probe candidates and the final catalog GET -- hit the one public host.
  expect(seen.length).toBeGreaterThan(1); // a probe happened, then the real fetch
  expect(seen.every((u) => u === DIRECT_MODELS_URL)).toBe(true);
  expect(seen.some((u) => u.includes("/copilot_internal/user"))).toBe(false);
  // ...and both the winning probe and the catalog GET carried the settled identity.
  expect(accepted.length).toBe(2);
  expect(accepted.every((id) => id === COPILOT_CLI_INTEGRATION_ID)).toBe(true);
});
