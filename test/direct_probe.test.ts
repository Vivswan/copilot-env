import { expect, test } from "bun:test";

import {
  assertSingleMode,
  DEFAULT_PROBE_RETRIES,
  type ProbeDescriptor,
  type ProbeOutcome,
  probeDirectWorks,
  resolveDirect,
  summarizeProbeFailure,
} from "../src/utils/direct_probe.ts";

// A throwaway descriptor: clears one provider var, points at a fake home env var.
const FAKE_DESCRIPTOR: ProbeDescriptor = {
  cli: "claude",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  args: (prompt) => ["-p", prompt],
  clearEnv: ["ANTHROPIC_AUTH_TOKEN"],
};

type RunProbe = (cliPath: string, args: string[], env: Record<string, string>) => ProbeOutcome;

// Deps that pass every cheap gate so the live smoke call is reached; retries fire
// with no real backoff so the suite stays fast.
function passingDeps(runProbe: RunProbe) {
  return {
    resolveCommand: (c: string) => `/bin/${c}`,
    ghAuthOk: () => true,
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
  // A giant model-catalog line must not be picked as the reason.
  const noise = `{"id":"gpt-5.5","object":"model","capabilities":{"family":"gpt-5.5"}}`;
  const real = "ERROR auth: token refresh failed";
  const reason = summarizeProbeFailure(1, null, undefined, noise, real);
  expect(reason).toContain("token refresh failed");
  expect(reason).not.toContain("capabilities");
});

test("summarizeProbeFailure falls back to a non-timeout spawn error message", () => {
  // No marker in the (empty) output: the spawn error itself is the reason.
  expect(summarizeProbeFailure(null, null, "spawn codex ENOENT", "", "")).toContain("ENOENT");
});

test("summarizeProbeFailure reports the raw exit when nothing else is available", () => {
  expect(summarizeProbeFailure(7, null, undefined, "", "")).toBe("exit 7");
});

test("summarizeProbeFailure truncates an oversized reason line", () => {
  const huge = `error: ${"x".repeat(500)}`;
  const reason = summarizeProbeFailure(1, null, undefined, huge, "");
  expect(reason.length).toBeLessThanOrEqual(201); // 200 chars + the ellipsis
  expect(reason.endsWith("…")).toBe(true);
});

// --- assertSingleMode -------------------------------------------------------

test("assertSingleMode allows zero or one mode flag, rejects two or more", () => {
  expect(() => assertSingleMode({})).not.toThrow();
  expect(() => assertSingleMode({ direct: true })).not.toThrow();
  expect(() => assertSingleMode({ proxy: true })).not.toThrow();
  expect(() => assertSingleMode({ auto: true })).not.toThrow();
  for (const combo of [
    { direct: true, proxy: true },
    { direct: true, auto: true },
    { proxy: true, auto: true },
    { direct: true, proxy: true, auto: true },
  ]) {
    expect(() => assertSingleMode(combo)).toThrow(
      "--direct, --proxy, and --auto are mutually exclusive",
    );
  }
});

// --- resolveDirect (the force-vs-probe contract) ----------------------------

test("resolveDirect: --direct/--proxy force without probing; --auto and no-flag probe", () => {
  const detectTrue = () => true;
  const detectFalse = () => false;

  // Forced modes must NOT invoke the probe at all.
  let calls = 0;
  const spy = () => {
    calls++;
    return true;
  };
  expect(resolveDirect({ direct: true }, spy)).toBe(true);
  expect(resolveDirect({ proxy: true }, spy)).toBe(false);
  expect(calls).toBe(0);

  // --auto and no mode flag both run the probe and return its result.
  expect(resolveDirect({ auto: true }, detectTrue)).toBe(true);
  expect(resolveDirect({ auto: true }, detectFalse)).toBe(false);
  expect(resolveDirect({}, detectTrue)).toBe(true); // no flag == auto
  expect(resolveDirect({}, detectFalse)).toBe(false);
});

// --- probeDirectWorks: retry on transient failure ---------------------------

test("probeDirectWorks retries the live smoke call and succeeds once it passes", () => {
  let calls = 0;
  const ok = probeDirectWorks(
    FAKE_DESCRIPTOR,
    () => {}, // no-op writeDirectConfig
    passingDeps(() => {
      calls++;
      return { ok: calls >= 3 }; // fail twice (transient), then succeed
    }),
  );
  expect(ok).toBe(true);
  expect(calls).toBe(3);
});

test("probeDirectWorks falls back after exhausting retries", () => {
  let calls = 0;
  const ok = probeDirectWorks(
    FAKE_DESCRIPTOR,
    () => {},
    passingDeps(() => {
      calls++;
      return { ok: false }; // never succeeds
    }),
  );
  expect(ok).toBe(false);
  expect(calls).toBe(DEFAULT_PROBE_RETRIES + 1); // initial attempt + retries
});

// --- probeDirectWorks: env sanitization -------------------------------------

test("probeDirectWorks strips provider/CLI env families but keeps gh auth", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "leaked-token"; // also in FAKE_DESCRIPTOR.clearEnv
  process.env.OPENAI_BASE_URL = "http://proxy.local";
  process.env.CODEX_API_KEY = "leaked-codex";
  process.env.CLAUDE_CODE_FOO = "leaked-claude";
  process.env.openai_org = "leaked-lowercase"; // case-insensitive match (Windows)
  process.env.CLAUDE_CONFIG_DIR = "leaked-home"; // the home var: temp must override it
  process.env.GH_TOKEN = "keep-me"; // Direct authenticates via gh — must survive
  try {
    let seen: Record<string, string> | null = null;
    const ok = probeDirectWorks(
      FAKE_DESCRIPTOR,
      () => {},
      passingDeps((_cli, _args, env) => {
        seen = env;
        return { ok: true };
      }),
    );
    expect(ok).toBe(true);
    expect(seen).not.toBeNull();
    const env = seen as unknown as Record<string, string>;
    // Every OPENAI_*/ANTHROPIC_*/CODEX_*/CLAUDE_* var is gone (prefix + clearEnv),
    // case-insensitively…
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_FOO).toBeUndefined();
    expect(env.openai_org).toBeUndefined();
    // …gh auth survives, and the probe's own home var wins over the leaked one.
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
