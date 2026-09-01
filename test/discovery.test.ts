// The no-hand-kept-ids model discovery (src/copilot_api/discovery.ts): catalog +
// allowlist oracle + one-by-one verification pings, all identity-exact. Every request
// is served by a routing fetch stub -- nothing here touches the network.
import { discoverServableClaudeModels } from "../src/copilot_api/discovery.ts";
import type { ProbeFetch } from "../src/copilot_api/integration_identity.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

// The unified pipeline persists verification verdicts in the shared state store
// (the daily cache both consumers share), so every test isolates its own home.
const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function isolate(): void {
  dir = isolateProxyHome("copilot-discovery-");
}

interface StubOptions {
  /** /models ids per identity; key "none" = no Copilot-Integration-Id header. */
  catalogs: Record<string, string[]>;
  /** The oracle 400's allowlist (absent = the oracle errors unrecognizably). */
  allowlist?: string[];
  /** Models whose 1-token /v1/messages ping returns 200. */
  servable?: string[];
  /** Models whose oversized-prompt probe returns 200 (the 1m verdict). */
  oneM?: string[];
  /** Models whose pings answer 503 (transient trouble, never a verdict). */
  transient?: string[];
  /** Models whose 1m probe ONLY answers 503 (the small ping still succeeds). */
  transient1m?: string[];
  /** Models whose small ping answers 201 (a 2xx that is not the exact 200). */
  odd?: string[];
  /** Spy log: "oracle:<id>", "ping:<id>", "probe1m:<id>". */
  calls?: string[];
}

function stubFetch(opts: StubOptions): ProbeFetch {
  return (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    if (url.endsWith("/models")) {
      const identity = headers.get("Copilot-Integration-Id") ?? "none";
      const ids = opts.catalogs[identity];
      if (ids === undefined) return Promise.resolve(new Response("{}", { status: 403 }));
      return Promise.resolve(
        Response.json({ data: ids.map((id) => ({ id })) }),
      );
    }
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages?: { content: string }[];
    };
    if (url.endsWith("/responses")) {
      opts.calls?.push(`oracle:${body.model}`);
      const message = opts.allowlist === undefined
        ? "The requested model is not supported."
        : `The requested model is not available for integrator "x". Available models: [${
          opts.allowlist.join(" ")
        }]`;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message } }), { status: 400 }),
      );
    }
    // /v1/messages: the small ping vs the oversized 1m probe, by prompt size.
    const big = (body.messages?.[0]?.content.length ?? 0) > 100_000;
    opts.calls?.push(`${big ? "probe1m" : "ping"}:${body.model}`);
    if (opts.transient?.includes(body.model) || (big && opts.transient1m?.includes(body.model))) {
      return Promise.resolve(new Response("busy", { status: 503 }));
    }
    if (!big && opts.odd?.includes(body.model)) {
      return Promise.resolve(new Response("{}", { status: 201 }));
    }
    const ok = (big ? opts.oneM : opts.servable)?.includes(body.model) ?? false;
    return Promise.resolve(
      new Response(ok ? "{}" : JSON.stringify({ error: { message: "nope" } }), {
        status: ok ? 200 : 400,
      }),
    );
  };
}

const UA = "codex_exec/0.152.0";

test("identical catalogs across identities: advertised only, zero oracle/ping traffic", async () => {
  isolate();
  const calls: string[] = [];
  const same = ["claude-haiku-4.5", "gpt-5.6-sol"];
  const result = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({
      catalogs: {
        "none": same,
        "vscode-chat": same,
        "copilot-developer-cli": same,
        "copilot-developer-sandbox": same,
      },
      calls,
    }),
  });
  expect(result.models.map((m) => m.id)).toEqual(same);
  expect(calls).toEqual([]); // no gated candidate -> no oracle, no pings
});

test("full pipeline: oracle extras verified one by one, 1m probed, failures excluded", async () => {
  isolate();
  const calls: string[] = [];
  const result = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({
      catalogs: {
        "none": ["claude-haiku-4.5"],
        "vscode-chat": ["claude-haiku-4.5"],
        // A cli-only id becomes the oracle trigger.
        "copilot-developer-cli": ["claude-haiku-4.5", "claude-sonnet-4.6"],
        "copilot-developer-sandbox": ["claude-haiku-4.5"],
      },
      allowlist: [
        "gpt-5.6-sol", // non-claude: ignored
        "claude-haiku-4.5", // already advertised: ignored
        "claude-fable-5", // verifiable, 1m-capable
        "claude-opus-4.5", // verifiable, NOT 1m
        "claude-ghost-9", // fails verification: excluded
      ],
      servable: ["claude-fable-5", "claude-opus-4.5"],
      oneM: ["claude-fable-5"],
      calls,
    }),
  });
  expect(calls[0]).toBe("oracle:claude-sonnet-4.6"); // trigger derived, not hand-kept
  expect(result.models).toEqual([
    { id: "claude-haiku-4.5", is1m: false },
    { id: "claude-fable-5", is1m: true },
    { id: "claude-opus-4.5", is1m: false },
  ]);
  // Ghost pinged once and never 1m-probed; opus-4.5 probed and denied.
  expect(calls).toContain("ping:claude-ghost-9");
  expect(calls).not.toContain("probe1m:claude-ghost-9");
  expect(calls).toContain("probe1m:claude-opus-4.5");
});

test("an unrecognizable oracle error degrades to catalog-only, never a guess", async () => {
  isolate();
  const calls: string[] = [];
  const result = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({
      catalogs: {
        "none": ["claude-haiku-4.5"],
        "vscode-chat": ["claude-haiku-4.5", "claude-sonnet-4.6"],
        "copilot-developer-cli": ["claude-haiku-4.5"],
        "copilot-developer-sandbox": ["claude-haiku-4.5"],
      },
      // no allowlist -> the oracle 400 has no "Available models" list
      calls,
    }),
  });
  expect(result.models.map((m) => m.id)).toEqual(["claude-haiku-4.5"]);
  expect(calls.some((c) => c.startsWith("ping:"))).toBe(false);
});

test("the own-identity catalog failing is a hard throw (the caller falls back)", async () => {
  isolate();
  await expect(
    discoverServableClaudeModels("ghu_x", UA, null, {
      fetchImpl: () => Promise.resolve(new Response("{}", { status: 500 })),
    }),
  ).rejects.toThrow("returned 500");
});

test("sibling-identity catalog failures do not sink discovery", async () => {
  isolate();
  const result = await discoverServableClaudeModels("ghu_x", UA, "vscode-chat", {
    fetchImpl: stubFetch({
      // Only the own identity's catalog answers; the rest 403 (absent from the map).
      catalogs: { "vscode-chat": ["claude-haiku-4.5"] },
    }),
  });
  expect(result.models.map((m) => m.id)).toEqual(["claude-haiku-4.5"]);
});

test("verification verdicts are cached: a rerun pays zero pings until the TTL lapses", async () => {
  isolate();
  const opts = {
    catalogs: {
      "none": ["claude-haiku-4.5"],
      "vscode-chat": ["claude-haiku-4.5"],
      "copilot-developer-cli": ["claude-haiku-4.5", "claude-sonnet-4.6"],
      "copilot-developer-sandbox": ["claude-haiku-4.5"],
    },
    allowlist: ["claude-fable-5"],
    servable: ["claude-fable-5"],
    oneM: ["claude-fable-5"],
  };
  const day = 24 * 60 * 60 * 1000;
  const t0 = 1_700_000_000_000;
  const first: string[] = [];
  await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({ ...opts, calls: first }),
    nowMs: () => t0,
  });
  expect(first.filter((c) => !c.startsWith("oracle:"))).toEqual([
    "ping:claude-fable-5",
    "probe1m:claude-fable-5",
  ]);

  // Same day: the cached verdict answers; only the oracle re-runs.
  const second: string[] = [];
  const result = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({ ...opts, calls: second }),
    nowMs: () => t0 + 1000,
  });
  expect(second.filter((c) => !c.startsWith("oracle:"))).toEqual([]);
  expect(result.models).toContainEqual({ id: "claude-fable-5", is1m: true });
  expect(result.unlisted).toEqual(["claude-fable-5"]);

  // TTL lapsed: the probes re-run (a revoked model heals within a day).
  const third: string[] = [];
  await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({ ...opts, calls: third }),
    nowMs: () => t0 + day + 1000,
  });
  expect(third).toContain("ping:claude-fable-5");
});

test("transient probe trouble is never cached: the next run probes again", async () => {
  isolate();
  const opts = {
    catalogs: {
      "none": ["claude-haiku-4.5"],
      "vscode-chat": ["claude-haiku-4.5"],
      "copilot-developer-cli": ["claude-haiku-4.5", "claude-sonnet-4.6"],
      "copilot-developer-sandbox": ["claude-haiku-4.5"],
    },
    allowlist: ["claude-fable-5"],
  };
  const t0 = 1_700_000_000_000;
  // A 503 ping is "unknown": the model is excluded THIS run, but no verdict is
  // written -- a wedged-out-for-a-day servable model is the failure mode this stops.
  const first = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({ ...opts, transient: ["claude-fable-5"] }),
    nowMs: () => t0,
  });
  expect(first.unlisted).toEqual([]);

  // Seconds later (same TTL window) the probes run again and the verdict lands.
  const calls: string[] = [];
  const second = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({
      ...opts,
      servable: ["claude-fable-5"],
      oneM: ["claude-fable-5"],
      calls,
    }),
    nowMs: () => t0 + 1000,
  });
  expect(calls).toContain("ping:claude-fable-5");
  expect(second.models).toContainEqual({ id: "claude-fable-5", is1m: true });
});

test("a non-200 2xx ping is unknown: never servable, never cached", async () => {
  isolate();
  const opts = {
    catalogs: {
      "none": ["claude-haiku-4.5"],
      "vscode-chat": ["claude-haiku-4.5"],
      "copilot-developer-cli": ["claude-haiku-4.5", "claude-sonnet-4.6"],
      "copilot-developer-sandbox": ["claude-haiku-4.5"],
    },
    allowlist: ["claude-fable-5"],
  };
  const t0 = 1_700_000_000_000;
  // Only the exact 200 is a "yes": a 201 is an unrecognized shape, so the model is
  // excluded this run and NO verdict is written.
  const first = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({ ...opts, odd: ["claude-fable-5"] }),
    nowMs: () => t0,
  });
  expect(first.unlisted).toEqual([]);

  // Same TTL window: nothing was cached, so the ping runs again and can land.
  const calls: string[] = [];
  const second = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({
      ...opts,
      servable: ["claude-fable-5"],
      oneM: ["claude-fable-5"],
      calls,
    }),
    nowMs: () => t0 + 1000,
  });
  expect(calls).toContain("ping:claude-fable-5");
  expect(second.models).toContainEqual({ id: "claude-fable-5", is1m: true });
});

test("servable-yes with a transient 1m probe: listed without 1m, verdict uncached", async () => {
  isolate();
  const opts = {
    catalogs: {
      "none": ["claude-haiku-4.5"],
      "vscode-chat": ["claude-haiku-4.5"],
      "copilot-developer-cli": ["claude-haiku-4.5", "claude-sonnet-4.6"],
      "copilot-developer-sandbox": ["claude-haiku-4.5"],
    },
    allowlist: ["claude-fable-5"],
    servable: ["claude-fable-5"],
    oneM: ["claude-fable-5"],
  };
  const t0 = 1_700_000_000_000;
  // The ping said yes but the 1m probe 503'd: the model is listed THIS run (without
  // the 1m window), and no verdict is cached -- a 503 must not deny 1m for a day.
  const first = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({ ...opts, transient1m: ["claude-fable-5"] }),
    nowMs: () => t0,
  });
  expect(first.models).toContainEqual({ id: "claude-fable-5", is1m: false });
  expect(first.unlisted).toEqual(["claude-fable-5"]);

  // Same TTL window: both probes re-run and the full verdict lands.
  const calls: string[] = [];
  const second = await discoverServableClaudeModels("ghu_x", UA, null, {
    fetchImpl: stubFetch({ ...opts, calls }),
    nowMs: () => t0 + 1000,
  });
  expect(calls).toContain("probe1m:claude-fable-5");
  expect(second.models).toContainEqual({ id: "claude-fable-5", is1m: true });
});

test("verdicts are credential-exact: a different token probes for itself", async () => {
  isolate();
  const opts = {
    catalogs: {
      "none": ["claude-haiku-4.5"],
      "vscode-chat": ["claude-haiku-4.5"],
      "copilot-developer-cli": ["claude-haiku-4.5", "claude-sonnet-4.6"],
      "copilot-developer-sandbox": ["claude-haiku-4.5"],
    },
    allowlist: ["claude-fable-5"],
    servable: ["claude-fable-5"],
    oneM: ["claude-fable-5"],
  };
  const t0 = 1_700_000_000_000;
  await discoverServableClaudeModels("ghu_a", UA, null, {
    fetchImpl: stubFetch({ ...opts }),
    nowMs: () => t0,
  });
  // A profile's credential must never inherit the default credential's verdicts:
  // entitlements differ per account, so token B pays its own probes.
  const calls: string[] = [];
  await discoverServableClaudeModels("ghu_b", UA, null, {
    fetchImpl: stubFetch({ ...opts, calls }),
    nowMs: () => t0 + 1000,
  });
  expect(calls).toContain("ping:claude-fable-5");
});
