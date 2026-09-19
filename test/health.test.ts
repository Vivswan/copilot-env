import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directHelperCommand } from "../src/claude/config.ts";
import { inspectCodexWiring } from "../src/codex/inspect.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import {
  markInference,
  resetInferenceActivityForTests,
} from "../src/copilot_api/inference_activity.ts";
import { proxyTokenCommand } from "../src/utils/root.ts";
import {
  buildHealthJson,
  exitCodeFor,
  filterByScope,
  worstStatus,
} from "../src/health/aggregate.ts";
import {
  checkAuth,
  checkAutoupdate,
  checkCli,
  checkCliVersion,
  checkDeno,
  checkLaunchers,
  checkLook,
  checkNodeModules,
  checkProxyPackage,
  checkProxyResolved,
  checkProxySidecar,
  checkRuntimeWatchdog,
  checkShellIntegration,
  evaluateAll,
} from "../src/health/checks.ts";
import { checkClaude, checkCodex } from "../src/health/checks_agents.ts";
import { codexLiveLaunch } from "../src/health/live_launch.ts";
import {
  type AuthFacts,
  type BootstrapFacts,
  classifyPortState,
  type CodexFacts,
  type CodexHostFacts,
  type DaemonProbed,
  type DefaultRuntimeTarget,
  type HealthFacts,
  type PortState,
  type ProxyFacts,
  type RuntimeTarget,
  type WatchdogFacts,
} from "../src/health/facts.ts";
import { gatherFacts } from "../src/health/probe.ts";
import { runLiveCli } from "../src/health/probe_deps.ts";
import {
  type CheckId,
  type CheckResult,
  type CheckStatus,
  type HealthScope,
  meta,
} from "../src/health/types.ts";
import { probeOf, runIdentity, runOrphan, runPid, runPort } from "./helpers/health.ts";
import { expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers/env.ts";
import {
  type ClaudeSettingsOptions,
  codexConfigToml,
  type CodexConfigTomlOptions,
  writeClaudeSettings,
  writeCodexConfigToml,
  writeRunState,
} from "./helpers/fixtures.ts";

// --- fixtures ---------------------------------------------------------------

function result(id: CheckId, status: CheckStatus, scopes: HealthScope[]): CheckResult {
  const base = { id, label: String(id), group: "runtime" as const, profile: null, scopes };
  return status === "ok"
    ? { ...base, status, detail: "" }
    : { ...base, status, detail: "", fix: "fix-hint" };
}

// PortState is always derived through the probe's own classifier, so a fixture can never carry a
// torn ownership verdict.
interface TargetOverrides {
  proxyExpected?: boolean;
  port?: number;
  portPersisted?: boolean;
  reachable?: boolean;
  trackedPid?: number | null;
  pidTracked?: boolean;
  pidAlive?: boolean;
  identityConfirmed?: boolean | null;
  watchdog?: WatchdogFacts;
}

function probedFrom(proxyExpected: boolean, o: TargetOverrides): DaemonProbed {
  const raw = {
    reachable: o.reachable ?? true,
    trackedPid: o.trackedPid === undefined ? 1234 : o.trackedPid,
    pidTracked: o.pidTracked ?? true,
    pidAlive: o.pidAlive ?? true,
    identityConfirmed: o.identityConfirmed === undefined ? true : o.identityConfirmed,
  };
  return { kind: "probed", ...raw, portState: classifyPortState({ proxyExpected, ...raw }) };
}

function defaultTarget(overrides: TargetOverrides = {}): DefaultRuntimeTarget {
  const proxyExpected = overrides.proxyExpected ?? true;
  return {
    profile: null,
    proxyExpected,
    port: overrides.port ?? 4141,
    portPersisted: overrides.portPersisted ?? true,
    probe: probedFrom(proxyExpected, overrides),
    paths: {
      home: "/h",
      configFile: "/h/config.json",
      runDir: "/h/.run/x",
      stateFile: "/h/.run/x/.state.json",
      logFile: "/h/.run/x/.log",
      sqliteDb: "/h/.run/x/db.sqlite",
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

function profileTarget(name: string, overrides: TargetOverrides = {}): RuntimeTarget {
  const base = defaultTarget(overrides);
  return {
    ...base,
    profile: parseProfileName(name),
    slot: {
      exists: true,
      provider: null,
      mode: "proxy",
      storedToken: false,
      ghUser: null,
    },
    homeExists: true,
  };
}

const BOOTSTRAP_OK: BootstrapFacts = {
  cliVersion: "3.1.0",
  denoVersion: "2.9.5",
  nodeModules: { present: true, fresh: true },
};

const DEV_SIDECAR: ProxyFacts["sidecar"] = {
  kind: "dev",
  referenceVersion: "2.9.5",
  denoBin: "/deno",
  version: "2.9.5",
  standalone: false,
};

const CODEX_UNCONFIGURED: CodexFacts = {
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
};

const CODEX_HOST_UNSUPPORTED: CodexHostFacts = {
  supported: false,
  hostHome: "/h/.codex/hosts/box",
  exists: false,
  wired: false,
  probeError: null,
  active: false,
  enabled: false,
};

// --- aggregate --------------------------------------------------------------

test("aggregate: filterByScope, worstStatus, and exitCodeFor over one check list", () => {
  const all = [
    result("runtime.port", "ok", ["full", "proxy", "runtime"]),
    result("setup.shell", "warn", ["full", "setup"]),
    result("setup.codex", "ok", ["full", "setup", "codex"]),
    result("bootstrap.deno", "ok", ["full", "proxy"]),
  ];
  const ids = (scope: HealthScope) => filterByScope(all, scope).map((r) => r.id);
  expect(ids("runtime")).toEqual(["runtime.port"]);
  expect(ids("setup")).toEqual(["setup.shell", "setup.codex"]);
  expect(ids("codex")).toEqual(["setup.codex"]);
  expect(ids("proxy")).toEqual(["runtime.port", "bootstrap.deno"]);
  expect(ids("full")).toEqual(["runtime.port", "setup.shell", "setup.codex", "bootstrap.deno"]);

  // Severity ranks fail > warn > ok wherever the fail sits; only a fail moves the exit code.
  const failing = [...all.slice(0, 2), result("runtime.pid", "fail", ["full"]), ...all.slice(2)];
  expect(worstStatus([])).toBe("ok");
  expect(worstStatus(all)).toBe("warn");
  expect(worstStatus(failing)).toBe("fail");
  expect(exitCodeFor([])).toBe(0);
  expect(exitCodeFor(all)).toBe(0);
  expect(exitCodeFor(failing)).toBe(1);
});

test("buildHealthJson exposes scope/ok/status/exitCode/checks with ok === no-fail", () => {
  const okJson = buildHealthJson("full", [result("runtime.port", "warn", ["full"])]);
  expect(okJson).toMatchObject({ scope: "full", ok: true, status: "warn", exitCode: 0 });
  expect(okJson.checks).toHaveLength(1);
  expect(okJson.checks[0]?.fix).toBe("fix-hint");
  expect(
    buildHealthJson("full", [result("runtime.port", "ok", ["full"])]).checks[0]?.fix,
  ).toBeUndefined();
  // The top-level profile is the run's narrowing; each check names its own target, environment checks null.
  expect(okJson.profile).toBeNull();
  expect(okJson.checks[0]?.profile).toBeNull();

  const failJson = buildHealthJson("runtime", [result("runtime.port", "fail", ["runtime"])]);
  expect(failJson).toMatchObject({ ok: false, status: "fail", exitCode: 1 });
});

// --- proxy version checks -------------------------------------------------

test("proxy package: the version bounds decide status and fix, the cooldown the detail", () => {
  const check = (facts: Partial<ProxyFacts>) =>
    checkProxyPackage({
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds: 604800,
      floatSkips: false,
      resolved: null,
      sidecar: DEV_SIDECAR,
      ...facts,
    });
  const rows: {
    name: string;
    facts: Partial<ProxyFacts>;
    status: CheckStatus;
    fix?: string;
    detail?: string;
  }[] = [
    {
      name: "missing",
      facts: { version: null, bounds: { ok: false, reason: "missing", version: null } },
      status: "fail",
    },
    {
      name: "below the floor",
      facts: {
        version: "1.0.0",
        bounds: { ok: false, reason: "belowFloor", version: "1.0.0", floor: "1.10.0" },
      },
      status: "fail",
    },
    {
      name: "above the ceiling",
      facts: {
        version: "2.0.0",
        bounds: { ok: false, reason: "aboveCeiling", version: "2.0.0", ceiling: "1.99.0" },
      },
      status: "warn",
      fix: "agent update",
    },
    { name: "in bounds, 7d cooldown", facts: {}, status: "ok", detail: "cooldown 7d" },
    {
      name: "in bounds, no cooldown",
      facts: { cooldownSeconds: 0 },
      status: "ok",
      detail: "no cooldown",
    },
    {
      name: "in bounds, 3d cooldown",
      facts: { cooldownSeconds: 259200 },
      status: "ok",
      detail: "cooldown 3d",
    },
    {
      name: "in bounds, 90s cooldown",
      facts: { cooldownSeconds: 90 },
      status: "ok",
      detail: "cooldown 90s",
    },
    {
      name: "in bounds, unknown cooldown",
      facts: { cooldownSeconds: null },
      status: "ok",
      detail: "cooldown: unknown",
    },
  ];
  for (const row of rows) {
    const r = check(row.facts);
    expect(r.status, row.name).toBe(row.status);
    if (row.fix !== undefined) expect(r.fix, row.name).toBe(row.fix);
    if (row.detail !== undefined) expect(r.detail, row.name).toContain(row.detail);
  }
});

test("proxy package bounds are not enforced when both agents are direct", () => {
  // The float skips when both default agents are wired Direct (Claude's base URL exactly the Direct
  // host) and no profile home exists, so an out-of-bounds version reads ok with a note: the suggested
  // fixes could not move the version anyway.
  const below = checkProxyPackage({
    version: "1.0.0",
    bounds: { ok: false, reason: "belowFloor", version: "1.0.0", floor: "1.10.0" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: {
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/deno",
      version: "2.9.5",
      standalone: false,
    },
  });
  expect(below.status).toBe("ok");
  // The detail must surface the exemption; the exact phrasing is human copy, so
  // pin only the stable "not enforced" token.
  expect(below.detail).toContain("not enforced");
  expect(below.fix).toBeUndefined();
  // Machine-readable for --json consumers, mirroring the runtime checks' bothDirect stamp.
  expect((below.value as Record<string, unknown>).floatSkips).toBe(true);

  const above = checkProxyPackage({
    version: "2.0.0",
    bounds: { ok: false, reason: "aboveCeiling", version: "2.0.0", ceiling: "1.99.0" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: {
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/deno",
      version: "2.9.5",
      standalone: false,
    },
  });
  expect(above.status).toBe("ok");
  expect(above.fix).toBeUndefined();

  // A missing package is a broken CHECKOUT in any mode: a reinstall fixes it, float or no float.
  const missing = checkProxyPackage({
    version: null,
    bounds: { ok: false, reason: "missing", version: null },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: {
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/deno",
      version: "2.9.5",
      standalone: false,
    },
  });
  expect(missing.status).toBe("fail");
  expect(missing.fix).toBe("deno install --frozen");

  const inBounds = checkProxyPackage({
    version: "1.10.5",
    bounds: { ok: true, version: "1.10.5" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: {
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/deno",
      version: "2.9.5",
      standalone: false,
    },
  });
  expect(inBounds.status).toBe("ok");
  expect(inBounds.detail).not.toContain("not enforced");
  expect((inBounds.value as Record<string, unknown>).floatSkips).toBeUndefined();

  // An unreadable copilot-env.config fails in any mode: the early return fires before the exemption.
  const badConfig = checkProxyPackage({
    version: "1.10.5",
    bounds: null,
    configError: "bad config",
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: {
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/deno",
      version: "2.9.5",
      standalone: false,
    },
  });
  expect(badConfig.status).toBe("fail");
  expect(badConfig.detail).toContain("copilot-env.config");
});

test("proxy package: a compiled install treats missing as pre-start, not broken", () => {
  // A compiled binary ships no deno.json baseline; the float resolves the proxy at `agent start`, so
  // "missing" is the normal pre-start state of a binary install.
  const standalone = {
    kind: "provisioned",
    referenceVersion: "2.9.5",
    denoBin: "/deno",
    version: "2.9.5",
    standalone: true,
  } as const;
  const unused = checkProxyPackage({
    version: null,
    bounds: { ok: false, reason: "missing", version: null },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: standalone,
  });
  expect(unused.status).toBe("ok");
  expect(unused.detail).toContain("not required");
  expect(unused.fix).toBeUndefined();
  // Machine-readable for --json consumers, like the floatSkips stamp.
  expect((unused.value as Record<string, unknown>).standalone).toBe(true);

  const preStart = checkProxyPackage({
    version: null,
    bounds: { ok: false, reason: "missing", version: null },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: false,
    resolved: null,
    sidecar: standalone,
  });
  expect(preStart.status).toBe("ok");
  expect(preStart.detail).toContain("agent start");
  expect(preStart.fix).toBeUndefined();
});

test("proxy sidecar: absent is fatal for a compiled build, a warning for a checkout", () => {
  const facts = (sidecar: ProxyFacts["sidecar"]): ProxyFacts => ({
    version: "1.10.5",
    bounds: { ok: true, version: "1.10.5" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: false,
    resolved: null,
    sidecar,
  });

  // A compiled binary is not a deno CLI: with no deno anywhere it cannot spawn
  // the proxy at all, so this is a failure rather than a note.
  const compiled = checkProxySidecar(
    facts({
      kind: "absent",
      referenceVersion: "2.9.5",
      denoBin: null,
      version: null,
      standalone: true,
    }),
  );
  expect(compiled.status).toBe("fail");
  expect(compiled.fix).toBe("install deno (https://deno.com), or `agent start` to provision one");

  // From a checkout the runtime itself is the answer, so a missing sidecar is not fatal.
  expect(
    checkProxySidecar(
      facts({
        kind: "absent",
        referenceVersion: "2.9.5",
        denoBin: null,
        version: null,
        standalone: false,
      }),
    )
      .status,
  ).toBe("warn");

  const dev = checkProxySidecar(
    facts({
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/usr/bin/deno",
      version: "2.9.5",
      standalone: false,
    }),
  );
  expect(dev.status).toBe("ok");
  expect(dev.detail).toContain("/usr/bin/deno");

  const provisioned = checkProxySidecar(
    facts({
      kind: "provisioned",
      referenceVersion: "2.9.5",
      denoBin: "/home/x/deno",
      version: "2.9.5",
      standalone: true,
    }),
  );
  expect(provisioned.status).toBe("ok");
  expect(provisioned.detail).toContain("2.9.5");

  // A PATH deno is the normal answer under the user's-toolchain-wins policy: older is a WARN, never
  // a block, and an unreadable version is not a verdict.
  const onPath = checkProxySidecar(
    facts({
      kind: "path",
      referenceVersion: "2.9.5",
      denoBin: "/opt/homebrew/bin/deno",
      version: "2.10.0",
      standalone: true,
    }),
  );
  expect(onPath.status).toBe("ok");
  expect(onPath.detail).toContain("deno 2.10.0 on PATH");
  const older = checkProxySidecar(
    facts({
      kind: "path",
      referenceVersion: "2.9.5",
      denoBin: "/opt/homebrew/bin/deno",
      version: "2.8.1",
      standalone: true,
    }),
  );
  expect(older.status).toBe("warn");
  expect(older.detail).toContain("deno 2.8.1 on PATH is older than the tested 2.9.5");
  expect(older.fix).toContain("upgrade deno");
  // A canary build (`x.y.z+<hash>`) is semver: its core compares, so an old canary warns too.
  const canary = checkProxySidecar(
    facts({
      kind: "path",
      referenceVersion: "2.9.5",
      denoBin: "/opt/homebrew/bin/deno",
      version: "2.8.1+a1b2c3d",
      standalone: true,
    }),
  );
  expect(canary.status).toBe("warn");
  expect(canary.detail).toContain("deno 2.8.1+a1b2c3d on PATH is older than the tested 2.9.5");
  const unknownVersion = checkProxySidecar(
    facts({
      kind: "path",
      referenceVersion: "2.9.5",
      denoBin: "/opt/homebrew/bin/deno",
      version: null,
      standalone: true,
    }),
  );
  expect(unknownVersion.status).toBe("ok");
  expect(unknownVersion.detail).toContain("deno (version unknown) on PATH");

  // Direct-only: nothing spawns the proxy, so an absent sidecar is idle capacity even on a compiled build.
  const unused = checkProxySidecar({
    ...facts({
      kind: "absent",
      referenceVersion: "2.9.5",
      denoBin: null,
      version: null,
      standalone: true,
    }),
    floatSkips: true,
  });
  expect(unused.status).toBe("ok");
  expect(unused.detail).toContain("not required");
  expect(unused.fix).toBeUndefined();
});

test("proxy resolved: no record is ok, a record with a missing cache fails", () => {
  const facts = (resolved: ProxyFacts["resolved"], floatSkips = false): ProxyFacts => ({
    version: resolved?.version ?? "1.10.5",
    bounds: { ok: true, version: resolved?.version ?? "1.10.5" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips,
    resolved,
    sidecar: {
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/deno",
      version: "2.9.5",
      standalone: false,
    },
  });

  // Never floated: the deno.json baseline runs, which is a working fallback.
  const none = checkProxyResolved(facts(null));
  expect(none.status).toBe("ok");
  expect(none.detail).toContain("not floated");
  expect(none.fix).toBeUndefined();
  // Direct-only says so explicitly rather than implying a pending float.
  expect(checkProxyResolved(facts(null, true)).detail).toContain("both direct");

  // Recorded but the cache is gone: the launch asks for that exact version offline, so no fallback exists.
  const stale = checkProxyResolved(
    facts({ version: "1.10.5", resolvedAtMs: 1, denoDir: "/gone", cached: false }),
  );
  expect(stale.status).toBe("fail");
  expect(stale.fix).toBe("agent start");

  const ok = checkProxyResolved(
    facts({ version: "1.10.5", resolvedAtMs: 1, denoDir: "/cache", cached: true }),
  );
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("1.10.5");
  expect(ok.detail).toContain("/cache");
});

// --- runtime checks (preserve original semantics) ---------------------------

test("gatherFacts probes the proxy at 127.0.0.1, never localhost (Windows IPv6 safety)", async () => {
  // The daemon binds IPv4; on Windows `localhost` resolves to ::1 first with no fallback, so a
  // localhost probe falsely reports the proxy down.
  const restoreEnv = envSnapshot();
  const home = isolateProxyHome("copilot-health-loopback-");
  try {
    writeRunState({ port: 4141 });
    let probed = "";
    await gatherFacts("runtime", {}, {
      reach: async (url: string) => {
        probed = url;
        return true;
      },
    });
    expect(probed).toBe("http://127.0.0.1:4141/");
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("runtime port + pid verdicts over the probe states of a default target", () => {
  const down = { reachable: false, trackedPid: null, pidTracked: false };
  const rows: {
    name: string;
    target: DefaultRuntimeTarget;
    port?: { status: CheckStatus; fix?: string; detail?: string };
    pid?: { status: CheckStatus; fix?: string };
    exitCode?: number;
  }[] = [
    {
      name: "tracked and reachable",
      target: defaultTarget(),
      port: { status: "ok" },
      pid: { status: "ok" },
    },
    { name: "unreachable", target: defaultTarget({ reachable: false }), port: { status: "fail" } },
    {
      name: "down, nothing tracked",
      target: defaultTarget(down),
      port: { status: "fail" },
      pid: { status: "fail" },
      exitCode: 1,
    },
    {
      name: "down while both Codex and Claude are direct",
      target: defaultTarget({ ...down, proxyExpected: false }),
      port: { status: "ok", detail: "both direct" },
      pid: { status: "ok" },
      exitCode: 0,
    },
    {
      // The fixture's watchdog has autoStart off, so nothing would relaunch the daemon.
      name: "down with auto-start off",
      target: defaultTarget({ ...down, identityConfirmed: null }),
      port: { status: "fail", fix: "agent start" },
      pid: { status: "fail", fix: "agent start" },
      exitCode: 1,
    },
    {
      name: "reachable but the tracked pid is stale or foreign",
      target: defaultTarget({ pidTracked: false }),
      port: { status: "ok" },
      pid: { status: "fail" },
    },
    {
      name: "reachable with no tracked pid",
      target: defaultTarget({ trackedPid: null, pidTracked: false, pidAlive: false }),
      pid: { status: "fail" },
    },
  ];
  for (const row of rows) {
    if (row.port) {
      const port = runPort(row.target);
      expect(port.status, row.name).toBe(row.port.status);
      if (row.port.fix !== undefined) expect(port.fix, row.name).toBe(row.port.fix);
      if (row.port.detail !== undefined) expect(port.detail, row.name).toContain(row.port.detail);
    }
    if (row.pid) {
      const pid = runPid(row.target);
      expect(pid.status, row.name).toBe(row.pid.status);
      if (row.pid.fix !== undefined) expect(pid.fix, row.name).toBe(row.pid.fix);
    }
    if (row.exitCode !== undefined) {
      expect(exitCodeFor(evaluateAll("runtime", { runtimes: [row.target] })), row.name).toBe(
        row.exitCode,
      );
    }
  }
});

test("runtime: a foreign listener on the port is not a problem when both agents are direct", () => {
  // The driving bug: both agents Direct plus an unrelated service on the default port made health
  // warn about a port nothing routes to.
  const listener = defaultTarget({
    proxyExpected: false,
    trackedPid: null,
    pidTracked: false,
    identityConfirmed: null, // the probe gate: identity is never probed when nothing routes
  });
  const port = runPort(listener);
  expect(port.status).toBe("ok");
  expect(port.detail).toContain(`port ${listener.port} has a listener, but no agent routes`);
  expect(port.fix).toBeUndefined();
  expect((port.value as Record<string, unknown>).bothDirect).toBe(true);
  const identity = runIdentity(listener);
  expect(identity.status).toBe("ok");
  expect(identity.detail).toContain("not probed");
  expect(identity.detail).toContain("no agent routes");
  const orphan = runOrphan(listener);
  expect(orphan.status).toBe("ok");
  expect(orphan.detail).toContain("both agents are direct");
  const pid = runPid(listener);
  expect(pid.status).toBe("ok");
  expect((pid.value as Record<string, unknown>).bothDirect).toBe(true);
  // Identity is never probed for a both-direct target, so even a tracked-and-alive pid may not claim the port.
  const trackedListener = defaultTarget({ proxyExpected: false, identityConfirmed: null });
  expect(runOrphan(trackedListener).detail).toContain("both agents are direct");
  const results = evaluateAll("full", { runtimes: [listener] });
  expect(worstStatus(results)).toBe("ok");
  expect(exitCodeFor(results)).toBe(0);
});

test("runtime: a down daemon reads ok (starts on demand) when auto-start is on", () => {
  // With auto-start on the resolver launches the daemon on demand, so "down between sessions" is normal.
  const down = defaultTarget({
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    pidAlive: false,
    identityConfirmed: null,
    watchdog: { ...defaultTarget().watchdog, autoStart: true },
  });
  const port = runPort(down);
  expect(port.status).toBe("ok");
  expect(port.detail).toContain("starts on demand (daemon.auto-start on)");
  expect(port.fix).toBeUndefined();
  expect((port.value as Record<string, unknown>).autoStart).toBe(true);
  const pid = runPid(down);
  expect(pid.status).toBe("ok");
  expect(pid.detail).toContain("starts on demand (daemon.auto-start on)");
  expect(pid.fix).toBeUndefined();
  expect((pid.value as Record<string, unknown>).autoStart).toBe(true);
  expect(exitCodeFor(evaluateAll("runtime", { runtimes: [down] }))).toBe(0);
  expect(exitCodeFor(evaluateAll("full", { runtimes: [down] }))).toBe(0);

  // Auto-start never excuses an orphan or foreign occupant: the resolver would not relaunch over a busy port.
  const occupied = defaultTarget({
    trackedPid: null,
    pidTracked: false,
    watchdog: { ...defaultTarget().watchdog, autoStart: true },
  });
  expect(runPid(occupied).status).toBe("fail");
});

test("classifyPortState matches the pre-union ownership decision tree over every input", () => {
  // The retired checkRuntimeOrphan derivation, kept verbatim as the oracle: the
  // classifier must agree on the FULL input product, not hand-picked cases.
  const oracle = (f: {
    proxyExpected: boolean;
    reachable: boolean;
    pidTracked: boolean;
    identityConfirmed: boolean | null;
  }): PortState => {
    const foreign = f.identityConfirmed === false;
    const orphan = f.reachable && !f.pidTracked && f.proxyExpected && !foreign;
    if (foreign) return { kind: "foreign" };
    if (orphan) {
      return {
        kind: "orphan",
        identity: f.identityConfirmed === true ? "confirmed" : "unconfirmed",
      };
    }
    if (!f.proxyExpected && f.reachable) return { kind: "unrouted" };
    if (f.reachable && f.pidTracked) return { kind: "tracked" };
    return { kind: "down" };
  };
  for (const proxyExpected of [true, false]) {
    for (const reachable of [true, false]) {
      for (const pidTracked of [true, false]) {
        for (const identityConfirmed of [true, false, null]) {
          const input = { proxyExpected, reachable, pidTracked, identityConfirmed };
          expect(classifyPortState(input)).toEqual(oracle(input));
        }
      }
    }
  }
  // A few named anchors, so a broken oracle cannot silently agree with a broken
  // classifier on the states the checks actually branch on.
  expect(classifyPortState({
    proxyExpected: true,
    reachable: true,
    pidTracked: true,
    identityConfirmed: true,
  })).toEqual({ kind: "tracked" });
  expect(classifyPortState({
    proxyExpected: true,
    reachable: true,
    pidTracked: true,
    identityConfirmed: false,
  })).toEqual({ kind: "foreign" });
  expect(classifyPortState({
    proxyExpected: true,
    reachable: true,
    pidTracked: false,
    identityConfirmed: null,
  })).toEqual({ kind: "orphan", identity: "unconfirmed" });
  expect(classifyPortState({
    proxyExpected: false,
    reachable: true,
    pidTracked: false,
    identityConfirmed: null,
  })).toEqual({ kind: "unrouted" });
  expect(classifyPortState({
    proxyExpected: true,
    reachable: false,
    pidTracked: false,
    identityConfirmed: null,
  })).toEqual({ kind: "down" });
});

test("runtime watchdog: off, disabled, and active states are all ok with informative detail", () => {
  const off = checkRuntimeWatchdog(defaultTarget()); // the fixture has watchdog.autoStart=false
  expect(off.status).toBe("ok");
  expect(off.detail).toContain("off");
  expect(off.value).toEqual({ autoStart: false });

  const disabled = checkRuntimeWatchdog(
    defaultTarget({
      watchdog: { ...defaultTarget().watchdog, autoStart: true, idleTimeoutMs: 0 },
    }),
  );
  expect(disabled.detail).toContain("disabled");

  // Active: window 1h, last beat 20m ago, no request traffic -> 40m remaining, 20m idle.
  const now = 1_000_000_000;
  const active = checkRuntimeWatchdog(
    defaultTarget({
      watchdog: {
        autoStart: true,
        idleTimeoutMs: 3_600_000,
        lastEnsureAt: now - 20 * 60_000,
        lastRequestMs: null,
        now,
      },
    }),
  );
  expect(active.status).toBe("ok");
  expect(active.detail).toContain("auto-stops in 40m");
  expect(active.detail).toContain("idle for 20m");
  expect(active.detail).toContain("last beat 20m ago");
  expect(active.detail).toContain("last request none");
  expect(active.value?.remainingMs).toBe(40 * 60_000);
  expect(active.value?.idleMs).toBe(20 * 60_000);

  // Idle past the window clamps remaining to 0; the persisted request mark beats the older beat.
  const expired = checkRuntimeWatchdog(
    defaultTarget({
      watchdog: {
        autoStart: true,
        idleTimeoutMs: 600_000,
        lastEnsureAt: now - 3_600_000,
        lastRequestMs: now - 1_200_000, // 20m ago, more recent than the beat
        now,
      },
    }),
  );
  expect(expired.value?.idleMs).toBe(1_200_000);
  expect(expired.value?.remainingMs).toBe(0);
  expect(expired.detail).toContain("auto-stops in 0s");

  // The daemon's real baseline includes a startedAtMs the probe cannot see, so no precise full window is faked.
  const fresh = checkRuntimeWatchdog(
    defaultTarget({
      watchdog: {
        autoStart: true,
        idleTimeoutMs: 3_600_000,
        lastEnsureAt: null,
        lastRequestMs: null,
        now,
      },
    }),
  );
  expect(fresh.detail).toContain("idle for unknown");
  expect(fresh.detail).toContain("auto-stops in unknown");
  expect(fresh.value?.idleMs).toBeNull();
  expect(fresh.value?.remainingMs).toBeNull();
});

test("runtime watchdog: both agents direct collapses to one line, no stale countdown", () => {
  // A daemon nothing routes to may still carry marks from an earlier run; its countdown is noise.
  const stale = checkRuntimeWatchdog(
    defaultTarget({
      proxyExpected: false,
      watchdog: {
        autoStart: true,
        idleTimeoutMs: 3_600_000,
        lastEnsureAt: 1_000_000_000 - 25 * 3_600_000,
        lastRequestMs: null,
        now: 1_000_000_000,
      },
    }),
  );
  expect(stale.status).toBe("ok");
  expect(stale.detail).toBe("not required (Codex + Claude are both direct)");
  expect(stale.detail).not.toContain("auto-stops");
  expect(stale.detail).not.toContain("idle for");
  expect(stale.detail).not.toContain("last beat");
  expect(stale.value).toEqual({ bothDirect: true });

  // The gate precedes the auto-start and idle-timeout branches, so neither reintroduces the narration.
  const offAndDirect = checkRuntimeWatchdog(
    defaultTarget({
      proxyExpected: false,
      watchdog: { ...defaultTarget().watchdog, autoStart: false },
    }),
  );
  expect(offAndDirect.detail).toBe("not required (Codex + Claude are both direct)");
  const disabledAndDirect = checkRuntimeWatchdog(
    defaultTarget({
      proxyExpected: false,
      watchdog: { ...defaultTarget().watchdog, autoStart: true, idleTimeoutMs: 0 },
    }),
  );
  expect(disabledAndDirect.detail).toBe("not required (Codex + Claude are both direct)");
});

test("runtime identity: confirmed ok, foreign warns, down/not-probed stays ok", () => {
  const ok = runIdentity(defaultTarget()); // identityConfirmed: true
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("confirmed copilot-api");

  // Agent requests genuinely route to the foreign occupant here, so the warning must survive the
  // both-direct exemption.
  const foreign = runIdentity(defaultTarget({ identityConfirmed: false }));
  expect(foreign.status).toBe("warn");
  expect(foreign.detail).toContain("non-copilot-api");
  expect(foreign.detail).toContain("misroute");
  expect(foreign.fix).toContain("free the port");

  // runtime.port owns the down verdict.
  expect(
    runIdentity(defaultTarget({ reachable: false, identityConfirmed: null })).status,
  ).toBe("ok");
  expect(runIdentity(defaultTarget({ identityConfirmed: null })).status).toBe("ok");
  expect(runIdentity(defaultTarget()).scopes).toEqual(["full", "proxy"]);
});

test("runtime orphan: untracked-but-ours warns, foreign defers to identity, tracked ok", () => {
  const orphan = runOrphan(
    defaultTarget({ pidTracked: false, trackedPid: null, identityConfirmed: true }),
  );
  expect(orphan.status).toBe("warn");
  expect(orphan.detail).toContain("orphaned");
  expect(orphan.fix).toContain("agent stop");

  // A foreign listener is runtime.identity's verdict, so orphan must not also warn.
  expect(
    runOrphan(defaultTarget({ pidTracked: false, identityConfirmed: false })).status,
  ).toBe("ok");

  // A foreign responder while the tracked pid is alive: orphan stays ok and must not claim the
  // tracked daemon owns the port; the misrouting warning is runtime.identity's.
  const foreignTracked = runOrphan(defaultTarget({ identityConfirmed: false }));
  expect(foreignTracked.status).toBe("ok");
  expect(foreignTracked.detail).not.toContain("tracked daemon");
  expect(foreignTracked.detail).toContain("not copilot-api");

  expect(runOrphan(defaultTarget()).status).toBe("ok");

  expect(
    runOrphan(defaultTarget({ pidTracked: false, proxyExpected: false })).status,
  ).toBe("ok");
});

test("runtime checks stamp the target's profile; environment checks stay null", () => {
  expect(runPort(defaultTarget()).profile).toBeNull();
  expect(checkRuntimeWatchdog(defaultTarget()).profile).toBeNull();
  const named = profileTarget("work", { reachable: false });
  expect(runPort(named).profile).toBe(parseProfileName("work"));
  expect(runOrphan(named).profile).toBe(parseProfileName("work"));
  expect(checkDeno(BOOTSTRAP_OK).profile).toBeNull();
  expect(checkCliVersion(BOOTSTRAP_OK).profile).toBeNull();
});

test("the identity probe (an extra request) is skipped in the fast runtime scope", async () => {
  const restoreEnv = envSnapshot();
  const home = isolateProxyHome("copilot-health-fast-scope-");
  try {
    writeRunState({ port: 4141 });
    let identityCalls = 0;
    const facts = await gatherFacts("runtime", {}, {
      reach: async () => true,
      proxyIdentity: async () => {
        identityCalls++;
        return true;
      },
    });
    expect(identityCalls).toBe(0);
    expect(probeOf(facts.runtimes?.[0]).identityConfirmed).toBeNull();
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("gatherFacts probes identity only when an agent routes through the proxy", async () => {
  // Nothing routes to a both-direct port, so the identity probe must not fire and the misroute
  // warning is structurally unreachable there, not merely suppressed; one proxy-wired agent brings
  // the probe back and a foreign responder earns the warning.
  const directHost = "https://api.githubcopilot.com";
  const rows: {
    name: string;
    codex: CodexConfigTomlOptions;
    claude: ClaudeSettingsOptions | null;
    identityCalls: number;
    proxyExpected: boolean;
    identityConfirmed: boolean | null;
    identity: { status: CheckStatus; detail?: string };
    sweep?: CheckStatus;
  }[] = [
    {
      name: "both direct",
      codex: { baseUrl: directHost },
      claude: { apiKeyHelper: directHelperCommand(), baseUrl: directHost },
      identityCalls: 0,
      proxyExpected: false,
      identityConfirmed: null,
      identity: { status: "ok" },
      sweep: "ok",
    },
    {
      name: "Codex through the proxy, Claude unconfigured",
      codex: { baseUrl: "http://127.0.0.1:4141/v1", envKey: "OPENAI_API_KEY" },
      claude: null,
      identityCalls: 1,
      proxyExpected: true,
      identityConfirmed: false,
      identity: { status: "warn", detail: "misroute" },
    },
  ];
  for (const row of rows) {
    const root = tempDir("copilot-health-identity-");
    const restoreEnv = envSnapshot();
    process.env.COPILOT_API_HOME = join(root, "api-home"); // isolated: no profile homes
    try {
      writeRunState({ port: 4141 });
      const codexHome = join(root, "codex-home");
      writeCodexConfigToml(codexHome, row.codex);
      const claudeHome = join(root, "claude-home");
      if (row.claude) writeClaudeSettings(claudeHome, row.claude);
      let identityCalls = 0;
      const facts = await gatherFacts(
        "proxy", // an identity-probing scope (unlike the fast `runtime` one)
        {},
        {
          reach: async () => true, // a listener answers on the port
          proxyIdentity: async () => {
            identityCalls++;
            return false; // no x-trace-id: a foreign service
          },
          codexHome: () => codexHome,
          claudeHome: () => claudeHome,
        },
      );
      const target = facts.runtimes?.[0];
      if (!target) throw new Error(`${row.name}: expected the default runtime target`);
      expect(identityCalls, row.name).toBe(row.identityCalls);
      expect(target.proxyExpected, row.name).toBe(row.proxyExpected);
      expect(probeOf(target).identityConfirmed, row.name).toBe(row.identityConfirmed);
      const identity = runIdentity(target);
      expect(identity.status, row.name).toBe(row.identity.status);
      if (row.identity.detail !== undefined) {
        expect(identity.detail, row.name).toContain(row.identity.detail);
      }
      if (row.sweep !== undefined) {
        expect(worstStatus(evaluateAll("proxy", { runtimes: facts.runtimes })), row.name).toBe(
          row.sweep,
        );
      }
    } finally {
      restoreEnv();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a mixed default Claude config (direct helper, proxy base URL) expects the proxy", async () => {
  // Claude's MODE keys off apiKeyHelper alone, so this config reads both-direct while ANTHROPIC_BASE_URL
  // sends Claude's traffic to the local daemon. Health once trusted the modes and reported "not
  // required" with the daemon down; the base-URL fact must bring back the full runtime treatment.
  const root = tempDir("copilot-health-mixed-");
  const restoreEnv = envSnapshot();
  process.env.COPILOT_API_HOME = join(root, "api-home"); // isolated: no profile homes
  try {
    const codexHome = join(root, "codex-home");
    writeCodexConfigToml(codexHome, { baseUrl: "https://api.githubcopilot.com" });
    const claudeHome = join(root, "claude-home");
    writeClaudeSettings(claudeHome, {
      apiKeyHelper: directHelperCommand(),
      baseUrl: "http://127.0.0.1:4141",
    });
    const deps = {
      codexHome: () => codexHome,
      claudeHome: () => claudeHome,
    };

    // Auto-start defaults off, so a down daemon is a FAIL here.
    const down = await gatherFacts("proxy", {}, { ...deps, reach: async () => false });
    const downTarget = down.runtimes?.[0];
    if (!downTarget) throw new Error("expected the default runtime target");
    expect(downTarget.proxyExpected).toBe(true);
    const port = runPort(downTarget);
    expect(port.status).toBe("fail");
    expect(port.fix).toContain("agent start");
    expect(runPid(downTarget).status).toBe("fail");

    // Reachable: the identity probe fires again (proxyExpected gates it).
    let identityCalls = 0;
    const up = await gatherFacts("proxy", {}, {
      ...deps,
      reach: async () => true,
      proxyIdentity: async () => {
        identityCalls++;
        return true;
      },
    });
    expect(identityCalls).toBe(1);
    expect(probeOf(up.runtimes?.[0]).identityConfirmed).toBe(true);
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable settings file reaches health as other/read-error, never as none", async () => {
  // The settings file is read three-way (readTextResult); a null read would collapse an unreadable
  // file into the absent/none verdict. A directory at the file's path is unreadable on every OS.
  const restoreEnv = envSnapshot();
  const home = isolateProxyHome("copilot-health-unreadable-claude-");
  try {
    const claudeHome = join(home, "claude-home");
    mkdirSync(join(claudeHome, "settings.json"), { recursive: true });
    const facts = await gatherFacts("claude", {}, {
      claudeHome: () => claudeHome,
      codexDirectAuth: () => Promise.resolve({ command: null, authenticated: false }),
      ghActiveLogin: () => Promise.resolve(null),
    });
    expect(facts.claude?.providerMode).toBe("other");
    expect(facts.claude?.otherReason).toBe("read-error");
    if (!facts.claude) throw new Error("expected claude facts");
    const verdict = checkClaude(facts.claude, null);
    expect(verdict.status).toBe("warn");
    expect(verdict.detail).toContain("could not be read");
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("an unreadable codex config reaches health as other/read-error, never as none", async () => {
  // The codex config.toml is read three-way too; a null read once collapsed an unreadable config
  // into the absent "not wired" OK verdict.
  const restoreEnv = envSnapshot(["OPENAI_API_KEY"]);
  const home = isolateProxyHome("copilot-health-unreadable-codex-");
  try {
    delete process.env.OPENAI_API_KEY;
    const codexHome = join(home, "codex-home");
    mkdirSync(join(codexHome, "config.toml"), { recursive: true });
    const facts = await gatherFacts("codex", {}, {
      codexHome: () => codexHome,
      codexDirectAuth: () => Promise.resolve({ command: null, authenticated: false }),
      ghActiveLogin: () => Promise.resolve(null),
    });
    expect(facts.codex?.providerMode).toBe("other");
    expect(facts.codex?.otherReason).toBe("read-error");
    expect(facts.codex?.configExists).toBe(true);
    if (!facts.codex) throw new Error("expected codex facts");
    const verdict = checkCodex(facts.codex, null);
    expect(verdict.status).toBe("warn");
    expect(verdict.detail).toContain("could not be read");
    expect(verdict.fix).toContain("repair");
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("health's own proxy probes do not move the watchdog activity signal", async () => {
  // lastRequestMs reads the observer's persisted `.activity.json` mark; only inference POSTs move
  // it, so health's own GET probes cannot reset the idle signal.
  const restoreEnv = envSnapshot();
  const home = isolateProxyHome("copilot-health-watchdog-");
  try {
    writeRunState({ pid: 123, port: 4141, lastEnsureAt: 1000 });
    new CopilotEnvConfig().set({ "daemon.auto-start": true, "daemon.idle-timeout": 60 });
    resetInferenceActivityForTests();
    markInference(100_000); // the persisted mark of an old real request
    let probes = 0;
    const facts = await gatherFacts("proxy", {}, {
      reach: async () => {
        probes++;
        return true;
      },
      proxyIdentity: async () => {
        probes++;
        return true;
      },
      classifyTrackedPid: async () => "yes",
      now: () => 5_000_000,
    });
    expect(probes).toBeGreaterThan(0);
    expect(facts.runtimes?.[0]?.watchdog).toEqual({
      autoStart: true,
      idleTimeoutMs: 60_000,
      lastEnsureAt: 1000,
      lastRequestMs: 100_000,
      now: 5_000_000,
    });
  } finally {
    resetInferenceActivityForTests();
    restoreEnv();
    removeDir(home);
  }
});

test("gatherFacts derives proxy.floatSkips from the float's own predicate", async () => {
  // The exemption must key off proxyUnusedEverywhere, the float's own skip predicate, so health and
  // the float agree. The predicate's edge cases live in agents_wiring.test.ts.
  const root = tempDir("copilot-health-float-");
  const restoreEnv = envSnapshot();
  process.env.COPILOT_API_HOME = join(root, "api-home"); // isolated: no profile homes
  delete process.env.COPILOT_API_VERSION; // an inherited pin would force the float
  try {
    const codexHome = join(root, "codex-home");
    writeCodexConfigToml(codexHome, { baseUrl: "https://api.githubcopilot.com" });
    const claudeHome = join(root, "claude-home");
    const apiKeyHelper = directHelperCommand();
    writeClaudeSettings(claudeHome, {
      apiKeyHelper,
      baseUrl: "https://api.githubcopilot.com",
    });

    const overrides = {
      reach: async () => false,
      codexHome: () => codexHome,
      claudeHome: () => claudeHome,
    };
    const direct = await gatherFacts("proxy", {}, overrides);
    expect(direct.proxy?.floatSkips).toBe(true);

    // A mixed Claude config (direct helper, proxy base URL) floats again, so the bounds are enforced again.
    writeClaudeSettings(claudeHome, { apiKeyHelper, baseUrl: "http://127.0.0.1:4141" });
    const mixed = await gatherFacts("proxy", {}, overrides);
    expect(mixed.proxy?.floatSkips).toBe(false);
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("with no recorded port the default target probes the configured port, marked unpersisted", async () => {
  // proxyStatus's rule: the port comes from the run-state snapshot, else the configured default,
  // and only a recorded port counts as persisted (a named target's probe gate).
  const restoreEnv = envSnapshot();
  const home = isolateProxyHome("copilot-health-fallback-");
  try {
    new CopilotEnvConfig().set({ "daemon.port": 4444 });
    const facts = await gatherFacts("runtime", {}, { reach: async () => false });
    expect(facts.runtimes?.[0]).toMatchObject({ port: 4444, portPersisted: false });
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

test("gatherFacts is read-only: no files appear in a fresh isolated home", async () => {
  // Health observes, never writes: no home, run dir, or port reservation (reserveProfilePort is write-path).
  const root = tempDir("copilot-health-readonly-");
  const restoreEnv = envSnapshot();
  const home = join(root, "api-home"); // never created -- gatherFacts must not mkdir it
  process.env.COPILOT_API_HOME = home;
  try {
    const facts = await gatherFacts(
      "proxy",
      {},
      {
        reach: async () => false, // keep the probe offline-deterministic; reach does no fs I/O
        codexHome: () => join(root, "codex-home"),
        claudeHome: () => join(root, "claude-home"),
      },
    );
    expect(facts.runtimes?.map((t) => t.profile)).toEqual([null]);
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- bootstrap checks -------------------------------------------------------

test("deno is named; node_modules absent fails, stale warns, fresh ok", () => {
  expect(checkDeno(BOOTSTRAP_OK)).toMatchObject({ status: "ok", detail: "deno 2.9.5" });
  expect(checkNodeModules(BOOTSTRAP_OK).status).toBe("ok");
  expect(
    checkNodeModules({ ...BOOTSTRAP_OK, nodeModules: { present: false, fresh: false } }).status,
  ).toBe("fail");
  expect(
    checkNodeModules({ ...BOOTSTRAP_OK, nodeModules: { present: true, fresh: false } }).status,
  ).toBe("warn");
  // A compiled binary embeds its dependencies (nodeModules null); it cannot have node_modules to fail on.
  const embedded = checkNodeModules({ ...BOOTSTRAP_OK, nodeModules: null });
  expect(embedded.status).toBe("ok");
  expect(embedded.detail).toContain("embedded");
  expect(embedded.fix).toBeUndefined();
});

// --- setup checks -----------------------------------------------------------

test("shell + launcher wiring: missing warns, present ok", () => {
  const wired = { files: [], integrationWired: true, launchersWired: true };
  const bare = { files: [], integrationWired: false, launchersWired: false };
  expect(checkShellIntegration(wired).status).toBe("ok");
  const notWired = checkShellIntegration(bare);
  expect(notWired.status).toBe("warn");
  expect(notWired.detail).toBe("not wired into any shell rc/profile");
  // An UNPROVEN census (discovery never ran) keeps the warn + fix but never the confident "not wired".
  const unproven = checkShellIntegration({ ...bare, targetsUnproven: true });
  expect(unproven.status).toBe("warn");
  expect(unproven.detail).toBe(
    "could not check the shell rc/profile files (target discovery failed to run)",
  );
  expect(unproven.fix).toBe("agent shell");
  expect(unproven.value).toMatchObject({ targetsUnproven: true });
  expect(checkLaunchers(wired).status).toBe("ok");
  expect(checkLaunchers(bare).status).toBe("warn");
});

test("optional CLI + tools: missing warns (not fail), present ok, a FAILED look says could-not-check", () => {
  expect(checkCli({ command: "claude", name: "Claude", look: { path: "/bin/claude" } }).status)
    .toBe("ok");
  const missing = checkCli({ command: "codex", name: "Codex", look: { path: null } });
  expect(missing.status).toBe("warn");
  expect(missing.detail).toBe("not installed (optional)");
  // An unproven look keeps the warn + fix but never claims "not installed".
  const unproven = checkCli({
    command: "codex",
    name: "Codex",
    look: { path: null, launchFailed: true },
  });
  expect(unproven.status).toBe("warn");
  expect(unproven.detail).toBe("could not check (the command probe failed to run)");
  expect(unproven.fix).toBe("agent shell --clis");
  expect(unproven.value).toEqual({ command: "codex", resolved: null, lookFailed: true });

  // The tools share the CLI census's look row under their own registered ids.
  expect(checkLook(meta("setup.tool.node"), { path: "/usr/bin/node" })).toMatchObject({
    id: "setup.tool.node",
    label: "node",
    status: "ok",
  });
  expect(checkLook(meta("setup.tool.npm"), { path: null })).toMatchObject({
    status: "warn",
    detail: "not installed (optional)",
  });
  const toolUnproven = checkLook(meta("setup.tool.npm"), { path: null, launchFailed: true });
  expect(toolUnproven.status).toBe("warn");
  expect(toolUnproven.detail).toBe("could not check (the command probe failed to run)");
  expect(toolUnproven.value).toEqual({ resolved: null, lookFailed: true });
});

// --- auth (credential) check ------------------------------------------------

test("checkAuth: the default credential facts decide status, detail, and fix", () => {
  const base = {
    profile: null,
    storedToken: false,
    ghAuthenticated: false,
    profiles: {},
    pinnedIntegrationId: null,
  };
  const rows: {
    name: string;
    facts: AuthFacts;
    status: CheckStatus;
    detail: string[];
    fix?: string;
  }[] = [
    {
      name: "stored token",
      facts: { ...base, storedToken: true, provider: "gh-token" },
      status: "ok",
      detail: ["stored GitHub token", "gh-token"],
    },
    {
      name: "gh CLI authenticated, no stored token",
      facts: { ...base, ghAuthenticated: true, provider: "gh-cli" },
      status: "ok",
      detail: ["gh CLI"],
    },
    {
      name: "no provider",
      facts: { ...base, provider: null },
      status: "warn",
      detail: ["not authenticated"],
      fix: "agent auth",
    },
    {
      // Only validated names arrive here: the producer sweeps via profileNames() (pinned in state.test.ts).
      name: "named profiles line",
      facts: {
        ...base,
        storedToken: true,
        provider: "gh-token",
        profiles: {
          [parseProfileName("fast")]: { provider: null, mode: "proxy" },
          [parseProfileName("work")]: { provider: "gh-token", mode: "direct" },
        },
      },
      status: "ok",
      detail: ["named profiles: fast (no auth, proxy), work (gh-token, direct)"],
    },
  ];
  for (const row of rows) {
    const res = checkAuth(row.facts);
    expect(res.group, row.name).toBe("auth");
    expect(res.status, row.name).toBe(row.status);
    for (const needle of row.detail) expect(res.detail, row.name).toContain(needle);
    expect(res.fix, row.name).toBe(row.fix);
  }
});

test("checkAuth: gh-cli with an UNPROVEN gh probe warns could-not-check, never `gh auth login` advice", () => {
  const unproven = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    ghAuthUnproven: true,
    profile: null,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(unproven.status).toBe("warn");
  expect(unproven.detail).toBe([
    "provider 'gh-cli' is selected but its credential could not be checked",
    "could not check gh authentication " +
    "(`gh auth token` did not run to completion; AUTO - follows gh's active account)",
  ].join("\n"));
  expect(unproven.fix).toBe("agent auth");
  expect(unproven.value).toMatchObject({ ghAuthUnproven: true });
  // A PROVEN miss keeps the confident wording and advice.
  const proven = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    profile: null,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(proven.detail).toBe([
    "provider 'gh-cli' is selected but no credential resolves",
    "`gh` is unauthenticated (AUTO - follows gh's active account) - run `gh auth login`, " +
    "or `agent auth` to switch provider",
  ].join("\n"));
  // A failing AUTO slot names the account it follows: the failure is about octocat's credential.
  const provenNamed = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    ghActiveLogin: "octocat",
    profile: null,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(provenNamed.detail).toContain(
    "`gh` is unauthenticated (AUTO - currently account octocat) - run `gh auth login`",
  );
  // A PINNED slot's verdict names its account (the probe ran `gh auth token --user`); gh's active one may be fine.
  const pinned = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    ghUser: "work-bot",
    profile: null,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(pinned.detail).toBe([
    "provider 'gh-cli' is selected but no credential resolves",
    "`gh` is not authenticated as account 'work-bot' - run `gh auth login` for that account, " +
    "or `agent auth` to switch",
  ].join("\n"));
  const pinnedOk = checkAuth({
    storedToken: false,
    ghAuthenticated: true,
    ghUser: "work-bot",
    profile: null,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(pinnedOk.status).toBe("ok");
  expect(pinnedOk.detail).toContain("gh CLI (`gh auth token --user work-bot`)");
  // A pin gh could not answer with `--user` was served by the plain host-scoped call: the report
  // names the call that ran, never the one it assumed.
  const pinnedServedPlain = checkAuth({
    storedToken: false,
    ghAuthenticated: true,
    ghUser: "work-bot",
    ghCommand: "gh auth token --hostname github.com",
    profile: null,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(pinnedServedPlain.detail).toContain(
    "gh CLI (`gh auth token --hostname github.com`, account work-bot)",
  );
  // An AUTO slot names the account it follows right now (no hidden information).
  const autoNamed = checkAuth({
    storedToken: false,
    ghAuthenticated: true,
    ghActiveLogin: "octocat",
    profile: null,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(autoNamed.status).toBe("ok");
  expect(autoNamed.detail).toContain("gh CLI (`gh auth token`, AUTO - currently account octocat)");
});

// --- live (--live) checks ---------------------------------------------------

test("runLiveCli: a FAILED CLI look skips MARKED; a proven absence skips unmarked", async () => {
  const launch = codexLiveLaunch("/tmp", null);
  expect(await runLiveCli(launch, () => ({ path: null, launchFailed: true }))).toEqual({
    kind: "skipped",
    lookFailed: true,
  });
  expect(await runLiveCli(launch, () => ({ path: null }))).toEqual({ kind: "skipped" });
});

test("evaluateAll(full) includes the live checks only when their facts are present", () => {
  const facts: HealthFacts = {
    codexLive: { kind: "ok", cli: "/bin/codex" },
    claudeLive: { kind: "failed", cli: "/bin/claude", detail: "exit 1" },
  };
  const ids = evaluateAll("full", facts).map((r) => r.id);
  expect(ids).toContain("codex.live");
  expect(ids).toContain("claude.live");
  expect(evaluateAll("full", {}).map((r) => r.id)).not.toContain("codex.live");
});

// --- setup facts ------------------------------------------------------------

test("the shell census reads each target file for the marker; launchersWired is the config key", async () => {
  const restoreEnv = envSnapshot();
  const home = isolateProxyHome("copilot-health-shell-");
  try {
    const wired = join(home, "rc-wired");
    const bare = join(home, "rc-bare");
    writeFileSync(wired, `before\n# copilot-env shell integration\nsource x\n`);
    writeFileSync(bare, "source y\n");
    const missing = join(home, "rc-missing");
    const deps = {
      shellTargets: () => [wired, bare, missing],
      commandLook: () => ({ path: null }),
      codexHome: () => join(home, "no-codex"),
      claudeHome: () => join(home, "no-claude"),
    };
    const facts = await gatherFacts("setup", {}, deps);
    expect(facts.shell).toEqual({
      files: [
        { path: wired, hasIntegration: true },
        { path: bare, hasIntegration: false },
        { path: missing, hasIntegration: false },
      ],
      integrationWired: true,
      launchersWired: false,
    });
    // The marker decides per file; the launchers follow the `shell.launchers` key alone.
    new CopilotEnvConfig().set({ "shell.launchers": true });
    const unwired = await gatherFacts("setup", {}, { ...deps, shellTargets: () => [bare] });
    expect(unwired.shell).toMatchObject({ integrationWired: false, launchersWired: true });
  } finally {
    restoreEnv();
    removeDir(home);
  }
});

function proxyToml(baseUrl: string): string {
  return codexConfigToml({ baseUrl, auth: proxyTokenCommand() });
}

test("inspectCodexWiring: config.toml, .env, and the environ decide the wiring facts", () => {
  const good = proxyToml("http://localhost:4141/v1");
  const env = "OPENAI_API_KEY=sk-test\n";
  const rows: {
    name: string;
    toml: string | null;
    env: string | null;
    environ?: true;
    facts: Partial<CodexFacts>;
  }[] = [
    {
      name: "no config.toml",
      toml: null,
      env: null,
      facts: { configExists: false, providerWired: false, providerMode: "none" },
    },
    {
      name: "managed proxy provider + .env key",
      toml: good,
      env,
      facts: {
        providerMode: "proxy",
        providerWired: true,
        envKeyInDotenv: true,
        tokenAvailable: true,
      },
    },
    {
      name: "stale port",
      toml: proxyToml("http://localhost:9999/v1"),
      env,
      facts: { providerWired: false },
    },
    {
      name: "foreign auth command",
      toml: codexConfigToml({
        baseUrl: "http://localhost:4141/v1",
        auth: { command: "/usr/local/bin/other", args: ["--yes"] },
      }),
      env,
      facts: { providerWired: false },
    },
    {
      // The pre-4.0.0 proxy shape (`env_key` instead of the managed auth block) is proxy by base_url
      // but never managed wiring; the 4.0.0 migration rewrites it.
      name: "legacy env_key provider",
      toml: codexConfigToml({ baseUrl: "http://localhost:4141/v1", envKey: "OPENAI_API_KEY" }),
      env,
      facts: {
        providerMode: "proxy",
        envKeyMatches: false,
        providerWired: false,
        tokenAvailable: true,
      },
    },
    {
      name: "key only in the environ",
      toml: good,
      env: "FOO=1\n",
      environ: true,
      facts: { envKeyInDotenv: false, envKeyInEnviron: true, tokenAvailable: true },
    },
    { name: "key nowhere", toml: good, env: "FOO=1\n", facts: { tokenAvailable: false } },
    {
      name: "spaces around the .env equals sign",
      toml: good,
      env: "OPENAI_API_KEY = sk-test\n",
      facts: { envKeyInDotenv: true },
    },
    {
      name: "direct provider needs no OPENAI_API_KEY",
      toml:
        `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "https://api.githubcopilot.com"\n`,
      env: null,
      facts: { providerMode: "direct", providerWired: true, tokenAvailable: false },
    },
  ];
  for (const row of rows) {
    expect(inspectCodexWiring(row.toml, row.env, 4141, row.environ ?? false), row.name)
      .toMatchObject(row.facts);
  }
});

test("inspectCodexWiring: base_url matches only the full http://localhost:<port>/v1 contract", () => {
  const env = "OPENAI_API_KEY=x\n";
  const rows: { baseUrl: string; matches: boolean }[] = [
    { baseUrl: "http://localhost:4141/v1", matches: true },
    { baseUrl: "http://127.0.0.1:4141/v1/", matches: true },
    { baseUrl: "http://localhost:4141", matches: false },
    { baseUrl: "https://localhost:4141/v1", matches: false },
    { baseUrl: "http://localhost:4141/not-v1", matches: false },
    // The port must match whole: 41410 once satisfied 4141 as a substring.
    { baseUrl: "http://localhost:41410/v1", matches: false },
  ];
  for (const row of rows) {
    expect(inspectCodexWiring(proxyToml(row.baseUrl), env, 4141, false), row.baseUrl)
      .toMatchObject({
        baseUrlMatches: row.matches,
        providerWired: row.matches,
      });
  }
});

test("checkAutoupdate: full status always shown (disabled too); recorded error warns", () => {
  const base = { enabled: false, cooldownDays: 7, lastCheckMs: 0, lastResult: "" };
  const disabled = checkAutoupdate(base);
  expect(disabled.status).toBe("ok");
  expect(disabled.detail).toContain("disabled");
  expect(disabled.detail).toContain("cooldown 7d");
  expect(disabled.detail).toContain("last check never");
  expect(disabled.detail).toContain("last result: (none)");

  const enabled = {
    ...base,
    enabled: true,
    lastCheckMs: 1_700_000_000_000,
    lastResult: "up to date",
  };
  expect(checkAutoupdate(enabled).status).toBe("ok");
  expect(checkAutoupdate(enabled).detail).toContain("enabled");
  expect(checkAutoupdate(enabled).detail).toContain("up to date");

  const errored = { ...enabled, lastResult: "error: deno install failed after update" };
  const r = checkAutoupdate(errored);
  expect(r.status).toBe("warn");
  expect(r.fix).toBe("agent update --auto-status");
});

// --- evaluateAll scope filtering --------------------------------------------

test("evaluateAll: each scope yields its own check ids", () => {
  const full: HealthFacts = {
    runtimes: [defaultTarget()],
    bootstrap: BOOTSTRAP_OK,
    proxy: {
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds: 604800,
      floatSkips: false,
      resolved: null,
      sidecar: DEV_SIDECAR,
    },
    shell: { files: [], integrationWired: true, launchersWired: false },
    clis: [{ command: "claude", name: "Claude", look: { path: null } }],
    tools: { node: { path: "/n" }, npm: { path: "/m" } },
    codex: CODEX_UNCONFIGURED,
    codexHost: CODEX_HOST_UNSUPPORTED,
    claude: {
      home: "/h/.claude",
      settingsPath: "/h/.claude/settings.json",
      settingsExists: false,
      credential: null,
      helperPath: null,
      baseUrl: null,
      baseUrlMatches: false,
      providerMode: "none",
      wired: false,
      otherReason: null,
      directAuth: { command: null, authenticated: false },
      directUsesToken: false,
    },
    claudeDesktop: { kind: "no-library", enabled: true, installed: false, helperPaths: [] },
    autoupdate: { enabled: false, cooldownDays: 7, lastCheckMs: 0, lastResult: "" },
  };
  const rows: {
    scope: HealthScope;
    facts: HealthFacts;
    exactly?: CheckId[];
    includes?: CheckId[];
  }[] = [
    // The fast probe scope: exactly the two runtime checks.
    {
      scope: "runtime",
      facts: { runtimes: [defaultTarget()] },
      exactly: ["runtime.port", "runtime.pid"],
    },
    {
      scope: "codex",
      facts: { codex: CODEX_UNCONFIGURED, codexHost: CODEX_HOST_UNSUPPORTED },
      exactly: ["setup.codex"],
    },
    {
      scope: "full",
      facts: full,
      includes: [
        "runtime.paths",
        "setup.cli.claude",
        "proxy.package",
        "setup.codex-host",
        "setup.claude",
        "setup.claude-desktop",
        "setup.autoupdate",
      ],
    },
  ];
  for (const row of rows) {
    const ids = evaluateAll(row.scope, row.facts).map((r) => r.id);
    if (row.exactly) expect(ids, row.scope).toEqual(row.exactly);
    for (const id of row.includes ?? []) expect(ids, row.scope).toContain(id);
  }
});

test("checkAuth: an unproven pinned look names the gh call that timed out and keeps what the completed call said", () => {
  // The pinned call completed (a miss); the status call behind the fallback was the one killed.
  const detail = "`gh auth token --user work-bot --hostname github.com` exited 1: no oauth token " +
    "found; `gh auth status --hostname github.com` did not complete";
  const unproven = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    ghAuthUnproven: true,
    ghUser: "work-bot",
    ghDetail: detail,
    profile: null,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(unproven.status).toBe("warn");
  expect(unproven.detail).toContain(`could not check gh authentication (${detail}; `);
  expect(unproven.detail).not.toContain("`gh auth token` did not run to completion");
});
