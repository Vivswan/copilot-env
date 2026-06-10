import { expect, test } from "bun:test";

import {
  assertSingleMode,
  DEFAULT_PROBE_RETRIES,
  type ProbeDescriptor,
  probeDirectWorks,
  resolveDirect,
} from "../src/utils/direct_probe.ts";

// A throwaway descriptor: clears one provider var, points at a fake home env var.
const FAKE_DESCRIPTOR: ProbeDescriptor = {
  cli: "claude",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  args: (prompt) => ["-p", prompt],
  clearEnv: ["ANTHROPIC_AUTH_TOKEN"],
};

type RunProbe = (cliPath: string, args: string[], env: Record<string, string>) => boolean;

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
      return calls >= 3; // fail twice (transient), then succeed
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
      return false; // never succeeds
    }),
  );
  expect(ok).toBe(false);
  expect(calls).toBe(DEFAULT_PROBE_RETRIES + 1); // initial attempt + retries
});

// --- probeDirectWorks: env sanitization -------------------------------------

test("probeDirectWorks strips the descriptor's provider vars from the child env", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "leaked-token";
  try {
    let seen: Record<string, string> | null = null;
    const ok = probeDirectWorks(
      FAKE_DESCRIPTOR,
      () => {},
      passingDeps((_cli, _args, env) => {
        seen = env;
        return true;
      }),
    );
    expect(ok).toBe(true);
    expect(seen).not.toBeNull();
    const env = seen as unknown as Record<string, string>;
    // The leaked provider var is gone; the temp home + PATH are present.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(env.PATH).toBeTruthy();
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});
