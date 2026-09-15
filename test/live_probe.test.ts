import {
  CLAUDE_PROBE,
  CODEX_CATALOG_NOISE_RE,
  CODEX_PROBE,
  DEFAULT_PROBE_RETRIES,
  type ProbeDescriptor,
  probeDirectWorks,
  type ProbeOutcome,
  summarizeProbeFailure,
} from "../src/agents/live_probe.ts";
import { ghAuthVerdict, ghTokenFromEnv } from "../src/copilot_api/gh_cli.ts";
import { expect, test } from "./helpers/testing.ts";

// The one catalog-noise filter shared by summarizeProbeFailure and formatLiveFailure
// (src/health/probe.ts).
test("CODEX_CATALOG_NOISE_RE matches catalog dump lines and not real errors", () => {
  expect(CODEX_CATALOG_NOISE_RE.test('{"object": "model", "id": "gpt-5.5"}')).toBe(true);
  expect(CODEX_CATALOG_NOISE_RE.test('"capabilities": {"family": "gpt"}')).toBe(true);
  expect(CODEX_CATALOG_NOISE_RE.test('"model_picker_enabled": true')).toBe(true);
  expect(CODEX_CATALOG_NOISE_RE.test("ERROR: 401 Unauthorized")).toBe(false);
});

// --- probe args --------------------------------------------------------------

test("CODEX_PROBE passes --skip-git-repo-check so a non-git cwd can't fail the probe", () => {
  // codex refuses to run outside a git repo / trusted dir, and the probe's
  // throwaway home has no trust list -- so the flag is mandatory.
  expect(CODEX_PROBE.args("hi", "/tmp/home")).toContain("--skip-git-repo-check");
});

test("CLAUDE_PROBE pairs --bare with --settings so the apiKeyHelper is loaded", () => {
  // --bare disables settings.json auto-discovery and reads auth ONLY via
  // --settings, so without the explicit path the managed apiKeyHelper never
  // runs and the probe has no auth path (always fails).
  const args = CLAUDE_PROBE.args("hi", "/tmp/home");
  expect(args).toContain("--bare");
  const i = args.indexOf("--settings");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toMatch(/[\\/]tmp[\\/]home[\\/]settings\.json$/);
});

const FAKE_DESCRIPTOR: ProbeDescriptor = {
  cli: "claude",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  args: (prompt) => ["-p", prompt],
};

type RunProbe = (cliPath: string, args: string[], env: Record<string, string>) => ProbeOutcome;

// retryDelayMs 0: the retry cases would otherwise wait out the real backoff.
function passingDeps(runProbe: RunProbe) {
  return {
    findCommand: (c: string) => ({ path: `/bin/${c}` }),
    runProbe,
    retryDelayMs: 0,
  };
}

// --- summarizeProbeFailure: the reason surfaced on fallback --------------------

test("summarizeProbeFailure reports a timeout from the spawn error", () => {
  expect(summarizeProbeFailure(null, "SIGTERM", "spawnSync ETIMEDOUT", "", "")).toMatch(
    /timed out after \d+s/,
  );
});

test("summarizeProbeFailure prefers a recognizable marker line over raw exit", () => {
  const stdout = '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}';
  expect(summarizeProbeFailure(1, null, undefined, stdout, "")).toContain("401 Unauthorized");
});

test("summarizeProbeFailure skips codex's model-catalog noise", () => {
  const noise = `{"id":"gpt-5.5","object":"model","capabilities":{"family":"gpt-5.5"}}`;
  const real = "ERROR auth: token refresh failed";
  const reason = summarizeProbeFailure(1, null, undefined, noise, real);
  expect(reason).toContain("token refresh failed");
  expect(reason).not.toContain("capabilities");
});

test("summarizeProbeFailure falls back to a non-timeout spawn error message", () => {
  expect(summarizeProbeFailure(null, null, "spawn codex ENOENT", "", "")).toContain("ENOENT");
});

test("summarizeProbeFailure reports the raw exit when nothing else is available", () => {
  expect(summarizeProbeFailure(7, null, undefined, "", "")).toBe("exit 7");
});

test("summarizeProbeFailure truncates an oversized reason line", () => {
  const huge = `error: ${"x".repeat(500)}`;
  const reason = summarizeProbeFailure(1, null, undefined, huge, "");
  expect(reason.length).toBeLessThanOrEqual(203); // 200 chars + the "..." marker
  expect(reason.endsWith("...")).toBe(true);
});

// --- the gh-token env vars ------------------------------------------------------

test("ghTokenFromEnv: precedence COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN, trims, null when unset", () => {
  const saved = {
    COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  try {
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    expect(ghTokenFromEnv()).toBeNull();
    // A blank/whitespace value is treated as unset (falls through).
    expect(ghTokenFromEnv({ GH_TOKEN: "   " })).toBeNull();
    expect(ghTokenFromEnv({ GITHUB_TOKEN: "  ghu_g  " })).toBe("ghu_g");
    expect(ghTokenFromEnv({ COPILOT_GITHUB_TOKEN: "c", GH_TOKEN: "g", GITHUB_TOKEN: "gh" })).toBe(
      "c",
    );
    expect(ghTokenFromEnv({ GH_TOKEN: "g", GITHUB_TOKEN: "gh" })).toBe("g");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// --- gh verdicts (src/copilot_api/gh_cli.ts) ------------------------------------

test("ghAuthVerdict: exit 0 proves auth, a completed nonzero disproves it, a dead spawn proves nothing", () => {
  expect(ghAuthVerdict({ status: 0 })).toBe(true);
  expect(ghAuthVerdict({ status: 1 })).toBe(false); // gh RAN and said "not authenticated"
  // A spawn that never completed checked nothing, so neither confident verdict may be minted.
  expect(ghAuthVerdict({ status: null, error: new Error("spawnSync ETIMEDOUT") })).toBe("unproven");
  expect(ghAuthVerdict({ status: null })).toBe("unproven");
});

// --- probeDirectWorks: a missing or uncheckable CLI ----------------------------
//
// With no endpoint smoke to consult, both miss arms fall back to the proxy without a model call,
// and a look that FAILED (the command probe never completed) never borrows the proven arm's
// "not found" advice.
test("probeDirectWorks: no CLI and no endpoint smoke means proxy before any smoke call", async () => {
  let probeCalls = 0;
  const deps = {
    runProbe: () => {
      probeCalls++;
      return { ok: true };
    },
    retryDelayMs: 0,
  };
  const missing = await probeDirectWorks(FAKE_DESCRIPTOR, () => {}, null, {
    ...deps,
    findCommand: () => ({ path: null }),
  });
  const failedLook = await probeDirectWorks(FAKE_DESCRIPTOR, () => {}, null, {
    ...deps,
    findCommand: () => ({ path: null, launchFailed: true as const }),
  });
  expect([missing, failedLook, probeCalls]).toEqual([false, false, 0]);
});

// --- probeDirectWorks: the endpoint smoke decides when no CLI ran ---------------

test("probeDirectWorks: a missing CLI consults the endpoint smoke, whose verdict decides", async () => {
  // The uncheckable-look arm consults it too: the smoke needs no binary either way.
  const cases: { launchFailed: boolean; smokeOk: boolean; expected: boolean }[] = [
    { launchFailed: false, smokeOk: true, expected: true },
    { launchFailed: false, smokeOk: false, expected: false },
    { launchFailed: true, smokeOk: true, expected: true },
  ];
  for (const c of cases) {
    let probeCalls = 0;
    const verdict = await probeDirectWorks(
      FAKE_DESCRIPTOR,
      () => {},
      () => Promise.resolve(c.smokeOk ? { ok: true } : { ok: false, detail: "401" }),
      {
        findCommand: () =>
          c.launchFailed ? { path: null, launchFailed: true as const } : { path: null },
        runProbe: () => {
          probeCalls++;
          return { ok: true };
        },
        retryDelayMs: 0,
      },
    );
    expect({ ...c, verdict, probeCalls }).toEqual({ ...c, verdict: c.expected, probeCalls: 0 });
  }
});

test("probeDirectWorks: a CLI that ran and failed is final; the endpoint smoke is never consulted", async () => {
  // An endpoint that answers cannot prove the CLI's own auth path, so falling to it here would
  // wire a Direct config the installed CLI just demonstrated it cannot use.
  let smokeCalls = 0;
  const ok = await probeDirectWorks(
    FAKE_DESCRIPTOR,
    () => {},
    () => {
      smokeCalls++;
      return Promise.resolve({ ok: true });
    },
    passingDeps(() => ({ ok: false })),
  );
  expect([ok, smokeCalls]).toEqual([false, 0]);
});

// --- probeDirectWorks: retry on transient failure ---------------------------

test("probeDirectWorks retries the live smoke call and succeeds once it passes", async () => {
  let calls = 0;
  const ok = await probeDirectWorks(
    FAKE_DESCRIPTOR,
    () => {}, // no-op writeDirectConfig
    null,
    passingDeps(() => {
      calls++;
      return { ok: calls >= 3 };
    }),
  );
  expect(ok).toBe(true);
  expect(calls).toBe(3);
});

test("probeDirectWorks falls back after exhausting retries", async () => {
  let calls = 0;
  const ok = await probeDirectWorks(
    FAKE_DESCRIPTOR,
    () => {},
    null,
    passingDeps(() => {
      calls++;
      return { ok: false };
    }),
  );
  expect(ok).toBe(false);
  expect(calls).toBe(DEFAULT_PROBE_RETRIES + 1); // initial attempt + retries
});

// --- probeDirectWorks: env sanitization -------------------------------------

test("probeDirectWorks strips provider/CLI env families but keeps gh auth", async () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "leaked-token";
  process.env.OPENAI_BASE_URL = "http://proxy.local";
  process.env.CODEX_API_KEY = "leaked-codex";
  process.env.CLAUDE_CODE_FOO = "leaked-claude";
  process.env.openai_org = "leaked-lowercase"; // case-insensitive match (Windows)
  process.env.CLAUDE_CONFIG_DIR = "leaked-home"; // the home var: temp must override it
  process.env.GH_TOKEN = "keep-me"; // a gh-cli credential resolves through gh -- must survive
  try {
    let seen: Record<string, string> | null = null;
    const ok = await probeDirectWorks(
      FAKE_DESCRIPTOR,
      () => {},
      null,
      passingDeps((_cli, _args, env) => {
        seen = env;
        return { ok: true };
      }),
    );
    expect(ok).toBe(true);
    expect(seen).not.toBeNull();
    const env = seen as unknown as Record<string, string>;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_FOO).toBeUndefined();
    expect(env.openai_org).toBeUndefined();
    expect(env.GH_TOKEN).toBe("keep-me");
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(env.CLAUDE_CONFIG_DIR).not.toBe("leaked-home");
    expect(env.PATH).toBeTruthy();
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.CODEX_API_KEY;
    delete process.env.CLAUDE_CODE_FOO;
    delete process.env.openai_org;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.GH_TOKEN;
  }
});
