import { writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
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
import type { DirectSmoke } from "../src/copilot_api/endpoint_smoke.ts";
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

test("the probe descriptors carry each CLI's mandatory flags: codex --skip-git-repo-check, claude --bare with --settings", () => {
  // codex refuses to run outside a git repo / trusted dir, and the probe's throwaway home has no
  // trust list -- so the flag is mandatory.
  expect(CODEX_PROBE.args("hi", "/tmp/home", null)).toContain("--skip-git-repo-check");
  // --bare disables settings.json auto-discovery and reads auth ONLY via --settings, so without
  // the explicit path the managed apiKeyHelper never runs and the probe has no auth path.
  const args = CLAUDE_PROBE.args("hi", "/tmp/home", null);
  expect(args).toContain("--bare");
  const i = args.indexOf("--settings");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toMatch(/[\\/]tmp[\\/]home[\\/]settings\.json$/);
});

const FAKE_DESCRIPTOR: ProbeDescriptor = {
  cli: "claude",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  args: (prompt, _home, model) => ["-p", prompt, ...(model === null ? [] : ["--model", model])],
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

/** A bound Copilot smoke with a scripted catalog pick and ping; `pings` counts the wire calls. */
function fakeSmoke(
  pick: { ok: true; model: string } | { ok: false; detail: string } = {
    ok: true,
    model: "claude-fable-5",
  },
  pingOk = true,
): DirectSmoke & { pings: number } {
  const smoke = {
    pings: 0,
    pickModel: () => Promise.resolve(pick),
    ping: () => {
      smoke.pings++;
      return Promise.resolve(
        pingOk ? { ok: true as const } : { ok: false as const, detail: "401" },
      );
    },
  };
  return smoke;
}

// --- summarizeProbeFailure: the reason surfaced on fallback --------------------

test("summarizeProbeFailure: the reason per (status, signal, error, stdout, stderr), marker lines over raw exit, catalog noise skipped, oversized lines cut", () => {
  const noise = `{"id":"gpt-5.5","object":"model","capabilities":{"family":"gpt-5.5"}}`;
  const cases: {
    name: string;
    input: Parameters<typeof summarizeProbeFailure>;
    matches: RegExp;
    omits?: string;
    maxLength?: number;
  }[] = [
    {
      name: "a timeout from the spawn error",
      input: [null, "SIGTERM", "spawnSync ETIMEDOUT", "", ""],
      matches: /timed out after \d+s/,
    },
    {
      name: "a recognizable marker line over the raw exit",
      input: [
        1,
        null,
        undefined,
        '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
        "",
      ],
      matches: /401 Unauthorized/,
    },
    {
      name: "codex's model-catalog noise skipped",
      input: [1, null, undefined, noise, "ERROR auth: token refresh failed"],
      matches: /token refresh failed/,
      omits: "capabilities",
    },
    {
      name: "a non-timeout spawn error message",
      input: [null, null, "spawn codex ENOENT", "", ""],
      matches: /ENOENT/,
    },
    {
      name: "the raw exit when nothing else is available",
      input: [7, null, undefined, "", ""],
      matches: /^exit 7$/,
    },
    {
      name: "an oversized reason line truncated",
      input: [1, null, undefined, `error: ${"x".repeat(500)}`, ""],
      matches: /^error: x+\.\.\.$/,
      maxLength: 203, // 200 chars + the "..." marker
    },
  ];
  for (const c of cases) {
    const reason = summarizeProbeFailure(...c.input);
    expect(reason, c.name).toMatch(c.matches);
    if (c.omits !== undefined) expect(reason, c.name).not.toContain(c.omits);
    if (c.maxLength !== undefined) expect(reason.length, c.name).toBeLessThanOrEqual(c.maxLength);
  }
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

test("probeDirectWorks: with no CLI to run, the endpoint smoke's verdict decides, and no smoke means the proxy; the CLI probe never runs", async () => {
  // Both miss arms (not found; the look itself FAILED) consult the smoke when there is one, since
  // it needs no binary; without one they fall back to the proxy before any model call, and a
  // failed look never borrows the proven arm's "not found" advice.
  const cases: { launchFailed: boolean; smoke: boolean | null; expected: boolean }[] = [
    { launchFailed: false, smoke: null, expected: false },
    { launchFailed: true, smoke: null, expected: false },
    { launchFailed: false, smoke: true, expected: true },
    { launchFailed: false, smoke: false, expected: false },
    { launchFailed: true, smoke: true, expected: true },
  ];
  for (const c of cases) {
    let probeCalls = 0;
    const verdict = await probeDirectWorks(
      FAKE_DESCRIPTOR,
      () => {},
      c.smoke === null ? null : fakeSmoke(undefined, c.smoke),
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

test("probeDirectWorks: a CLI that ran and failed is final; the endpoint ping is never consulted", async () => {
  // An endpoint that answers cannot prove the CLI's own auth path, so falling to it here would
  // wire a Direct config the installed CLI just demonstrated it cannot use.
  const smoke = fakeSmoke();
  const ok = await probeDirectWorks(
    FAKE_DESCRIPTOR,
    () => {},
    smoke,
    passingDeps(() => ({ ok: false })),
  );
  expect([ok, smoke.pings]).toEqual([false, 0]);
});

// --- probeDirectWorks: no drivable model means no CLI run ----------------------

test("probeDirectWorks: a catalog with no drivable model is the proxy before the CLI runs", async () => {
  // Spawning the CLI without a pin would hand the verdict back to the model it picks itself, the
  // exact fall this probe exists to avoid; the null-credential arm is pinned through detect*Direct.
  let probeCalls = 0;
  const verdict = await probeDirectWorks(
    FAKE_DESCRIPTOR,
    () => {},
    fakeSmoke({ ok: false, detail: "no model on the messages wire in the catalog" }),
    passingDeps(() => {
      probeCalls++;
      return { ok: true };
    }),
  );
  expect([verdict, probeCalls]).toEqual([false, 0]);
});

// --- probeDirectWorks: retry on transient failure ---------------------------

test("probeDirectWorks retries the live smoke call: Direct once an attempt passes, the proxy after the initial attempt plus DEFAULT_PROBE_RETRIES", async () => {
  const cases: { name: string; passesOn: number | null; ok: boolean; calls: number }[] = [
    { name: "passes on the third attempt", passesOn: 3, ok: true, calls: 3 },
    { name: "never passes", passesOn: null, ok: false, calls: DEFAULT_PROBE_RETRIES + 1 },
  ];
  for (const c of cases) {
    let calls = 0;
    const ok = await probeDirectWorks(
      FAKE_DESCRIPTOR,
      () => {}, // no-op writeDirectConfig
      fakeSmoke(),
      passingDeps(() => {
        calls++;
        return { ok: c.passesOn !== null && calls >= c.passesOn };
      }),
    );
    expect({ name: c.name, ok, calls }).toEqual({ name: c.name, ok: c.ok, calls: c.calls });
  }
});

// --- probeDirectWorks: the child's working directory ------------------------

test("probeDirectWorks spawns the CLI from inside the throwaway home, never the caller's cwd", async () => {
  // Both CLIs read project-level config from the working directory (a repo's .claude/settings.json,
  // codex project trust), so a probe run from the caller's cwd would judge that project's wiring.
  // The "CLI" is deno itself, running a script the config writer dropped into the home; it exits 0
  // only when the process cwd IS that home (realpaths: macOS tmp dirs live behind a symlink).
  const script = "cwd_check.mts";
  const descriptor: ProbeDescriptor = {
    cli: "deno",
    homeEnvVar: "CLAUDE_CONFIG_DIR",
    args: (_prompt, home) => ["run", "--allow-read", join(home, script)],
  };
  const ok = await probeDirectWorks(
    descriptor,
    (home) =>
      writeFileSync(
        join(home, script),
        "Deno.exit(Deno.realPathSync(Deno.cwd()) === Deno.realPathSync(import.meta.dirname) ? 0 : 3);\n",
      ),
    fakeSmoke(),
    { findCommand: () => ({ path: process.execPath }), retries: 0, retryDelayMs: 0 },
  );
  expect(ok).toBe(true);
});

test("probeDirectWorks anchors a relative CLI path to the caller's cwd before the child leaves it", async () => {
  // `command -v` under dash answers with the relative form for a relative or empty PATH entry
  // (./node_modules/.bin/codex, or a bare `codex` for one in the caller's dir); spawned from
  // inside the temp home that path is ENOENT and the verdict would fall to the proxy. Windows
  // findCommand answers with a bare name on purpose (PATH resolves it), so the POSIX shape alone
  // is pinned here.
  if (process.platform === "win32") return;
  let seen: { cliPath: string; path: string[] } | null = null;
  const ok = await probeDirectWorks(FAKE_DESCRIPTOR, () => {}, fakeSmoke(), {
    findCommand: (c: string) => ({ path: join(".", "tools", c) }),
    runProbe: (cliPath, _args, env) => {
      seen = { cliPath, path: (env.PATH ?? "").split(delimiter) };
      return { ok: true };
    },
    retryDelayMs: 0,
  });
  expect(ok).toBe(true);
  const got = seen as unknown as { cliPath: string; path: string[] };
  expect(got.cliPath).toBe(resolve("tools", "claude"));
  // Only the entries this probe ADDED (the CLI's and gh's shared bin dir, once): the inherited PATH
  // may itself carry "." or the like.
  const inherited = new Set((process.env.PATH ?? "").split(delimiter));
  expect(got.path.filter((p) => !inherited.has(p))).toEqual([resolve("tools")]);
});

// --- probeDirectWorks: env sanitization -------------------------------------

test("the real probe child never sees a provider variable the parent shell exported", async () => {
  // The env the probe builds omits the provider families (pinned by the test below), but on Deno
  // spawnSync merges the parent's variables back into the child whatever `env` says (2.9.6,
  // verified): a shell ANTHROPIC_BASE_URL at a running proxy would answer the Claude smoke
  // prompt and mint a Direct verdict the proxy earned. Only a REAL child can see that.
  const saved = {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4141";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:4141/v1";
  const script = "env_check.mts";
  const descriptor: ProbeDescriptor = {
    cli: "deno",
    homeEnvVar: "CLAUDE_CONFIG_DIR",
    args: (_prompt, home) => ["run", "--allow-env", join(home, script)],
  };
  try {
    const ok = await probeDirectWorks(
      descriptor,
      (home) =>
        writeFileSync(
          join(home, script),
          'Deno.exit(Deno.env.has("ANTHROPIC_BASE_URL") || Deno.env.has("OPENAI_BASE_URL") ? 3 : 0);\n',
        ),
      fakeSmoke(),
      { findCommand: () => ({ path: process.execPath }), retries: 0, retryDelayMs: 0 },
    );
    expect(ok).toBe(true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

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
      fakeSmoke(),
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
