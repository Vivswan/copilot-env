import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { proxyHelperCommand } from "../src/claude/config.ts";
import { configureCodexConfig } from "../src/codex/config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { profileHome } from "../src/copilot_api/paths.ts";
import { openaiBaseUrl, proxyLoopbackOrigin } from "../src/copilot_api/port.ts";
import { parseProfileName, type Profile, type ProfileName } from "../src/copilot_api/profile.ts";
import { worstStatus } from "../src/health/aggregate.ts";
import {
  checkProfileAuth,
  checkProfileConsistency,
  checkRuntimeIdentity,
  checkRuntimeOrphan,
  checkRuntimePid,
  checkRuntimePort,
  evaluateAll,
} from "../src/health/checks.ts";
import { checkClaude, checkCodex } from "../src/health/checks_agents.ts";
import {
  classifyPortState,
  type ClaudeFacts,
  type DaemonProbed,
  type NamedRuntimeTarget,
  type ProfileSlotFacts,
  type RuntimeTarget,
  type WatchdogFacts,
} from "../src/health/facts.ts";
import {
  claudeLiveLaunch,
  claudeLiveOmitEnv,
  codexLiveLaunch,
  type LiveLaunch,
} from "../src/health/live_launch.ts";
import { gatherFacts } from "../src/health/probe.ts";
import { type ProbeDeps, runLiveCli } from "../src/health/probe_deps.ts";
import type { CheckId, CheckResult, CheckStatus } from "../src/health/types.ts";
import { type LaunchDeps, prepareLaunch } from "../src/commands/launch.ts";
import { describe, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers/env.ts";
import { writeRunState } from "./helpers/fixtures.ts";

const restoreEnv = envSnapshot();

// --- fixtures -----------------------------------------------------------------

const P = parseProfileName("p");

// `skipped` turns the daemon probe into a skipped outcome; otherwise PortState is derived through
// the real classifier, so a fixture can never carry a torn ownership verdict.
interface NamedOverrides {
  slot?: ProfileSlotFacts;
  homeExists?: boolean;
  proxyExpected?: boolean;
  port?: number;
  portPersisted?: boolean;
  skipped?: string;
  reachable?: boolean;
  trackedPid?: number | null;
  pidTracked?: boolean;
  /** The tracked-pid identity scan FAILED (probe fact pidScanUnproven). */
  pidScanUnproven?: true;
  pidAlive?: boolean;
  identityConfirmed?: boolean | null;
  watchdog?: WatchdogFacts;
}

function namedTarget(name: string, overrides: NamedOverrides = {}): NamedRuntimeTarget {
  const proxyExpected = overrides.proxyExpected ?? true;
  const raw = {
    reachable: overrides.reachable ?? true,
    trackedPid: overrides.trackedPid === undefined ? 4321 : overrides.trackedPid,
    pidTracked: overrides.pidTracked ?? true,
    pidAlive: overrides.pidAlive ?? true,
    identityConfirmed: overrides.identityConfirmed === undefined
      ? true
      : overrides.identityConfirmed,
  };
  return {
    profile: parseProfileName(name),
    slot: overrides.slot ?? {
      exists: true,
      provider: "gh-token",
      mode: "proxy",
      storedToken: true,
      ghUser: null,
    },
    homeExists: overrides.homeExists ?? true,
    proxyExpected,
    port: overrides.port ?? 4242,
    portPersisted: overrides.portPersisted ?? true,
    probe: overrides.skipped !== undefined ? { kind: "skipped", why: overrides.skipped } : {
      kind: "probed",
      ...raw,
      ...(overrides.pidScanUnproven ? { pidScanUnproven: true as const } : {}),
      portState: classifyPortState({ proxyExpected, ...raw }),
    },
    paths: {
      home: "/h/profiles/p",
      configFile: "/h/profiles/p/config.json",
      runDir: "/h/profiles/p/.run/x",
      stateFile: "/h/profiles/p/.run/x/.state.json",
      logFile: "/h/profiles/p/.run/x/.log",
      sqliteDb: "/h/profiles/p/.run/x/db.sqlite",
    },
    watchdog: overrides.watchdog ?? {
      autoStart: false,
      idleTimeoutMs: 3_600_000,
      lastEnsureAt: null,
      lastRequestMs: null,
      now: 1_000_000_000,
    },
  };
}

function probeOf(t: RuntimeTarget | undefined): DaemonProbed {
  if (!t || t.probe.kind !== "probed") throw new Error("expected a probed runtime target");
  return t.probe;
}

function named(t: RuntimeTarget | undefined): NamedRuntimeTarget {
  if (!t || t.profile === null) throw new Error("expected a named runtime target");
  return t;
}

const runPort = (t: RuntimeTarget) => checkRuntimePort(t, probeOf(t));
const runPid = (t: RuntimeTarget) => checkRuntimePid(t, probeOf(t));
const runIdentity = (t: RuntimeTarget) => checkRuntimeIdentity(t, probeOf(t));
const runOrphan = (t: RuntimeTarget) => checkRuntimeOrphan(t, probeOf(t));

/** Overrides that keep gatherFacts offline and deterministic (no ps/gh spawns). */
function offlineDeps(extra: Partial<ProbeDeps> = {}): Partial<ProbeDeps> {
  return {
    reach: async () => false,
    proxyIdentity: async () => null,
    classifyTrackedPid: async () => "no" as const,
    codexDirectAuth: () => Promise.resolve({ command: null, authenticated: false }),
    ghActiveLogin: () => Promise.resolve(null),
    ...extra,
  };
}

// --- profile.consistency (pure) -----------------------------------------------

test("profile.consistency: the slot and home shape decide status, detail, and fix", () => {
  const slot = (mode: ProfileSlotFacts["mode"], exists = true): ProfileSlotFacts => ({
    exists,
    provider: exists ? "gh-token" : null,
    mode,
    storedToken: exists,
    ghUser: null,
  });
  const rows: {
    name: string;
    overrides: NamedOverrides;
    status: CheckStatus;
    detail?: string;
    fix?: string;
    fixContains?: string[];
  }[] = [
    { name: "proxy slot with its home", overrides: {}, status: "ok" },
    {
      // A direct slot needs no home, leftover or not.
      name: "direct slot, no home",
      overrides: { slot: slot("direct"), homeExists: false, proxyExpected: false },
      status: "ok",
      detail: "direct",
    },
    {
      name: "home without a slot",
      overrides: { slot: slot(null, false), homeExists: true },
      status: "warn",
      detail: "half-created",
      fixContains: ["agent profile p add", "agent profile p del"],
    },
    {
      name: "proxy slot without a home",
      overrides: { homeExists: false, portPersisted: false },
      status: "warn",
      detail: "no daemon home",
      fix: "agent profile p add",
    },
    {
      name: "slot with no recorded mode",
      overrides: { slot: slot(null) },
      status: "warn",
      detail: "no mode recorded",
      fixContains: ["agent profile p add"],
    },
  ];
  for (const row of rows) {
    const r = checkProfileConsistency(namedTarget("p", row.overrides));
    expect(r.status, row.name).toBe(row.status);
    expect(r.profile, row.name).toBe(P);
    expect(r.scopes, row.name).toContain("runtime");
    if (row.detail !== undefined) expect(r.detail, row.name).toContain(row.detail);
    if (row.fix !== undefined) expect(r.fix, row.name).toBe(row.fix);
    for (const needle of row.fixContains ?? []) expect(r.fix, row.name).toContain(needle);
  }
});

// A default target cannot reach checkProfileConsistency: the RuntimeTarget union makes it a compile error.

// --- named-target severity (pure) ---------------------------------------------

test("named daemon verdicts address the profile on every fix", () => {
  const down: NamedOverrides = {
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    pidAlive: false,
    identityConfirmed: null,
  };
  const autoStartOn = { ...namedTarget("p").watchdog, autoStart: true };
  const rows: {
    name: string;
    check: (t: RuntimeTarget) => CheckResult;
    overrides: NamedOverrides;
    status: CheckStatus;
    fix: string | undefined;
    detail?: string;
  }[] = [
    {
      name: "port: down, auto-start off",
      check: runPort,
      overrides: down,
      status: "fail",
      fix: "agent profile p start",
    },
    {
      name: "pid: down, auto-start off",
      check: runPid,
      overrides: down,
      status: "fail",
      fix: "agent profile p start",
    },
    {
      name: "port: down, auto-start on",
      check: runPort,
      overrides: { ...down, watchdog: autoStartOn },
      status: "ok",
      fix: undefined,
      detail: "starts on demand (daemon.auto-start on)",
    },
    {
      name: "pid: down, auto-start on",
      check: runPid,
      overrides: { ...down, watchdog: autoStartOn },
      status: "ok",
      fix: undefined,
    },
    {
      // The profile's configs bake THIS port, so a foreign occupant genuinely captures its traffic.
      name: "identity: foreign listener",
      check: runIdentity,
      overrides: { identityConfirmed: false },
      status: "warn",
      fix: "free the port (stop the foreign process), then agent profile p start",
      detail: "misroute",
    },
    {
      name: "orphan: untracked daemon of ours",
      check: runOrphan,
      overrides: { pidTracked: false, trackedPid: null, identityConfirmed: true },
      status: "warn",
      fix: "agent profile p stop, then agent profile p start (re-tracks the daemon)",
    },
  ];
  for (const row of rows) {
    const r = row.check(namedTarget("p", row.overrides));
    expect(r.status, row.name).toBe(row.status);
    expect(r.fix, row.name).toBe(row.fix);
    expect(r.profile, row.name).toBe(P);
    if (row.detail !== undefined) expect(r.detail, row.name).toContain(row.detail);
  }
});

// --- evaluateAll row gating -----------------------------------------------------

test("evaluateAll gates the daemon rows on a probed proxy target", () => {
  const rows: {
    name: string;
    overrides: NamedOverrides;
    ids: CheckId[];
    worst?: CheckStatus;
    detail?: string[];
  }[] = [
    {
      name: "direct profile",
      overrides: {
        slot: {
          exists: true,
          provider: "gh-token",
          mode: "direct",
          storedToken: true,
          ghUser: null,
        },
        homeExists: false,
        proxyExpected: false,
        portPersisted: false,
        skipped: "no daemon expected (not a proxy-mode target)",
      },
      ids: ["profile.consistency"],
      worst: "ok",
    },
    {
      // No probes of a candidate port.
      name: "homeless proxy slot",
      overrides: { homeExists: false, portPersisted: false, skipped: "no daemon home on disk" },
      ids: ["profile.consistency"],
      worst: "warn",
    },
    {
      // The daemon was never probed, so its consistency line must not read as "daemon fine".
      name: "homed proxy profile whose port is not persisted here",
      overrides: { portPersisted: false, skipped: "no persisted port on this host" },
      ids: ["profile.consistency"],
      worst: "ok",
      detail: ["no port recorded on this host", "agent profile p start"],
    },
    {
      name: "homed proxy profile with a persisted port",
      overrides: {},
      ids: [
        "profile.consistency",
        "runtime.port",
        "runtime.pid",
        "runtime.paths",
        "runtime.watchdog",
        "runtime.identity",
        "runtime.orphan",
      ],
    },
  ];
  for (const row of rows) {
    const results = evaluateAll("full", { runtimes: [namedTarget("p", row.overrides)] });
    expect(results.map((r) => r.id), row.name).toEqual(row.ids);
    for (const r of results) expect(r.profile, row.name).toBe(P);
    if (row.worst !== undefined) expect(worstStatus(results), row.name).toBe(row.worst);
    for (const needle of row.detail ?? []) expect(results[0]?.detail, row.name).toContain(needle);
  }
});

test("the sweep renders default rows before profile rows (gather order preserved)", () => {
  const p = namedTarget("p");
  const defaultTarget: RuntimeTarget = {
    profile: null,
    proxyExpected: p.proxyExpected,
    port: p.port,
    portPersisted: p.portPersisted,
    probe: probeOf(p),
    paths: p.paths,
    watchdog: p.watchdog,
  };
  const results = evaluateAll("full", { runtimes: [defaultTarget, namedTarget("p")] });
  const profiles = results.map((r) => r.profile);
  expect(profiles.slice(0, 6)).toEqual([null, null, null, null, null, null]);
  expect(new Set(profiles.slice(6))).toEqual(new Set([P]));
});

// --- profile auth slot line -----------------------------------------------------

const RESOLVES = { storedToken: true, ghAuthenticated: false };

test("checkProfileAuth: the slot and its credential resolution decide status, detail, and fix", () => {
  const none = { storedToken: false, ghAuthenticated: false };
  const ghSlot = { provider: "gh-cli" as const, mode: "direct" as const };
  const rows: {
    name: string;
    slot: Parameters<typeof checkProfileAuth>[1];
    resolves: Parameters<typeof checkProfileAuth>[2];
    status: CheckStatus;
    detail?: string[];
    exactDetail?: string;
    notDetail?: string;
    fix?: string;
    value?: Record<string, unknown>;
  }[] = [
    {
      name: "provisioned proxy slot",
      slot: { provider: "gh-token", mode: "proxy" },
      resolves: RESOLVES,
      status: "ok",
      detail: ["gh-token", "agent profile p auth --get", "agent profile p start"],
    },
    {
      name: "provisioned direct slot",
      slot: { provider: "gh-token", mode: "direct" },
      resolves: RESOLVES,
      status: "ok",
      detail: ["for Direct"],
      notDetail: "daemon",
    },
    {
      // A missing credential never falls back to the default's.
      name: "no provider recorded",
      slot: { provider: null, mode: "proxy" },
      resolves: none,
      status: "warn",
      detail: ["never fall back"],
      fix: "agent profile p add",
    },
    {
      name: "no slot at all",
      slot: null,
      resolves: none,
      status: "warn",
      fix: "agent profile p add --direct|--proxy",
    },
    {
      // A bare `add` has no previous mode to stick to, so the re-add names the mode.
      name: "no provider and no mode recorded",
      slot: { provider: null, mode: null },
      resolves: none,
      status: "warn",
      fix: "agent profile p add --direct|--proxy",
    },
    {
      // Token provider with no stored token: the slot is provisioned on paper only.
      name: "gh-token slot whose token is gone",
      slot: { provider: "gh-token", mode: "proxy" },
      resolves: none,
      status: "warn",
      detail: ["no credential resolves"],
      fix: "agent profile p auth",
    },
    // gh-cli resolves via a live gh login, not a stored token; the wording names the account.
    {
      name: "gh-cli AUTO, authenticated",
      slot: ghSlot,
      resolves: { ...none, ghAuthenticated: true },
      status: "ok",
    },
    {
      name: "gh-cli AUTO, unauthenticated",
      slot: ghSlot,
      resolves: none,
      status: "warn",
      detail: ["gh auth login"],
    },
    {
      name: "gh-cli AUTO following octocat, unauthenticated",
      slot: ghSlot,
      resolves: { ...none, ghActiveLogin: "octocat" },
      status: "warn",
      detail: ["`gh` is unauthenticated (AUTO - currently account octocat) - run `gh auth login`"],
    },
    {
      // A PINNED slot's proven miss names its account; gh's active login may be fine.
      name: "gh-cli pinned to work-bot, unauthenticated",
      slot: ghSlot,
      resolves: { ...none, ghUser: "work-bot" },
      status: "warn",
      detail: [
        "`gh` is not authenticated as account 'work-bot' - run `gh auth login` for that account",
      ],
    },
    {
      name: "gh-cli pinned to work-bot, authenticated",
      slot: ghSlot,
      resolves: { ...none, ghAuthenticated: true, ghUser: "work-bot" },
      status: "ok",
      detail: ["gh CLI (`gh auth token --user work-bot`)"],
    },
    {
      name: "gh-cli AUTO following octocat, authenticated",
      slot: ghSlot,
      resolves: { ...none, ghAuthenticated: true, ghActiveLogin: "octocat" },
      status: "ok",
      detail: ["gh CLI (`gh auth token`, AUTO - currently account octocat)"],
    },
    {
      // gh was never actually asked, so the confident wording and its advice never render.
      name: "gh-cli with an UNPROVEN gh probe",
      slot: ghSlot,
      resolves: { ...none, ghAuthUnproven: true },
      status: "warn",
      exactDetail: [
        "provider 'gh-cli' is recorded for profile 'p' but its credential could not be checked",
        "could not check gh authentication " +
        "(`gh auth token` did not run to completion; AUTO - follows gh's active account)",
      ].join("\n"),
      fix: "agent profile p auth",
      value: { ghAuthUnproven: true },
    },
  ];
  for (const row of rows) {
    const r = checkProfileAuth(P, row.slot, row.resolves);
    expect(r.status, row.name).toBe(row.status);
    expect(r.profile, row.name).toBe(P);
    expect(r.group, row.name).toBe("auth");
    for (const needle of row.detail ?? []) expect(r.detail, row.name).toContain(needle);
    if (row.exactDetail !== undefined) expect(r.detail, row.name).toBe(row.exactDetail);
    if (row.notDetail !== undefined) expect(r.detail, row.name).not.toContain(row.notDetail);
    if (row.fix !== undefined) expect(r.fix, row.name).toBe(row.fix);
    if (row.value !== undefined) expect(r.value, row.name).toMatchObject(row.value);
  }
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
      credential: "none",
      envFilePresent: false,
      envKeyInDotenv: false,
      envKeyInEnviron: false,
      tokenAvailable: false,
      directAuth: { command: null, authenticated: false },
      directUsesToken: false,
      directNeedsNoGh: false,
      otherReason: null,
    },
    P,
  );
  expect(unwired.status).toBe("warn");
  expect(unwired.profile).toBe(P);
  expect(unwired.detail).toContain("profile 'p' is not wired into Codex");
  expect(unwired.fix).toBe("agent profile p add");

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
      credential: "none",
      envFilePresent: false,
      envKeyInDotenv: false,
      envKeyInEnviron: false,
      tokenAvailable: false,
      directAuth: { command: null, authenticated: false },
      directUsesToken: false,
      directNeedsNoGh: false,
      otherReason: null,
    },
    P,
  );
  expect(unselected.status).toBe("warn");
  expect(unselected.detail).toContain('not "copilot-env-p"');
  expect(unselected.fix).toBe("agent profile p add");
});

test("checkClaude(named): missing wiring warns; a stale proxy port points at the profile re-add", () => {
  // `satisfies` keeps the literal arm narrow so the spreads below can flip arms.
  const base = {
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings-p.json"),
    settingsExists: false,
    wired: false,
    credential: null,
    helperPath: null,
    baseUrl: null,
    baseUrlMatches: false,
    providerMode: "none",
    otherReason: null,
    directAuth: { command: null, authenticated: false },
    directUsesToken: false,
  } satisfies ClaudeFacts;
  const unwired = checkClaude(base, P);
  expect(unwired.status).toBe("warn");
  expect(unwired.profile).toBe(P);
  expect(unwired.detail).toContain("profile 'p' is not wired into Claude");
  expect(unwired.fix).toBe("agent profile p add");
  // The default keeps its historical informational verdict.
  expect(checkClaude(base).status).toBe("ok");

  const stale = checkClaude(
    {
      ...base,
      settingsExists: true,
      wired: true,
      credential: "command",
      helperPath: join("/h/.claude", "copilot-proxy-token-p.sh"),
      baseUrl: "http://127.0.0.1:9999",
      baseUrlMatches: false,
      providerMode: "proxy",
    },
    P,
  );
  expect(stale.status).toBe("warn");
  expect(stale.fix).toContain("agent profile p add");

  // Foreign wiring in the profile's settings file is drift: the profile promises managed wiring, and
  // the writer refuses to overwrite an unmanaged file, so the fix names the removal first.
  const other = checkClaude(
    {
      ...base,
      settingsExists: true,
      helperPath: "/opt/x/helper.sh",
      providerMode: "other",
      otherReason: "custom",
    },
    P,
  );
  expect(other.status).toBe("warn");
  expect(other.detail).toContain("expects managed wiring");
  expect(other.fix).toContain(join("/h/.claude", "settings-p.json"));
  expect(other.fix).toContain("agent profile p add");
  expect(
    checkClaude({
      ...base,
      settingsExists: true,
      helperPath: "/opt/x/helper.sh",
      providerMode: "other",
      otherReason: "custom",
    }).status,
  ).toBe("ok");
});

test("named wiring in the OTHER mode than the slot records warns as an interrupted rewire", () => {
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
      credential: "command",
      envFilePresent: false,
      envKeyInDotenv: false,
      envKeyInEnviron: false,
      tokenAvailable: false,
      directAuth: { command: null, authenticated: false },
      directUsesToken: true,
      directNeedsNoGh: true,
      otherReason: null,
      expectedMode: "proxy",
    },
    P,
  );
  expect(codexDirect.status).toBe("warn");
  expect(codexDirect.detail).toContain("recorded mode is proxy");
  expect(codexDirect.fix).toBe("agent profile p add");
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
      credential: "command",
      envFilePresent: false,
      envKeyInDotenv: false,
      envKeyInEnviron: false,
      tokenAvailable: false,
      directAuth: { command: null, authenticated: false },
      directUsesToken: true,
      directNeedsNoGh: true,
      otherReason: null,
      expectedMode: "direct",
    },
    P,
  );
  expect(codexMatch.status).toBe("ok");

  const claudeProxy = checkClaude(
    {
      home: "/h/.claude",
      settingsPath: join("/h/.claude", "settings-p.json"),
      settingsExists: true,
      wired: true,
      credential: "command",
      helperPath: join("/h/.claude", "copilot-proxy-token-p.sh"),
      baseUrl: "http://127.0.0.1:4555",
      baseUrlMatches: true,
      providerMode: "proxy",
      otherReason: null,
      directAuth: { command: null, authenticated: false },
      directUsesToken: false,
      expectedMode: "direct",
    },
    P,
  );
  expect(claudeProxy.status).toBe("warn");
  expect(claudeProxy.detail).toContain("recorded mode is direct");
  expect(claudeProxy.fix).toBe("agent profile p add");
});

// --- --live argv + env scrub -----------------------------------------------------

/** Only the arms a launch plan reads for the selector and the scrub; every step is scripted so no
 *  proxy, wiring, or settings write happens. */
const launcherDeps: LaunchDeps = {
  agentMode: () => "direct",
  ensureProxy: () => Promise.resolve(true),
  wireProxyDefault: () => Promise.resolve(),
  refreshCodexCatalog: () => Promise.resolve(),
  profileSlot: () => ({
    kind: "complete",
    credential: { kind: "stored", provider: "gh-token", token: "tok" },
    mode: "direct",
  }),
  writeClaudeProfileSettings: (name) => Promise.resolve(join("/h", `settings-${name}.json`)),
  syncProfileWiring: () => Promise.resolve(),
  managedClaudeBaseUrl: () => null,
  codexHome: () => "/h/.codex",
  notify: () => {},
};

test("the --live launch is the launcher's start minus interactivity, never the Direct-detect argv", async () => {
  // What would drift silently: health borrowing `--bare` (auth through the apiKeyHelper alone, no
  // settings discovery) or `--model` from the detect descriptor, which no `cl`/`cx` session passes.
  for (const profile of [null, P] as Profile[]) {
    const claude = claudeLiveLaunch("/h", profile);
    const codex = codexLiveLaunch("/h", profile);
    for (const launch of [claude, codex]) {
      expect(launch.args).not.toContain("--bare");
      expect(launch.args).not.toContain("--model");
    }
    // The selector and the scrub are the launcher's own, read off its plan for the same profile.
    const claudePlan = await prepareLaunch(
      { kind: "claude", profile, relaxed: false, args: [] },
      launcherDeps,
    );
    const codexPlan = await prepareLaunch(
      { kind: "codex", profile, relaxed: false, args: [] },
      launcherDeps,
    );
    const selector = (args: string[], flag: string) => {
      const i = args.indexOf(flag);
      return i === -1 ? [] : args.slice(i, i + 2);
    };
    expect(selector(claude.args, "--settings")).toEqual(selector(claudePlan!.args, "--settings"));
    expect(selector(codex.args, "--profile")).toEqual(selector(codexPlan!.args, "--profile"));
    expect(claude.omitEnv).toEqual(claudePlan!.scrub);
    expect(codex.omitEnv).toEqual(codexPlan!.scrub);
    // External fact: Claude namespaces its keychain entry by CLAUDE_CONFIG_DIR, so exporting even
    // the default dir hides a keychain-held key from the probe that a real session reads.
    expect(claude.env).toEqual({});
  }
});

test("a --live exit 0 counts only when the stream carries the model's answer", async () => {
  // External fact neither CLI enforces for us: with the user's real hooks running, a
  // UserPromptSubmit hook that stops the prompt makes claude exit 0 after zero model turns, and
  // health must not read that as "responded". The event shapes are the CLIs' own JSON-lines output.
  const CLAUDE_ANSWER = '{"type":"system","subtype":"init"}\n' +
    '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}\n' +
    '{"type":"result","num_turns":1,"is_error":false}';
  const CLAUDE_HOOK_STOP =
    '{"type":"system","subtype":"init"}\n{"type":"result","num_turns":0,"is_error":false}';
  const CODEX_ANSWER =
    '{"type":"turn.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed"}';
  const CODEX_NO_ANSWER =
    '{"type":"item.completed","item":{"type":"error","message":"hooks bypassed"}}\n{"type":"turn.completed"}';
  const cases: [LiveLaunch, string, boolean][] = [
    [claudeLiveLaunch("/h", null), CLAUDE_ANSWER, true],
    [claudeLiveLaunch("/h", null), CLAUDE_HOOK_STOP, false],
    [codexLiveLaunch("/h", null), CODEX_ANSWER, true],
    [codexLiveLaunch("/h", null), CODEX_NO_ANSWER, false],
  ];
  for (const [launch, stdout, answered] of cases) {
    expect(launch.answered(stdout)).toBe(answered);
  }
  // The mechanism: runLiveCli turns an exit 0 without an answer into a failed probe that shows why.
  // The stream rides an env var: on Windows the argv crosses cmd.exe, where its quotes would break.
  const hookStopped = await runLiveCli({
    ...claudeLiveLaunch("/h", null),
    cli: Deno.execPath(),
    args: ["eval", "console.log(process.env.HOOK_STOP_STREAM)"],
    env: { HOOK_STOP_STREAM: CLAUDE_HOOK_STOP },
  });
  expect(hookStopped.kind).toBe("failed");
  expect(hookStopped.kind === "failed" ? hookStopped.detail : "").toContain(
    'exit 0 without a model answer\n{"type":"system","subtype":"init"}',
  );
  // A failed exit whose stream ends in claude's result event reports the event's `result` text,
  // not the counters the one-line event opens with.
  const apiError = await runLiveCli({
    ...claudeLiveLaunch("/h", null),
    cli: Deno.execPath(),
    args: ["eval", "console.log(process.env.API_ERROR_STREAM); Deno.exit(1)"],
    env: {
      API_ERROR_STREAM: '{"type":"system","subtype":"init"}\n' +
        '{"duration_api_ms":0,"total_cost_usd":0,"usage":{"input_tokens":0},"is_error":true,' +
        '"api_error_status":400,"result":"API Error: 400 model x does not support reasoning effort","type":"result"}',
    },
  });
  expect(apiError.kind === "failed" ? apiError.detail : "").toBe(
    '{"type":"system","subtype":"init"}\nAPI Error: 400 model x does not support reasoning effort',
  );
});

test("a named Claude live probe scrubs ANTHROPIC_BASE_URL; the default scrubs nothing", async () => {
  // Only a named profile drops the var: env would beat its settings file and answer with the DEFAULT wiring.
  expect(claudeLiveOmitEnv(null)).toEqual([]);
  expect(claudeLiveOmitEnv(P)).toEqual(["ANTHROPIC_BASE_URL"]);
  // The mechanism: runLiveCli really drops the requested vars from the child env.
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999";
  try {
    const probe = (omitEnv: readonly string[]) => {
      const launch: LiveLaunch = {
        cli: Deno.execPath(),
        args: ["eval", "process.exit(process.env.ANTHROPIC_BASE_URL ? 1 : 0)"],
        env: { CLAUDE_CONFIG_DIR: tempDir("copilot-health-profiles-") },
        omitEnv,
        answered: () => true,
      };
      return runLiveCli(launch);
    };
    expect((await probe(claudeLiveOmitEnv(P))).kind).toBe("ok");
    expect((await probe(claudeLiveOmitEnv(null))).kind).toBe("failed");
  } finally {
    restoreEnv();
  }
});

// --- gatherFacts seams (seeded profile fixtures) --------------------------------

test("the sweep gathers the default target first, then sorted named targets; the fast runtime scope stops at the default", async () => {
  const home = isolateProxyHome("copilot-health-sweep-");
  try {
    const store = new CopilotEnvState();
    const a = parseProfileName("a-direct");
    const b = parseProfileName("b-proxy");
    store.commitProfile(a, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-a" },
      mode: "direct",
    });
    store.commitProfile(b, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-b" },
      mode: "proxy",
    });
    mkdirSync(profileHome(b), { recursive: true });
    writeRunState({ port: 4555 }, b);
    mkdirSync(join(home, "profiles", "c-half"), { recursive: true });

    const probed: string[] = [];
    const deps = offlineDeps({
      reach: async (url) => {
        probed.push(url);
        return false;
      },
      codexHome: () => join(home, "no-codex"),
      claudeHome: () => join(home, "no-claude"),
    });
    const facts = await gatherFacts("proxy", {}, deps);
    expect(facts.runtimes?.map((t) => t.profile)).toEqual([null, a, b, parseProfileName("c-half")]);

    const [, aTarget, bTarget, cTarget] = facts.runtimes ?? [];
    expect(named(aTarget).proxyExpected).toBe(false);
    expect(named(aTarget).homeExists).toBe(false);
    expect(named(aTarget).probe.kind).toBe("skipped");
    expect(named(bTarget).proxyExpected).toBe(true);
    expect(named(bTarget).homeExists).toBe(true);
    expect(named(bTarget).port).toBe(4555);
    expect(named(bTarget).portPersisted).toBe(true);
    expect(named(bTarget).probe.kind).toBe("probed");
    // c-half: a homed daemon MAY be running, but with no persisted port there is nothing safe to probe.
    expect(named(cTarget).proxyExpected).toBe(true);
    expect(named(cTarget).slot.exists).toBe(false);
    expect(named(cTarget).portPersisted).toBe(false);
    expect(named(cTarget).probe.kind).toBe("skipped");
    // Never a-direct's or c-half's unpersisted candidates.
    expect(probed.some((u) => u.includes(":4555/"))).toBe(true);
    expect(probed).toHaveLength(2);

    // The launchers' fast probe never pays for the named sweep.
    const fast = await gatherFacts("runtime", {}, deps);
    expect(fast.runtimes?.map((t) => t.profile)).toEqual([null]);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("a named profile narrows gathering to its target and excludes account-wide facts", async () => {
  const home = isolateProxyHome("copilot-health-narrow-");
  try {
    const store = new CopilotEnvState();
    store.commitProfile(P, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-p" },
      mode: "proxy",
    });
    mkdirSync(profileHome(P), { recursive: true });
    writeRunState({ port: 4555 }, P);

    const codexHome = join(home, "codex-home");
    configureCodexConfig(codexHome, {
      mode: "proxy",
      profile: P,
      baseUrl: openaiBaseUrl("4555"),
      credential: { kind: "command" },
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
    expect(facts.profileAuth?.name).toBe(P);
    expect(facts.profileAuth?.slot?.provider).toBe("gh-token");
    expect(facts.profileAuth?.slot?.mode).toBe("proxy");
    expect(facts.codex?.providerMode).toBe("proxy");
    expect(facts.codex?.providerWired).toBe(true);
    expect(facts.claude?.providerMode).toBe("proxy");
    expect(facts.claude?.baseUrlMatches).toBe(true);
    expect(facts.claude?.settingsPath).toBe(join(claudeHome, "settings-p.json"));

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
  // No port reservation for the homeless proxy slot, no state, activity, or home creation anywhere.
  const home = isolateProxyHome("copilot-health-zerowrites-");
  try {
    const store = new CopilotEnvState();
    store.commitProfile(P, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-p" },
      mode: "proxy",
    });
    mkdirSync(profileHome(P), { recursive: true });
    writeRunState({ port: 4555 }, P);
    // A proxy slot with NO home: its resolvePort answer is an unreserved candidate that must not persist.
    const q = parseProfileName("q-homeless");
    store.commitProfile(q, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-q" },
      mode: "proxy",
    });
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
    store.commitProfile(P, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-p" },
      mode: "direct",
    });

    const codexHome = join(home, "codex-home");
    configureCodexConfig(codexHome, {
      mode: "direct",
      direct: null,
      profile: P,
      credential: { kind: "command" },
    });

    const facts = await gatherFacts(
      "codex",
      { profile: P },
      offlineDeps({
        codexHome: () => codexHome,
        claudeHome: () => join(home, "no-claude"),
      }),
    );
    // The slot's stored token means Direct needs no gh.
    expect(facts.codex?.providerMode).toBe("direct");
    expect(facts.codex?.providerWired).toBe(true);
    expect(facts.codex?.directNeedsNoGh).toBe(true);
    expect(facts.codex?.provider).toBe("gh-token");
    const results = evaluateAll("codex", facts);
    expect(results.map((r) => r.id)).toEqual(["setup.codex"]);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.profile).toBe(P);

    // A gh-cli slot makes the command shape probe gh (the control); the static shape carries the
    // value in the config, so the same slot is never asked and no gh probe runs.
    store.commitProfile(P, { credential: { kind: "gh-cli", ghUser: null }, mode: "direct" });
    let ghProbes = 0;
    const ghCounting = offlineDeps({
      codexHome: () => codexHome,
      claudeHome: () => join(home, "no-claude"),
      codexDirectAuth: () => {
        ghProbes += 1;
        return Promise.resolve({ command: null, authenticated: false });
      },
    });
    const commandShape = await gatherFacts("codex", { profile: P }, ghCounting);
    expect(commandShape.codex?.credential).toBe("command");
    expect(commandShape.codex?.directNeedsNoGh).toBe(false);
    expect(ghProbes).toBe(1);

    configureCodexConfig(codexHome, {
      mode: "direct",
      direct: null,
      profile: P,
      credential: { kind: "static", token: "tok-p" },
    });
    const staticShape = await gatherFacts("codex", { profile: P }, ghCounting);
    expect(staticShape.codex?.providerMode).toBe("direct");
    expect(staticShape.codex?.credential).toBe("static");
    expect(staticShape.codex?.directNeedsNoGh).toBe(true);
    expect(ghProbes).toBe(1);
    // The store is not consulted for a static wiring: no provider fact, and a gh-cli slot has no
    // stored value to compare the baked one against.
    expect(staticShape.codex?.provider).toBeUndefined();
    expect(staticShape.codex?.bakedCredential).toBe("unchecked");
    expect(evaluateAll("codex", staticShape)[0]?.status).toBe("ok");

    // Freshness is the ONE store question a static wiring asks: equal to the stored token is
    // fresh; a rotated store (agent auth after the wire) is stale and names the profile's rewire.
    store.commitProfile(P, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-p" },
      mode: "direct",
    });
    const fresh = await gatherFacts("codex", { profile: P }, ghCounting);
    expect(fresh.codex?.bakedCredential).toBe("fresh");
    expect(evaluateAll("codex", fresh)[0]?.status).toBe("ok");
    store.commitProfile(P, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-rotated" },
      mode: "direct",
    });
    const stale = await gatherFacts("codex", { profile: P }, ghCounting);
    expect(stale.codex?.bakedCredential).toBe("stale");
    const staleResult = evaluateAll("codex", stale)[0];
    expect(staleResult?.status).toBe("warn");
    expect(staleResult?.detail).toContain("out of step with the store");
    expect(staleResult?.detail).not.toContain("tok-");
    expect(staleResult?.fix).toBe(`agent profile ${P} add`);
    expect(ghProbes).toBe(1);

    // A PROXY static wiring skips gh the same way, but the direct-only JSON field stays false:
    // "needs no gh" is a Direct verdict, never a proxy one.
    configureCodexConfig(codexHome, {
      mode: "proxy",
      profile: P,
      baseUrl: openaiBaseUrl("4555"),
      credential: { kind: "static", token: "proxy-key" },
    });
    const proxyStatic = await gatherFacts("codex", { profile: P }, ghCounting);
    expect(proxyStatic.codex?.providerMode).toBe("proxy");
    expect(proxyStatic.codex?.credential).toBe("static");
    expect(proxyStatic.codex?.directNeedsNoGh).toBe(false);
    expect(ghProbes).toBe(1);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

// --- --live narrowing --------------------------------------------------------------

test("--live probes run for the narrowed profile alone, else for the default alone", async () => {
  const home = isolateProxyHome("copilot-health-live-");
  try {
    const store = new CopilotEnvState();
    store.commitProfile(P, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-p" },
      mode: "direct",
    });
    const b = parseProfileName("b-proxy");
    store.commitProfile(b, {
      credential: { kind: "stored", provider: "gh-token", token: "tok-b" },
      mode: "proxy",
    });
    mkdirSync(profileHome(b), { recursive: true });
    const seen: { agent: string; home: string; profile: Profile }[] = [];
    const deps = offlineDeps({
      codexHome: () => join(home, "no-codex"),
      claudeHome: () => join(home, "no-claude"),
      shellTargets: () => [],
      commandLook: () => ({ path: null }),
      readAutoupdate: () => ({ enabled: false, lastCheckMs: 0, lastResult: "", cooldownDays: 7 }),
      codexLive: async (h, profile) => {
        seen.push({ agent: "codex", home: h, profile });
        return { kind: "skipped" };
      },
      claudeLive: async (h, profile) => {
        seen.push({ agent: "claude", home: h, profile });
        return { kind: "skipped" };
      },
    });

    const narrowed = await gatherFacts("full", { live: true, profile: P }, deps);
    expect(seen.map((call) => call.profile)).toEqual([P, P]);
    expect(narrowed.codexLive?.kind).toBe("skipped");
    expect(narrowed.claudeLive?.kind).toBe("skipped");

    // The default sweep runs exactly the default's two probes, never one per named profile.
    seen.length = 0;
    await gatherFacts("full", { live: true }, deps);
    expect(seen.map((call) => call.profile)).toEqual([null, null]);
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("an UNPROVEN gh probe travels from the codexDirectAuth seam into both auth fact rows", async () => {
  // The gatherFacts spreads (probe.ts, the auth + profileAuth jobs) carry CodexDirectAuthFacts.unproven;
  // dropping either silently restores the confident "gh is unauthenticated" render.
  const unproven = { command: "/bin/gh", authenticated: false, unproven: true as const };
  const facts = await gatherFacts("auth", {}, {
    authProvider: () => "gh-cli",
    storedTokenPresent: () => false,
    authProfiles: () => ({}),
    pinnedIntegrationId: () => null,
    codexDirectAuth: () => Promise.resolve(unproven),
    ghActiveLogin: () => Promise.resolve(null),
  });
  expect(facts.auth).toEqual({
    storedToken: false,
    ghAuthenticated: false,
    ghAuthUnproven: true,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  const authCheck = evaluateAll("auth", facts).find((r) => r.id === "setup.auth");
  expect(authCheck?.status).toBe("warn");
  expect(authCheck?.detail).toBe([
    "provider 'gh-cli' is selected but its credential could not be checked",
    "could not check gh authentication " +
    "(`gh auth token` did not run to completion; AUTO - follows gh's active account)",
  ].join("\n"));

  const narrowed = await gatherFacts("auth", { profile: P }, {
    profileSlot: () => ({
      exists: true,
      provider: "gh-cli",
      mode: "direct",
      storedToken: false,
      ghUser: null,
    }),
    codexDirectAuth: () => Promise.resolve(unproven),
    ghActiveLogin: () => Promise.resolve(null),
  });
  expect(narrowed.profileAuth).toEqual({
    name: P,
    slot: { provider: "gh-cli", mode: "direct" },
    storedToken: false,
    ghAuthenticated: false,
    ghAuthUnproven: true,
  });
  const profileCheck = evaluateAll("auth", narrowed).find((r) => r.id === "setup.auth");
  expect(profileCheck?.status).toBe("warn");
  expect(profileCheck?.detail).toBe([
    "provider 'gh-cli' is recorded for profile 'p' but its credential could not be checked",
    "could not check gh authentication " +
    "(`gh auth token` did not run to completion; AUTO - follows gh's active account)",
  ].join("\n"));
});

test("a shell-target discovery failure marks the census UNPROVEN, never 'not wired'", async () => {
  const home = isolateProxyHome("copilot-health-shelltargets-");
  try {
    const facts = await gatherFacts(
      "setup",
      {},
      offlineDeps({
        shellTargets: () => {
          throw new Error("powershell exploded");
        },
        commandLook: () => ({ path: null }),
        codexHome: () => join(home, "no-codex"),
        claudeHome: () => join(home, "no-claude"),
        readAutoupdate: () => ({ enabled: false, lastCheckMs: 0, lastResult: "", cooldownDays: 7 }),
      }),
    );
    expect(facts.shell).toEqual({
      files: [],
      integrationWired: false,
      launchersWired: false,
      targetsUnproven: true,
    });
    const shellCheck = evaluateAll("setup", facts).find((r) => r.id === "setup.shell");
    expect(shellCheck?.status).toBe("warn");
    expect(shellCheck?.detail).toBe(
      "could not check the shell rc/profile files (target discovery failed to run)",
    );
    expect(shellCheck?.fix).toBe("agent shell");
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
    // checkAuth and checkProfileAuth share the setup.auth id by design.
    auth: {
      storedToken: true,
      ghAuthenticated: false,
      provider: "gh-token",
      profiles: {},
      pinnedIntegrationId: null,
    },
    profileAuth: {
      name: P,
      slot: { provider: "gh-token", mode: "direct" },
      storedToken: true,
      ghAuthenticated: false,
    },
  });
  const consistency = results.filter((r) => r.id === "profile.consistency");
  expect(consistency.map((r) => r.profile)).toEqual([P, "q-two" as ProfileName]);
  const auth = results.filter((r) => r.id === "setup.auth");
  expect(auth.map((r) => `${r.profile}:${r.status}`)).toEqual(["null:ok", "p:ok"]);
});

// A FAILED identity scan (classifyDaemonPid "unknown") used to flatten into pidTracked:false, rendering
// a confident "orphaned" warn and "stale or foreign" fail for a daemon health never looked at. The
// probe now carries pidScanUnproven and the renderers say "could not be verified".

describe("unproven tracked-pid scans", () => {
  test("interrogation carries a FAILED scan as pidScanUnproven, never a confident untracked", async () => {
    const home = isolateProxyHome("copilot-health-unproven-");
    try {
      new CopilotEnvState().commitProfile(P, {
        credential: { kind: "stored", provider: "gh-token", token: "tok-p" },
        mode: "proxy",
      });
      mkdirSync(profileHome(P), { recursive: true });
      writeRunState({ pid: 4321, port: 4555 }, P);
      const gather = (cls: "yes" | "no" | "unknown") =>
        gatherFacts(
          "runtime",
          { profile: P },
          offlineDeps({
            reach: async () => true,
            classifyTrackedPid: async () => cls,
          }),
        );

      // pidTracked stays the fail-closed false, but the probe SAYS the reading is unproven. Restoring
      // the boolean flatten (unknown -> plain false) turns exactly these assertions red.
      const unknown = probeOf((await gather("unknown")).runtimes?.[0]);
      expect(unknown.pidTracked).toBe(false);
      expect(unknown.pidScanUnproven).toBe(true);
      expect(unknown.portState.kind).toBe("orphan");

      // Controls: completed scans keep their confident verdicts, with NO unproven mark.
      const yes = probeOf((await gather("yes")).runtimes?.[0]);
      expect(yes.pidTracked).toBe(true);
      expect(yes.pidScanUnproven).toBeUndefined();
      expect(yes.portState).toEqual({ kind: "tracked" });
      const no = probeOf((await gather("no")).runtimes?.[0]);
      expect(no.pidTracked).toBe(false);
      expect(no.pidScanUnproven).toBeUndefined();
      expect(no.portState.kind).toBe("orphan");
    } finally {
      restoreEnv();
      removeDir(home);
    }
  });

  test("runtime.pid under an unproven scan: could-not-verify replaces the confident fail, the excused arms stay ok", () => {
    const rows: {
      name: string;
      overrides: NamedOverrides;
      status: CheckStatus;
      detail: string[];
      exactDetail?: string;
      scanUnproven: true | undefined;
    }[] = [
      {
        name: "unproven scan, nothing excuses",
        overrides: { pidTracked: false, pidScanUnproven: true },
        status: "warn",
        detail: [],
        exactDetail: "tracked pid 4321 could not be verified (the process scan failed)",
        scanUnproven: true,
      },
      {
        // Control: the same facts WITHOUT the unproven mark keep the confident fail.
        name: "completed scan",
        overrides: { pidTracked: false },
        status: "fail",
        detail: [],
        exactDetail: "tracked pid 4321 is stale or foreign",
        scanUnproven: undefined,
      },
      {
        // A tracked pid would also read ok here, so the unknown decides nothing; the detail and value
        // still carry the failed look.
        name: "unproven scan, both agents direct",
        overrides: { pidTracked: false, pidScanUnproven: true, proxyExpected: false },
        status: "ok",
        detail: ["could not be verified"],
        scanUnproven: true,
      },
      {
        name: "unproven scan, down with auto-start on",
        overrides: {
          pidTracked: false,
          pidScanUnproven: true,
          reachable: false,
          identityConfirmed: null,
          watchdog: { ...namedTarget("p").watchdog, autoStart: true },
        },
        status: "ok",
        detail: ["could not be verified", "starts on demand"],
        scanUnproven: true,
      },
    ];
    for (const row of rows) {
      const pid = runPid(namedTarget("p", row.overrides));
      expect(pid.status, row.name).toBe(row.status);
      if (row.exactDetail !== undefined) expect(pid.detail, row.name).toBe(row.exactDetail);
      for (const needle of row.detail) expect(pid.detail, row.name).toContain(needle);
      if (row.status !== "fail") expect(pid.detail, row.name).not.toContain("stale or foreign");
      expect(pid.value?.scanUnproven, row.name).toBe(row.scanUnproven);
    }
  });

  test("runtime.orphan on an unproven scan says the daemon may be tracked, not that it is an orphan", () => {
    const unproven = runOrphan(namedTarget("p", { pidTracked: false, pidScanUnproven: true }));
    expect(unproven.status).toBe("warn");
    expect(unproven.detail).toContain(
      "tracked pid 4321 could not be verified (the process scan failed)",
    );
    expect(unproven.detail).toContain("may be the tracked daemon");
    expect(unproven.detail).not.toContain("is not the tracked daemon");
    expect(unproven.value?.orphan).toBe(null);

    // Control: a completed scan keeps the confident orphan warning.
    const confident = runOrphan(namedTarget("p", { pidTracked: false }));
    expect(confident.status).toBe("warn");
    expect(confident.detail).toContain("is not the tracked daemon");
    expect(confident.value?.orphan).toBe(true);
  });
});
