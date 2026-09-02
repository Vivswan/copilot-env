// Profile-aware `agent health`: the named-target sweep, the profile.consistency
// check, named-target severity (profile-carrying fix strings), the --profile
// narrowing, and the zero-writes invariant over a home with seeded profiles.

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PROBE, CODEX_PROBE } from "../src/agents/live_probe.ts";
import { proxyHelperCommand } from "../src/claude/config.ts";
import { configureCodexConfig } from "../src/codex/config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { profileHome } from "../src/copilot_api/paths.ts";
import { openaiBaseUrl, proxyLoopbackOrigin } from "../src/copilot_api/port.ts";
import { parseProfileName, type Profile, type ProfileName } from "../src/copilot_api/profile.ts";
import { exitCodeFor, worstStatus } from "../src/health/aggregate.ts";
import {
  checkClaude,
  checkCodex,
  checkProfileAuth,
  checkProfileConsistency,
  checkRuntimeIdentity,
  checkRuntimeOrphan,
  checkRuntimePid,
  checkRuntimePort,
  evaluateAll,
} from "../src/health/checks.ts";
import {
  claudeLiveOmitEnv,
  gatherFacts,
  type ProbeDeps,
  runLiveCli,
  type RuntimeTarget,
} from "../src/health/probe.ts";
import { expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir, writeRunState } from "./helpers.ts";

const restoreEnv = envSnapshot();

// --- fixtures -----------------------------------------------------------------

const P = parseProfileName("p");

/** A named-profile runtime target (healthy homed proxy daemon by default). */
function namedTarget(name: string, overrides: Partial<RuntimeTarget> = {}): RuntimeTarget {
  return {
    profile: parseProfileName(name),
    slot: {
      exists: true,
      provider: "gh-token",
      mode: "proxy",
      storedToken: true,
      integrationIdentity: null,
    },
    homeExists: true,
    proxyExpected: true,
    port: 4242,
    portPersisted: true,
    daemonProbed: true,
    reachable: true,
    trackedPid: 4321,
    pidTracked: true,
    pidAlive: true,
    identityConfirmed: true,
    paths: {
      home: "/h/profiles/p",
      configFile: "/h/profiles/p/config.json",
      runDir: "/h/profiles/p/.run/x",
      stateFile: "/h/profiles/p/.run/x/.state.json",
      logFile: "/h/profiles/p/.run/x/.log",
      sqliteDb: "/h/profiles/p/.run/x/db.sqlite",
    },
    watchdog: {
      autoStart: false,
      idleTimeoutMs: 3_600_000,
      lastEnsureAt: null,
      lastRequestMs: null,
      now: 1_000_000_000,
    },
    ...overrides,
  };
}

/** Overrides that keep gatherFacts offline and deterministic (no ps/gh spawns). */
function offlineDeps(extra: Partial<ProbeDeps> = {}): Partial<ProbeDeps> {
  return {
    reach: async () => false,
    proxyIdentity: async () => null,
    isTrackedPid: async () => false,
    codexDirectAuth: () => Promise.resolve({ command: null, authenticated: false }),
    ...extra,
  };
}

// --- profile.consistency (pure) -----------------------------------------------

test("profile.consistency: slot + home agreement per mode", () => {
  // Proxy slot + home: agree.
  const proxyOk = checkProfileConsistency(namedTarget("p"));
  expect(proxyOk.status).toBe("ok");
  expect(proxyOk.profile).toBe(P);
  expect(proxyOk.scopes).toContain("runtime");

  // Direct slot: no home needed (with or without a leftover one).
  const direct = checkProfileConsistency(
    namedTarget("p", {
      slot: {
        exists: true,
        provider: "gh-token",
        mode: "direct",
        storedToken: true,
        integrationIdentity: null,
      },
      homeExists: false,
      proxyExpected: false,
    }),
  );
  expect(direct.status).toBe("ok");
  expect(direct.detail).toContain("direct");
});

test("profile.consistency: home without a slot warns half-created with both repair paths", () => {
  const half = checkProfileConsistency(
    namedTarget("p", {
      slot: {
        exists: false,
        provider: null,
        mode: null,
        storedToken: false,
        integrationIdentity: null,
      },
      homeExists: true,
    }),
  );
  expect(half.status).toBe("warn");
  expect(half.detail).toContain("half-created");
  expect(half.fix).toContain("agent profile --add p");
  expect(half.fix).toContain("agent profile --del p");
});

test("profile.consistency: proxy slot without a home warns wiring-incomplete", () => {
  const homeless = checkProfileConsistency(
    namedTarget("p", { homeExists: false, portPersisted: false }),
  );
  expect(homeless.status).toBe("warn");
  expect(homeless.detail).toContain("no daemon home");
  expect(homeless.fix).toBe("agent profile --add p");
});

test("profile.consistency: a slot with no recorded mode warns", () => {
  const modeless = checkProfileConsistency(
    namedTarget("p", {
      slot: {
        exists: true,
        provider: "gh-token",
        mode: null,
        storedToken: true,
        integrationIdentity: null,
      },
    }),
  );
  expect(modeless.status).toBe("warn");
  expect(modeless.detail).toContain("no mode recorded");
  expect(modeless.fix).toContain("agent profile --add p");
});

test("profile.consistency rejects the default target (named-only check)", () => {
  expect(() => checkProfileConsistency(namedTarget("p", { profile: null }))).toThrow(
    "named-target",
  );
});

// --- named-target severity (pure) ---------------------------------------------

test("named target down + auto-start off fails with the profile-addressed start fix", () => {
  const down = namedTarget("p", {
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    pidAlive: false,
    identityConfirmed: null,
  });
  const port = checkRuntimePort(down);
  expect(port.status).toBe("fail");
  expect(port.fix).toBe("agent start --profile p");
  expect(port.profile).toBe(P);
  const pid = checkRuntimePid(down);
  expect(pid.status).toBe("fail");
  expect(pid.fix).toBe("agent start --profile p");
});

test("named target down + auto-start on reads ok (starts on demand)", () => {
  const down = namedTarget("p", {
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    pidAlive: false,
    identityConfirmed: null,
  });
  down.watchdog = { ...down.watchdog, autoStart: true };
  const port = checkRuntimePort(down);
  expect(port.status).toBe("ok");
  expect(port.detail).toContain("starts on demand (auto-start on)");
  expect(port.fix).toBeUndefined();
  expect(checkRuntimePid(down).status).toBe("ok");
});

test("a foreign listener on a named profile's port is a real misroute warning", () => {
  // The profile's configs bake THIS port, so a foreign occupant genuinely
  // captures the profile's traffic -- unlike the default both-direct case.
  const foreign = checkRuntimeIdentity(namedTarget("p", { identityConfirmed: false }));
  expect(foreign.status).toBe("warn");
  expect(foreign.detail).toContain("misroute");
  expect(foreign.fix).toBe(
    "free the port (stop the foreign process), then agent start --profile p",
  );
});

test("an orphaned named daemon's fix addresses the profile on both commands", () => {
  const orphan = checkRuntimeOrphan(
    namedTarget("p", { pidTracked: false, trackedPid: null, identityConfirmed: true }),
  );
  expect(orphan.status).toBe("warn");
  expect(orphan.fix).toBe(
    "agent stop --profile p, then agent start --profile p (re-tracks the daemon)",
  );
});

// --- evaluateAll row gating -----------------------------------------------------

test("a named DIRECT profile yields only the consistency check, no daemon rows", () => {
  const direct = namedTarget("p", {
    slot: {
      exists: true,
      provider: "gh-token",
      mode: "direct",
      storedToken: true,
      integrationIdentity: null,
    },
    homeExists: false,
    proxyExpected: false,
    portPersisted: false,
    daemonProbed: false,
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    pidAlive: false,
    identityConfirmed: null,
  });
  const results = evaluateAll("full", { runtimes: [direct] });
  expect(results.map((r) => r.id)).toEqual(["profile.consistency"]);
  expect(exitCodeFor(results)).toBe(0);
});

test("a homeless proxy slot yields only the consistency warn (no probes of a candidate port)", () => {
  const homeless = namedTarget("p", {
    homeExists: false,
    portPersisted: false,
    daemonProbed: false,
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    pidAlive: false,
    identityConfirmed: null,
  });
  const results = evaluateAll("full", { runtimes: [homeless] });
  expect(results.map((r) => r.id)).toEqual(["profile.consistency"]);
  expect(worstStatus(results)).toBe("warn");
});

test("a homed proxy profile whose port is not persisted here says so instead of plain agreement", () => {
  // The daemon was never probed (no persisted port), so its consistency line
  // must not read as "daemon fine" -- it says what is missing on this host.
  const unstarted = namedTarget("p", {
    portPersisted: false,
    daemonProbed: false,
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    pidAlive: false,
    identityConfirmed: null,
  });
  const results = evaluateAll("full", { runtimes: [unstarted] });
  expect(results.map((r) => r.id)).toEqual(["profile.consistency"]);
  expect(results[0]?.status).toBe("ok");
  expect(results[0]?.detail).toContain("no port recorded on this host");
  expect(results[0]?.detail).toContain("agent start --profile p");
});

test("a homed proxy profile with a persisted port yields the full daemon row block", () => {
  const results = evaluateAll("full", { runtimes: [namedTarget("p")] });
  expect(results.map((r) => r.id)).toEqual([
    "profile.consistency",
    "runtime.port",
    "runtime.pid",
    "runtime.paths",
    "runtime.watchdog",
    "runtime.identity",
    "runtime.orphan",
  ]);
  for (const r of results) expect(r.profile).toBe(P);
});

test("the sweep renders default rows before profile rows (gather order preserved)", () => {
  const results = evaluateAll("full", {
    runtimes: [namedTarget("p", { profile: null, slot: null, homeExists: null }), namedTarget("p")],
  });
  const profiles = results.map((r) => r.profile);
  expect(profiles.slice(0, 6)).toEqual([null, null, null, null, null, null]);
  expect(new Set(profiles.slice(6))).toEqual(new Set([P]));
});

// --- profile auth slot line -----------------------------------------------------

const RESOLVES = { storedToken: true, ghAuthenticated: false };

test("checkProfileAuth: a provisioned slot reads ok with provider + mode + identity", () => {
  const ok = checkProfileAuth(
    P,
    {
      provider: "gh-token",
      mode: "proxy",
      integrationIdentity: "copilot-developer-cli",
    },
    RESOLVES,
  );
  expect(ok.status).toBe("ok");
  expect(ok.profile).toBe(P);
  expect(ok.group).toBe("auth");
  expect(ok.detail).toContain("gh-token");
  expect(ok.detail).toContain("copilot-developer-cli");
  expect(ok.detail).toContain("agent auth --get --profile p");
  expect(ok.detail).toContain("agent start --profile p");

  // A direct slot's usage line never mentions a daemon.
  const direct = checkProfileAuth(
    P,
    { provider: "gh-token", mode: "direct", integrationIdentity: null },
    RESOLVES,
  );
  expect(direct.status).toBe("ok");
  expect(direct.detail).toContain("for Direct");
  expect(direct.detail).not.toContain("daemon");
});

test("checkProfileAuth: a missing credential warns and never falls back to the default", () => {
  const noProvider = checkProfileAuth(
    P,
    { provider: null, mode: "proxy", integrationIdentity: null },
    { storedToken: false, ghAuthenticated: false },
  );
  expect(noProvider.status).toBe("warn");
  expect(noProvider.detail).toContain("never fall back");
  expect(noProvider.fix).toBe("agent profile --add p");

  const noSlot = checkProfileAuth(P, null, { storedToken: false, ghAuthenticated: false });
  expect(noSlot.status).toBe("warn");
  expect(noSlot.fix).toContain("agent profile --add p --direct|--proxy");

  // A slot with no recorded mode needs the explicit-mode re-add (a bare --add
  // has no previous mode to stick to).
  const noMode = checkProfileAuth(
    P,
    { provider: null, mode: null, integrationIdentity: null },
    { storedToken: false, ghAuthenticated: false },
  );
  expect(noMode.fix).toBe("agent profile --add p --direct|--proxy");
});

test("checkProfileAuth: a recorded provider whose credential does not resolve warns", () => {
  // Token provider with no stored token: the slot is provisioned on paper only.
  const tokenGone = checkProfileAuth(
    P,
    { provider: "gh-token", mode: "proxy", integrationIdentity: null },
    { storedToken: false, ghAuthenticated: false },
  );
  expect(tokenGone.status).toBe("warn");
  expect(tokenGone.detail).toContain("no credential resolves");
  expect(tokenGone.fix).toBe("agent auth --profile p");

  // gh-cli provider resolves via a live gh login, not a stored token.
  const ghSlot = {
    provider: "gh-cli" as const,
    mode: "direct" as const,
    integrationIdentity: null,
  };
  expect(checkProfileAuth(P, ghSlot, { storedToken: false, ghAuthenticated: true }).status).toBe(
    "ok",
  );
  const ghDown = checkProfileAuth(P, ghSlot, { storedToken: false, ghAuthenticated: false });
  expect(ghDown.status).toBe("warn");
  expect(ghDown.detail).toContain("gh auth login");
});

// --- per-agent wiring checks, named ---------------------------------------------

test("checkCodex(named): missing wiring warns with the profile re-add fix", () => {
  const unwired = checkCodex(
    {
      home: "/c",
      configExists: false,
      providerSelected: false,
      providerMode: "none",
      modelProvider: null,
      baseUrl: null,
      baseUrlMatches: false,
      envKeyMatches: false,
      providerWired: false,
      envFilePresent: false,
      envKeyInDotenv: false,
      envKeyInEnviron: false,
      tokenAvailable: false,
      directAuth: { command: null, authenticated: false },
      directUsesToken: false,
      directNeedsNoGh: false,
    },
    P,
  );
  expect(unwired.status).toBe("warn");
  expect(unwired.profile).toBe(P);
  expect(unwired.detail).toContain("profile 'p' is not wired into Codex");
  expect(unwired.fix).toBe("agent profile --add p");

  // The unselected-provider message names the profile's own provider id.
  const unselected = checkCodex(
    {
      home: "/c",
      configExists: true,
      providerSelected: false,
      providerMode: "none",
      modelProvider: null,
      baseUrl: null,
      baseUrlMatches: false,
      envKeyMatches: false,
      providerWired: false,
      envFilePresent: false,
      envKeyInDotenv: false,
      envKeyInEnviron: false,
      tokenAvailable: false,
      directAuth: { command: null, authenticated: false },
      directUsesToken: false,
      directNeedsNoGh: false,
    },
    P,
  );
  expect(unselected.status).toBe("warn");
  expect(unselected.detail).toContain('not "copilot-env-p"');
  expect(unselected.fix).toBe("agent profile --add p");
});

test("checkClaude(named): missing wiring warns; a stale proxy port points at the profile re-add", () => {
  const base = {
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings-p.json"),
    settingsExists: false,
    helperPath: null,
    baseUrl: null,
    baseUrlMatches: false,
    providerMode: "none" as const,
    directAuth: { command: null, authenticated: false },
    directUsesToken: false,
  };
  const unwired = checkClaude(base, P);
  expect(unwired.status).toBe("warn");
  expect(unwired.profile).toBe(P);
  expect(unwired.detail).toContain("profile 'p' is not wired into Claude");
  expect(unwired.fix).toBe("agent profile --add p");
  // The default keeps its historical informational verdict.
  expect(checkClaude(base).status).toBe("ok");

  const stale = checkClaude(
    {
      ...base,
      settingsExists: true,
      helperPath: join("/h/.claude", "copilot-proxy-token-p.sh"),
      baseUrl: "http://127.0.0.1:9999",
      baseUrlMatches: false,
      providerMode: "proxy",
    },
    P,
  );
  expect(stale.status).toBe("warn");
  expect(stale.fix).toContain("agent profile --add p");

  // Foreign wiring in the profile's settings file is drift (the default's
  // historical "other is the user's business" verdict does not apply): the
  // profile promises managed wiring, and the writer refuses to overwrite an
  // unmanaged file, so the fix names the removal first.
  const other = checkClaude(
    { ...base, settingsExists: true, helperPath: "/opt/x/helper.sh", providerMode: "other" },
    P,
  );
  expect(other.status).toBe("warn");
  expect(other.detail).toContain("expects managed wiring");
  expect(other.fix).toContain(join("/h/.claude", "settings-p.json"));
  expect(other.fix).toContain("agent profile --add p");
  expect(
    checkClaude({ ...base, helperPath: "/opt/x/helper.sh", providerMode: "other" }).status,
  ).toBe("ok");
});

test("named wiring in the OTHER mode than the slot records warns as an interrupted rewire", () => {
  // Codex: valid DIRECT wiring, but the slot says proxy.
  const codexDirect = checkCodex(
    {
      home: "/c",
      configExists: true,
      providerSelected: true,
      providerMode: "direct",
      modelProvider: "copilot-env-p",
      baseUrl: "https://api.githubcopilot.com",
      baseUrlMatches: true,
      envKeyMatches: true,
      providerWired: true,
      envFilePresent: false,
      envKeyInDotenv: false,
      envKeyInEnviron: false,
      tokenAvailable: false,
      directAuth: { command: null, authenticated: false },
      directUsesToken: true,
      directNeedsNoGh: true,
      expectedMode: "proxy",
    },
    P,
  );
  expect(codexDirect.status).toBe("warn");
  expect(codexDirect.detail).toContain("recorded mode is proxy");
  expect(codexDirect.fix).toBe("agent profile --add p");
  // Matching modes stay green.
  const codexMatch = checkCodex(
    {
      home: "/c",
      configExists: true,
      providerSelected: true,
      providerMode: "direct",
      modelProvider: "copilot-env-p",
      baseUrl: "https://api.githubcopilot.com",
      baseUrlMatches: true,
      envKeyMatches: true,
      providerWired: true,
      envFilePresent: false,
      envKeyInDotenv: false,
      envKeyInEnviron: false,
      tokenAvailable: false,
      directAuth: { command: null, authenticated: false },
      directUsesToken: true,
      directNeedsNoGh: true,
      expectedMode: "direct",
    },
    P,
  );
  expect(codexMatch.status).toBe("ok");

  // Claude: valid PROXY wiring, but the slot says direct.
  const claudeProxy = checkClaude(
    {
      home: "/h/.claude",
      settingsPath: join("/h/.claude", "settings-p.json"),
      settingsExists: true,
      helperPath: join("/h/.claude", "copilot-proxy-token-p.sh"),
      baseUrl: "http://127.0.0.1:4555",
      baseUrlMatches: true,
      providerMode: "proxy",
      directAuth: { command: null, authenticated: false },
      directUsesToken: false,
      expectedMode: "direct",
    },
    P,
  );
  expect(claudeProxy.status).toBe("warn");
  expect(claudeProxy.detail).toContain("recorded mode is direct");
  expect(claudeProxy.fix).toBe("agent profile --add p");
});

// --- --live argv + env scrub -----------------------------------------------------

test("--live --profile argv matches the launchers' profile selection exactly", () => {
  // Codex rides its native selector, in the launcher's spelling; the default
  // argv stays byte-identical to the pre-profile shape.
  expect(CODEX_PROBE.args("hi", "/h", P)).toEqual([
    "exec",
    "--profile",
    "p",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "hi",
  ]);
  expect(CODEX_PROBE.args("hi", "/h")).toEqual([
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "hi",
  ]);
  // Claude loads the profile's own settings file (what `cl --profile` passes).
  expect(CLAUDE_PROBE.args("hi", "/h", P)).toContain(join("/h", "settings-p.json"));
  expect(CLAUDE_PROBE.args("hi", "/h")).toContain(join("/h", "settings.json"));
});

test("a named Claude live probe scrubs ANTHROPIC_BASE_URL; the default scrubs nothing", async () => {
  // The decision: only a named profile drops the var (env would beat its
  // settings file and answer with the DEFAULT wiring).
  expect(claudeLiveOmitEnv(null)).toEqual([]);
  expect(claudeLiveOmitEnv(P)).toEqual(["ANTHROPIC_BASE_URL"]);
  // The mechanism: runLiveCli really drops the requested vars from the child env.
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999";
  try {
    const probe = (omit: readonly string[]) =>
      runLiveCli(
        Deno.execPath(),
        ["eval", "process.exit(process.env.ANTHROPIC_BASE_URL ? 1 : 0)"],
        tmpdir(),
        "CLAUDE_CONFIG_DIR",
        omit,
      );
    expect((await probe(claudeLiveOmitEnv(P))).kind).toBe("ok");
    expect((await probe(claudeLiveOmitEnv(null))).kind).toBe("failed");
  } finally {
    restoreEnv();
  }
});

// --- gatherFacts seams (seeded profile fixtures) --------------------------------

test("the default sweep gathers the default target first, then sorted named targets", async () => {
  const home = isolateProxyHome("copilot-health-sweep-");
  try {
    const store = new CopilotEnvState();
    // b: full proxy profile (slot + home + persisted port). a: direct slot only.
    const a = parseProfileName("a-direct");
    const b = parseProfileName("b-proxy");
    store.setCredential(a, { githubToken: "tok-a", authProvider: "gh-token" });
    store.setProfileMode(a, "direct");
    store.setCredential(b, { githubToken: "tok-b", authProvider: "gh-token" });
    store.setProfileMode(b, "proxy");
    mkdirSync(profileHome(b), { recursive: true });
    writeRunState({ port: 4555 }, b);
    // c: half-created (home only, no slot).
    mkdirSync(join(home, "profiles", "c-half"), { recursive: true });

    const probed: string[] = [];
    const facts = await gatherFacts(
      "proxy",
      {},
      offlineDeps({
        reach: async (url) => {
          probed.push(url);
          return false;
        },
        codexHome: () => join(home, "no-codex"),
        claudeHome: () => join(home, "no-claude"),
      }),
    );
    expect(facts.runtimes?.map((t) => t.profile)).toEqual([null, a, b, parseProfileName("c-half")]);

    const [, aTarget, bTarget, cTarget] = facts.runtimes ?? [];
    // a-direct: no daemon -- proxy not expected, nothing probed.
    expect(aTarget?.proxyExpected).toBe(false);
    expect(aTarget?.homeExists).toBe(false);
    // b-proxy: homed daemon on its persisted reserved port.
    expect(bTarget?.proxyExpected).toBe(true);
    expect(bTarget?.homeExists).toBe(true);
    expect(bTarget?.port).toBe(4555);
    expect(bTarget?.portPersisted).toBe(true);
    // c-half: a homed daemon MAY be running, but with no persisted port there is
    // nothing safe to probe.
    expect(cTarget?.proxyExpected).toBe(true);
    expect(cTarget?.slot?.exists).toBe(false);
    expect(cTarget?.portPersisted).toBe(false);
    // Exactly two reach probes fired: the default port and b's persisted 4555 --
    // never a-direct or c-half's unpersisted candidates.
    expect(probed.some((u) => u.includes(":4555/"))).toBe(true);
    expect(probed).toHaveLength(2);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("the launchers' fast runtime scope never sweeps named profiles", async () => {
  const home = isolateProxyHome("copilot-health-fastscope-");
  try {
    const b = parseProfileName("b-proxy");
    new CopilotEnvState().setProfileMode(b, "proxy");
    mkdirSync(profileHome(b), { recursive: true });
    writeRunState({ port: 4555 }, b);
    const facts = await gatherFacts("runtime", {}, offlineDeps());
    expect(facts.runtimes?.map((t) => t.profile)).toEqual([null]);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("--profile narrows gathering to the named target and excludes account-wide facts", async () => {
  const home = isolateProxyHome("copilot-health-narrow-");
  try {
    const store = new CopilotEnvState();
    store.setCredential(P, { githubToken: "tok-p", authProvider: "gh-token" });
    store.setProfileMode(P, "proxy");
    mkdirSync(profileHome(P), { recursive: true });
    writeRunState({ port: 4555 }, P);

    // Real per-profile wiring for both agents, baked at the profile's port.
    const codexHome = join(home, "codex-home");
    configureCodexConfig(codexHome, {
      mode: "proxy",
      profile: P,
      baseUrl: openaiBaseUrl("4555"),
      quiet: true,
    });
    const claudeHome = join(home, "claude-home");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings-p.json"),
      JSON.stringify({
        "apiKeyHelper": proxyHelperCommand(P),
        "env": { "ANTHROPIC_BASE_URL": proxyLoopbackOrigin(4555) },
      }),
    );

    const probed: string[] = [];
    const facts = await gatherFacts(
      "full",
      { profile: P },
      offlineDeps({
        reach: async (url) => {
          probed.push(url);
          return false;
        },
        codexHome: () => codexHome,
        claudeHome: () => claudeHome,
      }),
    );
    // Only the narrowed runtime target; account-wide fact groups never gathered.
    expect(facts.profile).toBe(P);
    expect(facts.runtimes?.map((t) => t.profile)).toEqual([P]);
    expect(probed).toEqual([`${proxyLoopbackOrigin(4555)}/`]);
    expect(facts.bootstrap).toBeUndefined();
    expect(facts.proxy).toBeUndefined();
    expect(facts.shell).toBeUndefined();
    expect(facts.clis).toBeUndefined();
    expect(facts.tools).toBeUndefined();
    expect(facts.codexHost).toBeUndefined();
    expect(facts.autoupdate).toBeUndefined();
    expect(facts.auth).toBeUndefined();
    // The profile's own credential slot line.
    expect(facts.profileAuth?.name).toBe(P);
    expect(facts.profileAuth?.slot?.provider).toBe("gh-token");
    expect(facts.profileAuth?.slot?.mode).toBe("proxy");
    // Per-agent wiring inspected AS the profile, against the profile's port.
    expect(facts.codex?.providerMode).toBe("proxy");
    expect(facts.codex?.providerWired).toBe(true);
    expect(facts.claude?.providerMode).toBe("proxy");
    expect(facts.claude?.baseUrlMatches).toBe(true);
    expect(facts.claude?.settingsPath).toBe(join(claudeHome, "settings-p.json"));

    // Evaluation: nothing account-wide leaks into the narrowed report.
    const results = evaluateAll("full", facts);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("profile.consistency");
    expect(ids).toContain("runtime.port");
    expect(ids).toContain("setup.auth");
    expect(ids).toContain("setup.codex");
    expect(ids).toContain("setup.claude");
    for (
      const absent of [
        "bootstrap.version",
        "bootstrap.deno",
        "bootstrap.nodeModules",
        "proxy.package",
        "setup.shell",
        "setup.launchers",
        "setup.tool.node",
        "setup.codex-host",
        "setup.autoupdate",
      ]
    ) {
      expect(ids).not.toContain(absent);
    }
    for (const r of results) expect(r.profile).toBe(P);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

// --- zero writes over a seeded home ----------------------------------------------

/** Recursive path -> (size, mtime) snapshot of everything under `dir`. */
function snapshotTree(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.set(`${rel}/`, "dir");
      for (const [k, v] of snapshotTree(full, `${rel}/`)) out.set(k, v);
    } else {
      const s = statSync(full);
      out.set(rel, `${s.size}:${s.mtimeMs}`);
    }
  }
  return out;
}

test("health gathering does zero writes over a home with seeded profiles", async () => {
  // Sweep + narrowed runs must create/modify nothing: no port reservation for
  // the homeless proxy slot, no state/activity/home creation anywhere.
  const home = isolateProxyHome("copilot-health-zerowrites-");
  try {
    const store = new CopilotEnvState();
    store.setCredential(P, { githubToken: "tok-p", authProvider: "gh-token" });
    store.setProfileMode(P, "proxy");
    mkdirSync(profileHome(P), { recursive: true });
    writeRunState({ port: 4555 }, P);
    // A proxy slot with NO home (its resolvePort answer is an unreserved
    // candidate -- resolving it must not persist anything).
    const q = parseProfileName("q-homeless");
    store.setCredential(q, { githubToken: "tok-q", authProvider: "gh-token" });
    store.setProfileMode(q, "proxy");
    // A half-created home with no slot.
    mkdirSync(join(home, "profiles", "r-half"), { recursive: true });

    const before = snapshotTree(home);
    const deps = offlineDeps({
      codexHome: () => join(home, "no-codex"),
      claudeHome: () => join(home, "no-claude"),
    });
    await gatherFacts("proxy", {}, deps); // the default sweep
    await gatherFacts("full", { profile: P }, deps); // narrowed, homed proxy
    await gatherFacts("full", { profile: q }, deps); // narrowed, homeless slot
    await gatherFacts("runtime", { profile: parseProfileName("r-half") }, deps);
    const after = snapshotTree(home);
    expect(after).toEqual(before);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("gatherFacts narrowed to a DIRECT profile inspects direct wiring with the profile's credential", async () => {
  const home = isolateProxyHome("copilot-health-narrowdirect-");
  try {
    const store = new CopilotEnvState();
    store.setCredential(P, { githubToken: "tok-p", authProvider: "gh-token" });
    store.setProfileMode(P, "direct");

    const codexHome = join(home, "codex-home");
    configureCodexConfig(codexHome, { mode: "direct", profile: P, quiet: true });

    const facts = await gatherFacts(
      "codex",
      { profile: P },
      offlineDeps({
        codexHome: () => codexHome,
        claudeHome: () => join(home, "no-claude"),
      }),
    );
    // The profile-addressed managed auth block reads as direct + wired, and the
    // slot's stored token means Direct needs no gh.
    expect(facts.codex?.providerMode).toBe("direct");
    expect(facts.codex?.providerWired).toBe(true);
    expect(facts.codex?.directNeedsNoGh).toBe(true);
    expect(facts.codex?.provider).toBe("gh-token");
    const results = evaluateAll("codex", facts);
    expect(results.map((r) => r.id)).toEqual(["setup.codex"]);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.profile).toBe(P);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

// --- --live narrowing --------------------------------------------------------------

test("--live --profile routes both live probes through the profile's wiring", async () => {
  const home = isolateProxyHome("copilot-health-livenarrow-");
  try {
    new CopilotEnvState().setProfileMode(P, "direct");
    const seen: { agent: string; home: string; profile: Profile }[] = [];
    const facts = await gatherFacts(
      "full",
      { live: true, profile: P },
      offlineDeps({
        codexHome: () => join(home, "codex-home"),
        claudeHome: () => join(home, "claude-home"),
        codexLive: async (h, profile) => {
          seen.push({ agent: "codex", home: h, profile });
          return { kind: "skipped" };
        },
        claudeLive: async (h, profile) => {
          seen.push({ agent: "claude", home: h, profile });
          return { kind: "skipped" };
        },
      }),
    );
    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call.profile).toBe(P);
    expect(facts.codexLive?.kind).toBe("skipped");
    expect(facts.claudeLive?.kind).toBe("skipped");
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("the default sweep never runs per-profile live probes", async () => {
  const home = isolateProxyHome("copilot-health-livesweep-");
  try {
    const b = parseProfileName("b-proxy");
    new CopilotEnvState().setProfileMode(b, "proxy");
    mkdirSync(profileHome(b), { recursive: true });
    const liveProfiles: Profile[] = [];
    await gatherFacts(
      "full",
      { live: true },
      offlineDeps({
        codexHome: () => join(home, "no-codex"),
        claudeHome: () => join(home, "no-claude"),
        shellTargets: () => [],
        commandResolved: () => null,
        readAutoupdate: () => ({
          enabled: false,
          lastCheckMs: 0,
          lastResult: "",
          cooldownDays: 7,
        }),
        codexLive: async (_h, profile) => {
          liveProfiles.push(profile);
          return { kind: "skipped" };
        },
        claudeLive: async (_h, profile) => {
          liveProfiles.push(profile);
          return { kind: "skipped" };
        },
      }),
    );
    // Exactly the default's two probes -- never one per named profile.
    expect(liveProfiles).toEqual([null, null]);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

// --- named profile name type guard (ids stay per-target unique) --------------------

test("profile.consistency and setup.auth reuse ids across targets, disambiguated by profile", () => {
  const results = evaluateAll("full", {
    profile: null,
    runtimes: [namedTarget("p"), namedTarget("q-two")],
  });
  const consistency = results.filter((r) => r.id === "profile.consistency");
  expect(consistency.map((r) => r.profile)).toEqual([P, "q-two" as ProfileName]);
});
