import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directHelperCommand, legacyDirectHelperScript } from "../src/claude/config.ts";
import { directHelperPath, proxyHelperPath, settingsPathFor } from "../src/claude/paths.ts";
import { DEFAULT_HOME_STAGING_DIR, PROFILES_DIR_NAME } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import type { TextReadResult } from "../src/utils/fs.ts";
import {
  buildHealthJson,
  exitCodeFor,
  filterByScope,
  isHealthScope,
  worstStatus,
} from "../src/health/aggregate.ts";
import {
  checkAuth,
  checkAutoupdate,
  checkClaude,
  checkClaudeLive,
  checkCli,
  checkCliVersion,
  checkCodex,
  checkCodexHost,
  checkCodexLive,
  checkDefaultHomeMigration,
  checkDeno,
  checkLaunchers,
  checkNodeModules,
  checkProxyPackage,
  checkProxyResolved,
  checkProxySidecar,
  checkRuntimeIdentity,
  checkRuntimeOrphan,
  checkRuntimePid,
  checkRuntimePort,
  checkRuntimeWatchdog,
  checkShellIntegration,
  checkTool,
  evaluateAll,
} from "../src/health/checks.ts";
import {
  type BootstrapFacts,
  classifyPortState,
  type ClaudeFacts,
  type CodexFacts,
  type CodexHostFacts,
  type DaemonProbed,
  type DefaultRuntimeTarget,
  directAuthFromSpawn,
  evalCodex,
  evalShellFiles,
  gatherFacts,
  type HealthFacts,
  type PortState,
  type ProxyFacts,
  runLiveCli,
  type RuntimeTarget,
  type WatchdogFacts,
} from "../src/health/probe.ts";
import type { CheckId, CheckResult, CheckStatus, HealthScope } from "../src/health/types.ts";
import { expect, test } from "./helpers/testing.ts";
import { envSnapshot, writeClaudeSettings, writeCodexConfigToml } from "./helpers.ts";

// --- fixtures ---------------------------------------------------------------

function result(id: CheckId, status: CheckStatus, scopes: HealthScope[]): CheckResult {
  const base = { id, label: String(id), group: "runtime" as const, profile: null, scopes };
  // The CheckOutcome union: warn/fail must carry a fix, ok cannot.
  return status === "ok"
    ? { ...base, status, detail: "" }
    : { ...base, status, detail: "", fix: "fix-hint" };
}

/** Flat probe/target overrides, assembled into the RuntimeTarget union shape
 *  (PortState always derived through the probe's own classifier, so a fixture
 *  can never carry a torn ownership verdict). */
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

/** The probed outcome of a target (all fixtures here interrogate the daemon;
 *  gatherFacts-produced targets are narrowed the same way). */
function probeOf(t: RuntimeTarget | undefined): DaemonProbed {
  if (!t || t.probe.kind !== "probed") throw new Error("expected a probed runtime target");
  return t.probe;
}

// Per-daemon checks take (target, probed facts); the fixtures are always probed.
const runPort = (t: RuntimeTarget) => checkRuntimePort(t, probeOf(t));
const runPid = (t: RuntimeTarget) => checkRuntimePid(t, probeOf(t));
const runIdentity = (t: RuntimeTarget) => checkRuntimeIdentity(t, probeOf(t));
const runOrphan = (t: RuntimeTarget) => checkRuntimeOrphan(t, probeOf(t));

/** A default-target runtime fixture (profile null, healthy tracked daemon). */
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

/** A named-profile runtime target fixture (used by the profile-aware tier). */
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
      integrationIdentity: null,
    },
    homeExists: true,
  };
}

const BOOTSTRAP_OK: BootstrapFacts = {
  cliVersion: "3.1.0",
  deno: { available: true, version: "2.9.5" },
  nodeModules: { present: true, fresh: true },
};

// --- aggregate --------------------------------------------------------------

test("worstStatus picks fail > warn > ok and defaults ok when empty", () => {
  expect(worstStatus([])).toBe("ok");
  expect(
    worstStatus([result("runtime.port", "ok", ["full"]), result("runtime.pid", "warn", ["full"])]),
  ).toBe("warn");
  expect(
    worstStatus([
      result("runtime.port", "warn", ["full"]),
      result("runtime.pid", "fail", ["full"]),
      result("runtime.paths", "ok", ["full"]),
    ]),
  ).toBe("fail");
});

test("exitCodeFor is 1 iff any fail; warnings alone exit 0", () => {
  expect(
    exitCodeFor([result("runtime.port", "ok", ["full"]), result("runtime.pid", "warn", ["full"])]),
  ).toBe(0);
  expect(exitCodeFor([result("runtime.port", "fail", ["full"])])).toBe(1);
  expect(exitCodeFor([])).toBe(0);
});

test("filterByScope keeps only participating checks, preserving order", () => {
  const all = [
    result("runtime.port", "ok", ["full", "proxy", "runtime"]),
    result("setup.shell", "warn", ["full", "setup"]),
    result("setup.codex", "ok", ["full", "setup", "codex"]),
    result("bootstrap.deno", "ok", ["full", "proxy"]),
  ];
  expect(filterByScope(all, "runtime").map((r) => r.id)).toEqual(["runtime.port"]);
  expect(filterByScope(all, "setup").map((r) => r.id)).toEqual(["setup.shell", "setup.codex"]);
  expect(filterByScope(all, "codex").map((r) => r.id)).toEqual(["setup.codex"]);
  expect(filterByScope(all, "proxy").map((r) => r.id)).toEqual(["runtime.port", "bootstrap.deno"]);
  expect(filterByScope(all, "full").map((r) => r.id)).toEqual([
    "runtime.port",
    "setup.shell",
    "setup.codex",
    "bootstrap.deno",
  ]);
});

test("isHealthScope narrows known scopes and rejects others", () => {
  for (const s of ["full", "runtime", "proxy", "setup", "codex", "claude"]) {
    expect(isHealthScope(s)).toBe(true);
  }
  expect(isHealthScope("bogus")).toBe(false);
});

test("buildHealthJson exposes scope/ok/status/exitCode/checks with ok === no-fail", () => {
  const okJson = buildHealthJson("full", [result("runtime.port", "warn", ["full"])]);
  expect(okJson).toMatchObject({ scope: "full", ok: true, status: "warn", exitCode: 0 });
  expect(okJson.checks).toHaveLength(1);
  // The CheckOutcome union projected into JSON: fix present exactly on non-ok.
  expect(okJson.checks[0]?.fix).toBe("fix-hint");
  expect(
    buildHealthJson("full", [result("runtime.port", "ok", ["full"])]).checks[0]?.fix,
  ).toBeUndefined();
  // The profile dimension: top-level = the run's narrowing (default null), and
  // every check names its own target (environment checks are null).
  expect(okJson.profile).toBeNull();
  expect(okJson.checks[0]?.profile).toBeNull();

  const failJson = buildHealthJson("runtime", [result("runtime.port", "fail", ["runtime"])]);
  expect(failJson).toMatchObject({ ok: false, status: "fail", exitCode: 1 });
});

// --- proxy version checks -------------------------------------------------

test("proxy package: missing and below-floor fail, above-ceiling warns, in-bounds ok", () => {
  expect(
    checkProxyPackage({
      version: null,
      bounds: { ok: false, reason: "missing", version: null },
      configError: null,
      cooldownSeconds: 604800,
      floatSkips: false,
      resolved: null,
      sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
    }).status,
  ).toBe("fail");
  expect(
    checkProxyPackage({
      version: "1.0.0",
      bounds: { ok: false, reason: "belowFloor", version: "1.0.0", floor: "1.10.0" },
      configError: null,
      cooldownSeconds: 604800,
      floatSkips: false,
      resolved: null,
      sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
    }).status,
  ).toBe("fail");
  const above = checkProxyPackage({
    version: "2.0.0",
    bounds: { ok: false, reason: "aboveCeiling", version: "2.0.0", ceiling: "1.99.0" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: false,
    resolved: null,
    sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
  });
  expect(above.status).toBe("warn");
  expect(above.fix).toBe("agent update");
  expect(
    checkProxyPackage({
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds: 604800,
      floatSkips: false,
      resolved: null,
      sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
    }).status,
  ).toBe("ok");
});

test("proxy package bounds are not enforced when both agents are direct", () => {
  // The float skips when Codex + Claude are both wired Direct (the proxy is
  // unused), so out-of-bounds versions must read ok with a note, not fail --
  // the suggested fixes could not move the version anyway.
  const below = checkProxyPackage({
    version: "1.0.0",
    bounds: { ok: false, reason: "belowFloor", version: "1.0.0", floor: "1.10.0" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
  });
  expect(below.status).toBe("ok");
  // The detail must surface the exemption; the exact phrasing is human copy, so
  // pin only the stable "not enforced" token.
  expect(below.detail).toContain("not enforced");
  expect(below.fix).toBeUndefined();
  // The exemption is machine-readable for --json consumers (mirrors the
  // runtime checks' bothDirect stamp).
  expect((below.value as Record<string, unknown>).floatSkips).toBe(true);

  const above = checkProxyPackage({
    version: "2.0.0",
    bounds: { ok: false, reason: "aboveCeiling", version: "2.0.0", ceiling: "1.99.0" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
  });
  expect(above.status).toBe("ok");
  expect(above.fix).toBeUndefined();

  // A missing package is a broken CHECKOUT in any mode: the exemption must not
  // swallow it (a reinstall genuinely fixes it, float or no float).
  const missing = checkProxyPackage({
    version: null,
    bounds: { ok: false, reason: "missing", version: null },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
  });
  expect(missing.status).toBe("fail");
  expect(missing.fix).toBe("deno install --frozen");

  // An in-bounds proxy on a direct-only machine reads plain ok: no note glued
  // onto the version/cooldown detail, no floatSkips stamp.
  const inBounds = checkProxyPackage({
    version: "1.10.5",
    bounds: { ok: true, version: "1.10.5" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
  });
  expect(inBounds.status).toBe("ok");
  expect(inBounds.detail).not.toContain("not enforced");
  expect((inBounds.value as Record<string, unknown>).floatSkips).toBeUndefined();

  // An unreadable copilot-env.config stays a failure in any mode: the early
  // return fires before the exemption, and its fix is actionable regardless.
  const badConfig = checkProxyPackage({
    version: "1.10.5",
    bounds: null,
    configError: "bad config",
    cooldownSeconds: 604800,
    floatSkips: true,
    resolved: null,
    sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
  });
  expect(badConfig.status).toBe("fail");
});

test("proxy package: a compiled install treats missing as pre-start, not broken", () => {
  // A compiled binary ships no deno.json baseline -- the float resolves the proxy
  // into its own cache at `agent start`. "Missing" is therefore the normal state
  // of a fresh or direct-only binary install and must not fail.
  const standalone = {
    kind: "provisioned",
    pin: "2.9.5",
    denoBin: "/deno",
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

  // Proxy wired but never started: still ok, pointing at `agent start`.
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

test("proxy package detail shows the float cooldown window", () => {
  const ok = (cooldownSeconds: number | null) =>
    checkProxyPackage({
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds,
      floatSkips: false,
      resolved: null,
      sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
    }).detail;
  expect(ok(604800)).toContain("cooldown 7d");
  expect(ok(0)).toContain("no cooldown");
  expect(ok(259200)).toContain("cooldown 3d");
  expect(ok(90)).toContain("cooldown 90s");
  expect(ok(null)).toContain("cooldown: unknown");
});

test("proxy package fails (not throws) when copilot-env.config is unreadable", () => {
  const r = checkProxyPackage({
    version: "1.10.5",
    bounds: null,
    configError: "bad config",
    cooldownSeconds: 604800,
    floatSkips: false,
    resolved: null,
    sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
  });
  expect(r.status).toBe("fail");
  expect(r.detail).toContain("copilot-env.config");
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

  // A compiled binary is not a deno CLI: with no sidecar it cannot spawn the proxy
  // at all, so this is a failure rather than a note.
  const compiled = checkProxySidecar(
    facts({ kind: "absent", pin: "2.9.5", denoBin: null, standalone: true }),
  );
  expect(compiled.status).toBe("fail");
  expect(compiled.fix).toBe("agent start");

  // From a checkout the runtime itself is the answer, so a missing sidecar is not fatal.
  expect(
    checkProxySidecar(facts({ kind: "absent", pin: "2.9.5", denoBin: null, standalone: false }))
      .status,
  ).toBe("warn");

  const dev = checkProxySidecar(
    facts({ kind: "dev", pin: "2.9.5", denoBin: "/usr/bin/deno", standalone: false }),
  );
  expect(dev.status).toBe("ok");
  expect(dev.detail).toContain("/usr/bin/deno");

  const provisioned = checkProxySidecar(
    facts({ kind: "provisioned", pin: "2.9.5", denoBin: "/home/x/deno", standalone: true }),
  );
  expect(provisioned.status).toBe("ok");
  expect(provisioned.detail).toContain("2.9.5");

  // Direct-only (the float skips): nothing spawns the proxy, so an absent
  // sidecar is idle capacity, not a failure -- even on a compiled build.
  const unused = checkProxySidecar({
    ...facts({ kind: "absent", pin: "2.9.5", denoBin: null, standalone: true }),
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
    sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
  });

  // Never floated: the deno.json baseline runs, which is a working fallback.
  const none = checkProxyResolved(facts(null));
  expect(none.status).toBe("ok");
  expect(none.detail).toContain("not floated");
  expect(none.fix).toBeUndefined();
  // Direct-only says so explicitly rather than implying a pending float.
  expect(checkProxyResolved(facts(null, true)).detail).toContain("both direct");

  // Recorded but the cache is gone: the launch asks for that exact version
  // offline, so this is a real failure rather than a fallback.
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

test("copilot-env version check is always ok and surfaces the version", () => {
  const r = checkCliVersion(BOOTSTRAP_OK);
  expect(r.status).toBe("ok");
  expect(r.detail).toBe("3.1.0");
});

// --- runtime checks (preserve original semantics) ---------------------------

test("gatherFacts probes the proxy at 127.0.0.1, never localhost (Windows IPv6 safety)", async () => {
  // The daemon binds IPv4; on Windows `localhost` resolves to ::1 first with no fallback, so the
  // reachability probe MUST hit 127.0.0.1 or health falsely reports the proxy down. Capture the URL.
  let probed = "";
  await gatherFacts(
    "runtime",
    {},
    {
      resolvePort: () => "4141",
      readState: () => ({ pid: undefined, port: 4141 }),
      reach: async (url: string) => {
        probed = url;
        return true;
      },
    },
  );
  expect(probed).toBe("http://127.0.0.1:4141/");
});

test("runtime port fails only when unreachable", () => {
  expect(runPort(defaultTarget()).status).toBe("ok");
  expect(runPort(defaultTarget({ reachable: false })).status).toBe("fail");
});

test("runtime: a down proxy is OK when both Codex and Claude are direct", () => {
  const down = defaultTarget({ reachable: false, trackedPid: null, pidTracked: false });
  // Proxy not required => no failure (warnings/ok only), so the overall exit is 0.
  expect(runPort(down).status).toBe("fail");
  expect(runPid(down).status).toBe("fail");
  const bothDirect = defaultTarget({
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    proxyExpected: false,
  });
  expect(runPort(bothDirect).status).toBe("ok");
  expect(runPort(bothDirect).detail).toContain("both direct");
  expect(runPid(bothDirect).status).toBe("ok");
  expect(exitCodeFor(evaluateAll("runtime", { runtimes: [down] }))).toBe(1);
  expect(exitCodeFor(evaluateAll("runtime", { runtimes: [bothDirect] }))).toBe(0);
});

test("runtime: a foreign listener on the port is not a problem when both agents are direct", () => {
  // The driving bug: default setup Direct for both agents + an unrelated service on the
  // default port. Nothing routes to that port, so health must not warn about it.
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
  // The pid check carries the same machine-readable stamp for --json consumers.
  const pid = runPid(listener);
  expect(pid.status).toBe("ok");
  expect((pid.value as Record<string, unknown>).bothDirect).toBe(true);
  // Even a tracked-and-alive pid never lets ownership wording claim the port for a
  // both-direct target: identity was never probed, so who owns the port is unknown.
  const trackedListener = defaultTarget({ proxyExpected: false, identityConfirmed: null });
  expect(runOrphan(trackedListener).detail).toContain("both agents are direct");
  // The whole run: nothing warns or fails, so the summary is clean and exit 0.
  const results = evaluateAll("full", { runtimes: [listener] });
  expect(worstStatus(results)).toBe("ok");
  expect(exitCodeFor(results)).toBe(0);
});

test("runtime: a down daemon reads ok (starts on demand) when auto-start is on", () => {
  // Deliberate severity change: with the managed lifecycle enabled the resolver
  // launches the daemon on demand, so "down between sessions" is the normal state.
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
  expect(port.detail).toContain("starts on demand (auto-start on)");
  expect(port.fix).toBeUndefined();
  expect((port.value as Record<string, unknown>).autoStart).toBe(true);
  const pid = runPid(down);
  expect(pid.status).toBe("ok");
  expect(pid.detail).toContain("starts on demand (auto-start on)");
  expect(pid.fix).toBeUndefined();
  expect((pid.value as Record<string, unknown>).autoStart).toBe(true);
  // The exit-code consumer: a down daemon must no longer fail the run.
  expect(exitCodeFor(evaluateAll("runtime", { runtimes: [down] }))).toBe(0);
  expect(exitCodeFor(evaluateAll("full", { runtimes: [down] }))).toBe(0);

  // Reachable-but-untracked is NOT "down": auto-start never excuses an orphan/foreign
  // occupant (the resolver would not relaunch over a busy port).
  const occupied = defaultTarget({
    trackedPid: null,
    pidTracked: false,
    watchdog: { ...defaultTarget().watchdog, autoStart: true },
  });
  expect(runPid(occupied).status).toBe("fail");
});

test("runtime: a down daemon still fails with the agent start fix when auto-start is off", () => {
  const down = defaultTarget({
    reachable: false,
    trackedPid: null,
    pidTracked: false,
    identityConfirmed: null,
  }); // the fixture's watchdog has autoStart false
  const port = runPort(down);
  expect(port.status).toBe("fail");
  expect(port.fix).toBe("agent start");
  const pid = runPid(down);
  expect(pid.status).toBe("fail");
  expect(pid.fix).toBe("agent start");
  expect(exitCodeFor(evaluateAll("runtime", { runtimes: [down] }))).toBe(1);
});

test("runtime identity: the misroute warning remains when the proxy IS expected", () => {
  // proxyExpected + reachable + no x-trace-id: agent requests genuinely route to the
  // foreign occupant, so this warning is real and must survive the both-direct fix.
  const foreign = runIdentity(defaultTarget({ identityConfirmed: false }));
  expect(foreign.status).toBe("warn");
  expect(foreign.detail).toContain("misroute");
  expect(foreign.fix).toContain("free the port");
});

test("runtime pid: stale/foreign and untracked fail, tracked ok", () => {
  expect(runPid(defaultTarget()).status).toBe("ok");
  // reachable but not our pid (foreign squatter / stale): pid check fails, port ok
  const foreign = defaultTarget({ pidTracked: false });
  expect(runPid(foreign).status).toBe("fail");
  expect(runPort(foreign).status).toBe("ok");
  const untracked = defaultTarget({ trackedPid: null, pidTracked: false, pidAlive: false });
  expect(runPid(untracked).status).toBe("fail");
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
  // auto-start off -> reports off, never auto-stops.
  const off = checkRuntimeWatchdog(defaultTarget()); // the fixture has watchdog.autoStart=false
  expect(off.status).toBe("ok");
  expect(off.detail).toContain("off");
  expect(off.value).toEqual({ autoStart: false });

  // auto-start on but idle-timeout 0 -> auto-stop disabled.
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

  // Idle past the window clamps remaining to 0; the persisted request mark counts as the
  // latest activity.
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

  // No activity recorded yet -> idle AND remaining are unknown (the daemon's real baseline
  // includes a startedAtMs the probe can't see, so we don't fake a precise full window).
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
  // A daemon nothing routes to may still carry marks from an earlier run; reporting
  // its idle countdown (or "auto-stops in 0s" from an expired mark) is noise.
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

  // The gate precedes the auto-start and idle-timeout branches: neither of those
  // states may reintroduce watchdog narration when nothing routes to the daemon.
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

test("runtime watchdog is scoped to full + proxy, not the launchers' fast runtime probe", () => {
  expect(checkRuntimeWatchdog(defaultTarget()).scopes).toEqual(["full", "proxy"]);
});

test("runtime identity: confirmed ok, foreign warns, down/not-probed stays ok", () => {
  // x-trace-id present -> confirmed copilot-api.
  const ok = runIdentity(defaultTarget()); // identityConfirmed: true
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("confirmed copilot-api");

  // Reachable but no x-trace-id -> a foreign service squats the port.
  const foreign = runIdentity(defaultTarget({ identityConfirmed: false }));
  expect(foreign.status).toBe("warn");
  expect(foreign.detail).toContain("non-copilot-api");
  expect(foreign.fix).toContain("free the port");

  // Not reachable / not probed -> ok (runtime.port owns the down verdict).
  expect(
    runIdentity(defaultTarget({ reachable: false, identityConfirmed: null })).status,
  ).toBe("ok");
  expect(runIdentity(defaultTarget({ identityConfirmed: null })).status).toBe("ok");
  expect(runIdentity(defaultTarget()).scopes).toEqual(["full", "proxy"]);
});

test("runtime orphan: untracked-but-ours warns, foreign defers to identity, tracked ok", () => {
  // Reachable copilot-api (or unknown) but no tracked pid, proxy required -> orphan warn.
  const orphan = runOrphan(
    defaultTarget({ pidTracked: false, trackedPid: null, identityConfirmed: true }),
  );
  expect(orphan.status).toBe("warn");
  expect(orphan.detail).toContain("orphaned");
  expect(orphan.fix).toContain("agent stop");

  // A foreign listener is runtime.identity's verdict -> orphan must NOT also warn.
  expect(
    runOrphan(defaultTarget({ pidTracked: false, identityConfirmed: false })).status,
  ).toBe("ok");

  // Foreign responder while our tracked pid is alive: orphan stays ok but must NOT claim the
  // tracked daemon owns the port (that wording belongs to runtime.identity).
  const foreignTracked = runOrphan(defaultTarget({ identityConfirmed: false }));
  expect(foreignTracked.status).toBe("ok");
  expect(foreignTracked.detail).not.toContain("tracked daemon");
  expect(foreignTracked.detail).toContain("not copilot-api");

  // Tracked daemon -> ok.
  expect(runOrphan(defaultTarget()).status).toBe("ok");

  // Both agents direct -> no proxy required -> a missing tracked pid is not an orphan.
  expect(
    runOrphan(defaultTarget({ pidTracked: false, proxyExpected: false })).status,
  ).toBe("ok");
});

test("runtime checks stamp the target's profile; environment checks stay null", () => {
  // The default target's checks carry profile null (today's only shape); a named
  // target's checks carry its name -- the plumbing the profile tier builds on.
  expect(runPort(defaultTarget()).profile).toBeNull();
  expect(checkRuntimeWatchdog(defaultTarget()).profile).toBeNull();
  const named = profileTarget("work", { reachable: false });
  expect(runPort(named).profile).toBe(parseProfileName("work"));
  expect(runOrphan(named).profile).toBe(parseProfileName("work"));
  expect(checkDeno(BOOTSTRAP_OK).profile).toBeNull();
  expect(checkCliVersion(BOOTSTRAP_OK).profile).toBeNull();
});

test("the identity probe (an extra request) is skipped in the launchers' fast runtime scope", async () => {
  // runtime scope must stay minimal: reach is probed, but proxyIdentity is NOT called.
  let identityCalls = 0;
  const facts = await gatherFacts(
    "runtime",
    {},
    {
      resolvePort: () => "4141",
      readState: () => ({ pid: undefined, port: 4141 }),
      reach: async () => true,
      proxyIdentity: async () => {
        identityCalls++;
        return true;
      },
    },
  );
  expect(identityCalls).toBe(0);
  expect(probeOf(facts.runtimes?.[0]).identityConfirmed).toBeNull();
});

test("gatherFacts never probes identity for a both-direct default target (proxyExpected gate)", async () => {
  // Both agents wired Direct + something listening on the default port: nothing routes
  // there, so the identity probe must not even fire -- which makes the misroute warning
  // structurally unreachable for this state, not merely suppressed.
  const root = mkdtempSync(join(tmpdir(), "copilot-health-bothdirect-"));
  const restoreEnv = envSnapshot();
  process.env.COPILOT_API_HOME = join(root, "api-home"); // isolated: no profile homes
  try {
    const codexHome = join(root, "codex-home");
    writeCodexConfigToml(codexHome, { baseUrl: "https://api.githubcopilot.com" });
    const claudeHome = join(root, "claude-home");
    writeClaudeSettings(claudeHome, {
      apiKeyHelper: directHelperCommand(),
      baseUrl: "https://api.githubcopilot.com",
    });
    let identityCalls = 0;
    const facts = await gatherFacts(
      "proxy", // an identity-probing scope (unlike the fast `runtime` one)
      {},
      {
        resolvePort: () => "4141",
        readState: () => ({ port: 4141 }),
        reach: async () => true, // the foreign listener answers
        proxyIdentity: async () => {
          identityCalls++;
          return false;
        },
        codexHome: () => codexHome,
        claudeHome: () => claudeHome,
      },
    );
    const target = facts.runtimes?.[0];
    if (!target) throw new Error("expected the default runtime target");
    expect(identityCalls).toBe(0);
    expect(target.proxyExpected).toBe(false);
    expect(probeOf(target).identityConfirmed).toBeNull();
    // End to end: the gathered facts evaluate warning-free.
    const runtime = evaluateAll("proxy", { runtimes: facts.runtimes });
    expect(worstStatus(runtime)).toBe("ok");
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mixed default Claude config (direct helper, proxy base URL) expects the proxy", async () => {
  // Claude's MODE keys off apiKeyHelper alone, so this config reads
  // codex=direct claude=direct -- yet Claude's ANTHROPIC_BASE_URL sends its
  // traffic to the local daemon. Health once trusted the modes and reported
  // "not required (both direct)" with the daemon down and Claude broken; the
  // base-URL fact must bring back the full runtime treatment: proxyExpected
  // true, the daemon-down FAIL (with the start fix), and the identity probe.
  const root = mkdtempSync(join(tmpdir(), "copilot-health-mixed-"));
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
      resolvePort: () => "4141",
      readState: () => ({}),
      codexHome: () => codexHome,
      claudeHome: () => claudeHome,
    };

    // Daemon down (auto-start defaults off): the port row must FAIL with the start fix.
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
    const up = await gatherFacts(
      "proxy",
      {},
      {
        ...deps,
        reach: async () => true,
        proxyIdentity: async () => {
          identityCalls++;
          return true;
        },
      },
    );
    expect(identityCalls).toBe(1);
    expect(probeOf(up.runtimes?.[0]).identityConfirmed).toBe(true);
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the claude scope classifies a legacy helper through deps.readFileSafe (the injected reader)", async () => {
  // The wiring classifier verifies a legacy helper PATH by reading the file's body;
  // the probe must feed it deps.readFileSafe, so a fake fs here fully decides the
  // verdict (nothing on the real disk). Body present and exact => direct, and the
  // stored-token credential needs no gh; body missing => other (a helper that cannot
  // produce a credential is not ours), never the token-backed direct report.
  const claudeHome = "/hc";
  const legacyPath = directHelperPath(claudeHome);
  const settingsText = JSON.stringify({
    apiKeyHelper: legacyPath,
    env: { ANTHROPIC_BASE_URL: "https://api.githubcopilot.com" },
  });
  const files = new Map<string, string>([
    [settingsPathFor(claudeHome), settingsText],
    [legacyPath, legacyDirectHelperScript()],
  ]);
  const deps = {
    claudeHome: () => claudeHome,
    readFileSafe: (path: string) => files.get(path) ?? null,
    readFileResult: (path: string): TextReadResult => {
      const text = files.get(path);
      return text === undefined ? { kind: "absent" } : { kind: "text", text };
    },
    resolvePort: () => "4141",
    authProvider: () => "gh-token" as const,
    storedTokenPresent: () => true,
    codexDirectAuth: () => Promise.resolve({ command: null, authenticated: false }),
  };

  const legacy = await gatherFacts("claude", {}, deps);
  expect(legacy.claude?.providerMode).toBe("direct");
  expect(legacy.claude?.directUsesToken).toBe(true);

  files.delete(legacyPath);
  const orphaned = await gatherFacts("claude", {}, deps);
  expect(orphaned.claude?.providerMode).toBe("other");
  expect(orphaned.claude?.otherReason).toBe("legacy-unrecognized");
  expect(orphaned.claude?.directUsesToken).toBe(false);
  // The final verdict, not just the classification: our helper filename with a
  // body we cannot verify is warned about, not passed off as healthy custom wiring.
  if (!orphaned.claude) throw new Error("expected claude facts");
  const verdict = checkClaude(orphaned.claude);
  expect(verdict.status).toBe("warn");
  expect(verdict.fix).toBe("agent claude --direct");
});

test("an unreadable settings file reaches health as other/read-error, never as none", async () => {
  // The settings file is read three-way (deps.readFileResult); an unreadable
  // file must not collapse into the absent/none verdict readFileSafe's null
  // would produce -- and the warn keys off the classifier's reason.
  const claudeHome = "/hc";
  const deps = {
    claudeHome: () => claudeHome,
    readFileSafe: () => null,
    readFileResult: (): TextReadResult => ({ kind: "unreadable", error: "EACCES" }),
    resolvePort: () => "4141",
    authProvider: () => null,
    storedTokenPresent: () => false,
    codexDirectAuth: () => Promise.resolve({ command: null, authenticated: false }),
  };
  const facts = await gatherFacts("claude", {}, deps);
  expect(facts.claude?.providerMode).toBe("other");
  expect(facts.claude?.otherReason).toBe("read-error");
  if (!facts.claude) throw new Error("expected claude facts");
  const verdict = checkClaude(facts.claude);
  expect(verdict.status).toBe("warn");
  expect(verdict.detail).toContain("could not be read");
});

test("an unreadable codex config reaches health as other/read-error, never as none", async () => {
  // The codex config.toml is ALSO read three-way (deps.readFileResult): before
  // that, its readFileSafe null collapsed an unreadable config into the
  // absent/"not wired" OK verdict.
  const deps = {
    codexHome: () => "/hx",
    readFileSafe: () => null,
    readFileResult: (): TextReadResult => ({ kind: "unreadable", error: "EACCES" }),
    resolvePort: () => "4141",
    codexTokenInEnviron: () => false,
    authProvider: () => null,
    storedTokenPresent: () => false,
    codexDirectAuth: () => Promise.resolve({ command: null, authenticated: false }),
  };
  const facts = await gatherFacts("codex", {}, deps);
  expect(facts.codex?.providerMode).toBe("other");
  expect(facts.codex?.otherReason).toBe("read-error");
  expect(facts.codex?.configExists).toBe(true);
  if (!facts.codex) throw new Error("expected codex facts");
  const verdict = checkCodex(facts.codex);
  expect(verdict.status).toBe("warn");
  expect(verdict.detail).toContain("could not be read");
  expect(verdict.fix).toContain("repair");
});

test("gatherFacts still probes identity when an agent routes through the proxy", async () => {
  // Codex wired to the local proxy: requests genuinely route to the port, so the
  // identity probe fires and a foreign responder still earns the misroute warning.
  const root = mkdtempSync(join(tmpdir(), "copilot-health-proxywired-"));
  const restoreEnv = envSnapshot();
  process.env.COPILOT_API_HOME = join(root, "api-home");
  try {
    const codexHome = join(root, "codex-home");
    writeCodexConfigToml(codexHome, {
      baseUrl: "http://127.0.0.1:4141/v1",
      envKey: "OPENAI_API_KEY",
    });
    let identityCalls = 0;
    const facts = await gatherFacts(
      "proxy",
      {},
      {
        resolvePort: () => "4141",
        readState: () => ({ port: 4141 }),
        reach: async () => true,
        proxyIdentity: async () => {
          identityCalls++;
          return false; // no x-trace-id: a foreign service
        },
        codexHome: () => codexHome,
        claudeHome: () => join(root, "claude-home"), // unconfigured => not both-direct
      },
    );
    const target = facts.runtimes?.[0];
    if (!target) throw new Error("expected the default runtime target");
    expect(identityCalls).toBe(1);
    expect(target.proxyExpected).toBe(true);
    expect(probeOf(target).identityConfirmed).toBe(false);
    const identity = runIdentity(target);
    expect(identity.status).toBe("warn");
    expect(identity.detail).toContain("misroute");
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("health's own proxy probes do not move the watchdog activity signal", async () => {
  // lastRequestMs reads the observer's persisted `.activity.json` mark, which health's
  // reach/identity GET / requests never move (only inference POSTs mark it). So even though
  // the proxy IS probed, the 'last request' / idle signal is the persisted value, untouched --
  // observing the proxy can't reset the numbers.
  let probes = 0;
  const facts = await gatherFacts(
    "proxy",
    {},
    {
      resolvePort: () => "4141",
      readState: () => ({ pid: 123, port: 4141, lastEnsureAt: 1000 }),
      reach: async () => {
        probes++;
        return true;
      },
      proxyIdentity: async () => {
        probes++;
        return true;
      },
      lastRequestMs: () => 100, // a fixed, old "last real request" (the persisted mark)
      now: () => 5000,
      autoStartEnabled: () => true,
      idleTimeoutMs: () => 60_000,
    },
  );
  expect(probes).toBeGreaterThan(0); // the proxy WAS probed (reach + identity)
  expect(facts.runtimes?.[0]?.watchdog.lastRequestMs).toBe(100); // ...yet the signal is unchanged
  expect(facts.runtimes?.[0]?.watchdog.now).toBe(5000);
});

test("gatherFacts derives proxy.floatSkips from the float's own predicate", async () => {
  // The package-bounds exemption must key off proxyUnusedEverywhere (the float's
  // skip predicate: modes AND the managed direct base URL AND no profile homes),
  // never a looser both-direct read -- health and the float must agree. The
  // predicate's own edge cases (profile homes, proxy wiring) live in
  // agents_wiring.test.ts; this pins the fact-gathering seam.
  const root = mkdtempSync(join(tmpdir(), "copilot-health-float-"));
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
      resolvePort: () => "4141",
      readState: () => ({}),
      reach: async () => false,
      codexHome: () => codexHome,
      claudeHome: () => claudeHome,
    };
    const direct = await gatherFacts("proxy", {}, overrides);
    expect(direct.proxy?.floatSkips).toBe(true);

    // A mixed Claude config (direct helper, proxy base URL) floats again, so
    // the bounds are enforced again.
    writeClaudeSettings(claudeHome, { apiKeyHelper, baseUrl: "http://127.0.0.1:4141" });
    const mixed = await gatherFacts("proxy", {}, overrides);
    expect(mixed.proxy?.floatSkips).toBe(false);
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a target's pid and port pair from ONE state snapshot (fallback never re-reads)", async () => {
  // proxyStatus's rule, kept by health: with no recorded port, the fallback is
  // fallbackPort (state-independent for the addressed profile), never a second
  // read() that could pair the snapshot's pid with a newer port.
  let stateReads = 0;
  const facts = await gatherFacts(
    "runtime",
    {},
    {
      resolvePort: () => "4141", // the wiring expectation, not the target snapshot
      readState: () => {
        stateReads++;
        return {}; // no recorded port -> the fallback path
      },
      fallbackPort: () => 4444,
      reach: async () => false,
    },
  );
  expect(stateReads).toBe(1);
  expect(facts.runtimes?.[0]?.port).toBe(4444);
});

test("gatherFacts is read-only: no files appear in a fresh isolated home", async () => {
  // Health observes, never writes: it must not create the copilot-api home, a
  // run dir, or a port reservation (reserveProfilePort is a write-path API).
  const root = mkdtempSync(join(tmpdir(), "copilot-health-readonly-"));
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
    // Exactly one runtime target this commit: the default (profile null) --
    // slot/homeExists no longer exist on the default variant (type-level).
    expect(facts.runtimes?.map((t) => t.profile)).toEqual([null]);
    // The zero-writes invariant: the home was never created and nothing else
    // landed under the isolated root.
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted default-home migration warns, naming the staging dir and the migrate re-run", async () => {
  // The 3.5.6 fix-up stages the flat root's daemon files into
  // profiles/.default.migrating and flips with ONE atomic rename; a kill inside
  // that window leaves the staging dir behind. Home resolution still answers the
  // flat root (the system keeps working), so the verdict is warn -- an unfinished
  // migration, never a breakage -- and the fix is the exact re-run that completes
  // the move.
  const root = mkdtempSync(join(tmpdir(), "copilot-health-staging-"));
  const restoreEnv = envSnapshot();
  const home = join(root, "api-home");
  process.env.COPILOT_API_HOME = home;
  try {
    const overrides = {
      resolvePort: () => "4141",
      readState: () => ({}),
      reach: async () => false, // offline-deterministic; irrelevant to this row
      codexHome: () => join(root, "codex-home"),
      claudeHome: () => join(root, "claude-home"),
    };
    // The negative: a root with no staging dir reads ok (no fix, per the union).
    const clean = await gatherFacts("proxy", {}, overrides);
    if (!clean.defaultHomeMigration) throw new Error("expected default-home migration facts");
    expect(clean.defaultHomeMigration.staged).toBe(false);
    const cleanRow = checkDefaultHomeMigration(clean.defaultHomeMigration);
    expect(cleanRow.status).toBe("ok");
    expect(cleanRow.fix).toBeUndefined();

    // The interrupted move: exactly the staging dir on disk.
    const staging = join(home, PROFILES_DIR_NAME, DEFAULT_HOME_STAGING_DIR);
    mkdirSync(staging, { recursive: true });
    const facts = await gatherFacts("proxy", {}, overrides);
    const row = evaluateAll("proxy", facts).find((r) => r.id === "runtime.defaultHomeMigration");
    if (!row) throw new Error("expected the default-home migration check in the proxy scope");
    expect(row.status).toBe("warn");
    expect(row.detail).toContain(staging);
    // The fix line is an external contract: the exact command that re-runs the
    // 3.5.6 fix-ups and completes the move.
    expect(row.fix).toBe("agent migrate 3.5.6 3.5.7");

    // The launchers' fast `runtime` probe never gathers the fact at all, so its
    // contracted row set cannot grow a migration row.
    const fast = await gatherFacts("runtime", {}, overrides);
    expect(fast.defaultHomeMigration).toBeUndefined();
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- bootstrap checks -------------------------------------------------------

test("deno unavailable fails; node_modules absent fails, stale warns, fresh ok", () => {
  expect(checkDeno(BOOTSTRAP_OK).status).toBe("ok");
  expect(checkDeno({ ...BOOTSTRAP_OK, deno: { available: false, version: null } }).status).toBe(
    "fail",
  );
  expect(checkNodeModules(BOOTSTRAP_OK).status).toBe("ok");
  expect(
    checkNodeModules({ ...BOOTSTRAP_OK, nodeModules: { present: false, fresh: false } }).status,
  ).toBe("fail");
  expect(
    checkNodeModules({ ...BOOTSTRAP_OK, nodeModules: { present: true, fresh: false } }).status,
  ).toBe("warn");
  // A compiled binary embeds its dependencies (nodeModules fact is null): the
  // check must read ok and say so, never fail on the node_modules it cannot have.
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
  // An UNPROVEN target census (discovery never ran) keeps the warn + fix but
  // never the confident "not wired" claim.
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

  expect(checkTool("node", { path: "/usr/bin/node" }).status).toBe("ok");
  expect(checkTool("npm", { path: null }).status).toBe("warn");
  expect(checkTool("npm", { path: null }).detail).toBe("not installed (optional)");
  const toolUnproven = checkTool("npm", { path: null, launchFailed: true });
  expect(toolUnproven.status).toBe("warn");
  expect(toolUnproven.detail).toBe("could not check (the command probe failed to run)");
  expect(toolUnproven.value).toEqual({ resolved: null, lookFailed: true });
});

test("codex: not configured is ok; each broken part warns with a precise message", () => {
  // Shared non-wiring facts; `satisfies` keeps the literal arms narrow so the
  // spreads below stay inside the discriminated union's proxy/direct variants.
  const codexExtras = {
    home: "/c",
    directAuth: { command: "/bin/gh", authenticated: true },
    directUsesToken: false,
    directNeedsNoGh: false,
    provider: "gh-cli",
    otherReason: null,
  } as const;
  const wired = {
    ...codexExtras,
    configExists: true,
    providerSelected: true,
    providerMode: "proxy",
    modelProvider: "copilot-env",
    baseUrl: "http://localhost:4141/v1",
    baseUrlMatches: true,
    envKeyMatches: true,
    providerWired: true,
    envFilePresent: true,
    envKeyInDotenv: true,
    envKeyInEnviron: false,
    tokenAvailable: true,
  } satisfies CodexFacts;
  // No config at all -> ok (user never wired Codex): the "none" arm.
  expect(
    checkCodex({
      ...wired,
      providerMode: "none",
      configExists: false,
      modelProvider: null,
      providerSelected: false,
      baseUrl: null,
      baseUrlMatches: false,
      envKeyMatches: false,
      providerWired: false,
    }).status,
  ).toBe("ok");
  // Fully wired -> ok, multi-line detail: wiring, proxy, then the auth.command resolver.
  const ok = checkCodex(wired);
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("copilot-env");
  expect(ok.detail).toContain("4141");
  expect(ok.detail).toContain("provider: proxy");
  expect(ok.detail.split("\n")).toHaveLength(4);
  expect(ok.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  expect(ok.detail).toContain("proxy-token resolver");
  // A foreign model_provider selected: the "other" arm.
  const foreign = {
    ...wired,
    providerMode: "other",
    modelProvider: "openai",
    providerSelected: false,
    baseUrl: null,
    baseUrlMatches: false,
    envKeyMatches: false,
    providerWired: false,
    otherReason: "custom",
  } satisfies CodexFacts;
  expect(checkCodex(foreign).detail).toContain("model_provider");
  expect(checkCodex(foreign).detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  // The classifier's reason travels into the --json value on every arm.
  expect(checkCodex(foreign).value?.otherReason).toBe("custom");
  expect(ok.value?.otherReason).toBe(null);
  // A config.toml the writers REFUSE (malformed/read-error) gets the repair fix,
  // never the generic `agent codex --proxy` re-wire that cannot land.
  const malformed = checkCodex({ ...foreign, modelProvider: null, otherReason: "malformed" });
  expect(malformed.status).toBe("warn");
  expect(malformed.detail).toContain("not valid TOML");
  expect(malformed.detail).toContain("provider: other");
  expect(malformed.fix).toBe(`repair ${join("/c", "config.toml")}, then re-run \`agent codex\``);
  expect(malformed.value?.otherReason).toBe("malformed");
  const unreadable = checkCodex({ ...foreign, modelProvider: null, otherReason: "read-error" });
  expect(unreadable.status).toBe("warn");
  expect(unreadable.detail).toContain("could not be read");
  expect(unreadable.fix).toBe(`repair ${join("/c", "config.toml")}, then re-run \`agent codex\``);
  // A named profile's repair re-runs its atomic re-add instead of `agent codex`.
  const namedMalformed = checkCodex(
    { ...foreign, modelProvider: null, otherReason: "malformed" },
    parseProfileName("work"),
  );
  expect(namedMalformed.status).toBe("warn");
  expect(namedMalformed.fix).toBe(
    `repair ${join("/c", "config.toml")}, then re-run \`agent profile --add work\``,
  );
  // base_url points at the wrong port.
  expect(
    checkCodex({
      ...wired,
      baseUrl: "http://localhost:9999/v1",
      baseUrlMatches: false,
      providerWired: false,
    }).detail,
  ).toContain("base_url");
  expect(
    checkCodex({
      ...wired,
      baseUrl: "http://localhost:9999/v1",
      baseUrlMatches: false,
      providerWired: false,
    }).detail,
  ).toContain(`config.toml: ${join("/c", "config.toml")}`);
  // Not fully wired (e.g. the managed proxy auth.command is missing/foreign).
  const notWired = checkCodex({ ...wired, providerWired: false });
  expect(notWired.status).toBe("warn");
  expect(notWired.detail).toContain("not fully wired");
  expect(notWired.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  // A wired proxy is ok regardless of any env token (the key comes from auth.command).
  const noEnvToken = checkCodex({ ...wired, envKeyInDotenv: false, tokenAvailable: false });
  expect(noEnvToken.status).toBe("ok");
  expect(noEnvToken.detail).toContain("proxy-token resolver");

  const direct = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
  });
  expect(direct.status).toBe("ok");
  expect(direct.detail).toContain("provider: direct");
  expect(direct.detail).toContain("gh auth: authenticated via /bin/gh");
  expect(direct.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);

  const directMissingGh = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    directAuth: { command: null, authenticated: false },
  });
  expect(directMissingGh.status).toBe("warn");
  expect(directMissingGh.detail).toContain("GitHub CLI not found");
  expect(directMissingGh.fix).toBe("install gh and run gh auth login");

  const directUnauthed = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    directAuth: { command: "/bin/gh", authenticated: false },
  });
  expect(directUnauthed.status).toBe("warn");
  expect(directUnauthed.detail).toContain("not authenticated");
  expect(directUnauthed.fix).toBe("gh auth login");

  // Non-gh-cli provider (or none) with no stored token: gh is NOT a fallback, so
  // a managed Direct config that doesn't resolve warns and points at `agent auth`
  // (NOT the gh-specific message). Guards against the provider-blind false-OK.
  const directNoCred = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    tokenAvailable: false,
    provider: "copilot",
    directUsesToken: false,
    directAuth: { command: "/bin/gh", authenticated: true },
  });
  expect(directNoCred.status).toBe("warn");
  expect(directNoCred.detail).toContain("no credential resolves");
  expect(directNoCred.detail).not.toContain("gh auth:");
  expect(directNoCred.fix).toBe("agent auth");
});

test("checkCodex/checkClaude direct: an UNPROVEN gh probe says could-not-check, never a confident verdict", () => {
  const codexDirect = {
    home: "/c",
    configExists: true,
    providerSelected: true,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: true,
    envKeyMatches: false,
    providerWired: true,
    envFilePresent: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    otherReason: null,
    directUsesToken: false,
    directNeedsNoGh: false,
    provider: "gh-cli",
    directAuth: { command: "/bin/gh", authenticated: false, unproven: true },
  } satisfies CodexFacts;
  // `gh auth token` spawned but never completed (error / timeout kill).
  const codexUnproven = checkCodex(codexDirect);
  expect(codexUnproven.status).toBe("warn");
  expect(codexUnproven.detail).toContain(
    "gh auth: could not check gh authentication (`gh auth token` did not run to completion)",
  );
  expect(codexUnproven.detail).not.toContain("is not authenticated");
  expect(codexUnproven.fix).toBe("re-run `agent health` (the gh check did not run to completion)");
  // The gh LOOKUP itself failed to run: not a proven "GitHub CLI not found".
  const lookupUnproven = checkCodex({
    ...codexDirect,
    directAuth: { command: null, authenticated: false, unproven: true },
  });
  expect(lookupUnproven.status).toBe("warn");
  expect(lookupUnproven.detail).toContain(
    "gh auth: could not check for the GitHub CLI (the command probe failed to run)",
  );
  expect(lookupUnproven.detail).not.toContain("not found");
  expect(lookupUnproven.fix).toBe(
    "re-run `agent health` (the gh check did not run to completion)",
  );
  // Same shared verdict on the Claude side.
  const claudeUnproven = checkClaude({
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings.json"),
    settingsExists: true,
    wired: true,
    helperPath: join("/h/.claude", "copilot-token.sh"),
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: false,
    providerMode: "direct",
    otherReason: null,
    directAuth: { command: "/bin/gh", authenticated: false, unproven: true },
    directUsesToken: false,
    provider: "gh-cli",
  });
  expect(claudeUnproven.status).toBe("warn");
  expect(claudeUnproven.detail).toContain(
    "gh auth: could not check gh authentication (`gh auth token` did not run to completion)",
  );
  expect(claudeUnproven.detail).not.toContain("is not authenticated");
  expect(claudeUnproven.fix).toBe("re-run `agent health` (the gh check did not run to completion)");
});

test("directAuthFromSpawn: completed exits prove the verdict; error/kill stays unproven", () => {
  expect(directAuthFromSpawn("/bin/gh", { status: 0 })).toEqual({
    command: "/bin/gh",
    authenticated: true,
  });
  expect(directAuthFromSpawn("/bin/gh", { status: 1 })).toEqual({
    command: "/bin/gh",
    authenticated: false,
  });
  // The timeout kill closes with a null code: gh was never actually asked.
  expect(directAuthFromSpawn("/bin/gh", { status: null })).toEqual({
    command: "/bin/gh",
    authenticated: false,
    unproven: true,
  });
  expect(directAuthFromSpawn("/bin/gh", { status: 1, error: new Error("spawn EAGAIN") })).toEqual({
    command: "/bin/gh",
    authenticated: false,
    unproven: true,
  });
});

test("checkClaude: direct needs gh + managed base URL; proxy/none/other informational", () => {
  // `satisfies` keeps the literal arm narrow so spreads stay in the union.
  const direct = {
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings.json"),
    settingsExists: true,
    wired: true,
    helperPath: join("/h/.claude", "copilot-token.sh"),
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: false,
    providerMode: "direct",
    otherReason: null,
    directAuth: { command: "/bin/gh", authenticated: true },
    directUsesToken: false,
    provider: "gh-cli",
  } satisfies ClaudeFacts;
  const directOk = checkClaude(direct);
  expect(directOk.status).toBe("ok");
  expect(directOk.detail).toContain("provider: direct");
  expect(directOk.detail).toContain("ANTHROPIC_BASE_URL → https://api.githubcopilot.com");
  expect(directOk.detail).toContain("authenticated via /bin/gh");

  const missingGh = checkClaude({ ...direct, directAuth: { command: null, authenticated: false } });
  expect(missingGh.status).toBe("warn");
  expect(missingGh.detail).toContain("GitHub CLI not found");
  expect(missingGh.fix).toBe("install gh and run gh auth login");

  const unauthed = checkClaude({
    ...direct,
    directAuth: { command: "/bin/gh", authenticated: false },
  });
  expect(unauthed.status).toBe("warn");
  expect(unauthed.detail).toContain("not authenticated");
  expect(unauthed.fix).toBe("gh auth login");

  // Non-gh-cli provider with no stored token: gh is NOT a fallback -- warn pointing
  // at `agent auth`, not the gh-specific message.
  const noCred = checkClaude({ ...direct, provider: "copilot", directUsesToken: false });
  expect(noCred.status).toBe("warn");
  expect(noCred.detail).toContain("no credential resolves");
  expect(noCred.detail).not.toContain("gh auth:");
  expect(noCred.fix).toBe("agent auth");

  // Direct helper present but the managed base URL was dropped/altered: warn.
  const staleBase = checkClaude({ ...direct, baseUrl: null });
  expect(staleBase.status).toBe("warn");
  expect(staleBase.detail).toContain("(missing)");
  expect(staleBase.fix).toBe("agent claude --direct");

  // Proxy: proxy-backed via settings.json (localhost base URL matching the resolved port).
  const proxy = checkClaude({
    ...direct,
    helperPath: join("/h/.claude", "copilot-proxy-token.sh"),
    baseUrl: "http://localhost:4141",
    baseUrlMatches: true,
    providerMode: "proxy",
    directAuth: { command: null, authenticated: false },
  });
  expect(proxy.status).toBe("ok");
  expect(proxy.detail).toContain("provider: proxy");
  expect(proxy.detail).toContain("ANTHROPIC_BASE_URL → http://localhost:4141");
  expect(proxy.detail).toContain("apiKeyHelper → ");

  // Proxy but the base URL points at the WRONG port (stale after `config port` changed):
  // must warn, not read green, with a repoint fix.
  const proxyStale = checkClaude({
    ...direct,
    helperPath: join("/h/.claude", "copilot-proxy-token.sh"),
    baseUrl: "http://localhost:4141",
    baseUrlMatches: false,
    providerMode: "proxy",
    directAuth: { command: null, authenticated: false },
  });
  expect(proxyStale.status).toBe("warn");
  expect(proxyStale.detail).toContain("does not match the resolved proxy port");
  // The fix names the deterministic proxy rewire (the bare commands auto-detect
  // a mode, which is not guaranteed to re-bake the proxy wiring).
  expect(proxyStale.fix).toContain("agent claude --proxy");

  // Never configured: informational; cl defaults it to the proxy.
  const none = checkClaude({
    ...direct,
    wired: false,
    settingsExists: false,
    helperPath: null,
    baseUrl: null,
    providerMode: "none",
    directAuth: { command: null, authenticated: false },
  });
  expect(none.status).toBe("ok");
  expect(none.detail).toContain("provider: none");
  expect(none.detail).toContain("not configured");

  // Custom apiKeyHelper the user set -- left alone, reported informationally.
  const other = checkClaude({
    ...direct,
    wired: false,
    helperPath: "/opt/x/helper.sh",
    baseUrl: null,
    providerMode: "other",
    otherReason: "custom",
  });
  expect(other.status).toBe("ok");
  expect(other.detail).toContain("provider: other");
  expect(other.detail).toContain("not managed");

  // ...but the classifier's "legacy-unrecognized" reason (apiKeyHelper at our
  // legacy helper path with a body it could not verify) is a broken leftover,
  // warned with the rewire fix for the mode the filename encodes. The warn keys
  // off the REASON, never a re-derivation of the classifier's path logic.
  const brokenLegacyDirect = checkClaude({
    ...direct,
    wired: false,
    helperPath: directHelperPath("/h/.claude"),
    baseUrl: null,
    providerMode: "other",
    otherReason: "legacy-unrecognized",
  });
  expect(brokenLegacyDirect.status).toBe("warn");
  expect(brokenLegacyDirect.detail).toContain("cannot verify the helper body");
  expect(brokenLegacyDirect.fix).toBe("agent claude --direct");
  const brokenLegacyProxy = checkClaude({
    ...direct,
    wired: false,
    helperPath: proxyHelperPath("/h/.claude"),
    baseUrl: null,
    providerMode: "other",
    otherReason: "legacy-unrecognized",
  });
  expect(brokenLegacyProxy.status).toBe("warn");
  expect(brokenLegacyProxy.fix).toBe("agent claude --proxy");

  // A file that could not be parsed or read warns too: Claude itself will trip
  // over it, and copilot-env can verify nothing there.
  const malformed = checkClaude({
    ...direct,
    wired: false,
    helperPath: null,
    baseUrl: null,
    providerMode: "other",
    otherReason: "malformed",
  });
  expect(malformed.status).toBe("warn");
  expect(malformed.detail).toContain("not valid JSON");
  expect(malformed.fix).toContain("repair");
  const unreadable = checkClaude({
    ...direct,
    wired: false,
    helperPath: null,
    baseUrl: null,
    providerMode: "other",
    otherReason: "read-error",
  });
  expect(unreadable.status).toBe("warn");
  expect(unreadable.detail).toContain("could not be read");
});

test("direct + stored token reports ok with gh absent (no gh requirement)", () => {
  // Codex: a stored token (directUsesToken, providerWired) is ok even with gh missing.
  const codexToken: CodexFacts = {
    home: "/c",
    configExists: true,
    providerSelected: true,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: true,
    envKeyMatches: true,
    providerWired: true,
    envFilePresent: true,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    directAuth: { command: null, authenticated: false },
    directUsesToken: true,
    directNeedsNoGh: true,
    otherReason: null,
  };
  const codexRes = checkCodex(codexToken);
  expect(codexRes.status).toBe("ok");
  expect(codexRes.detail).toContain("stored GitHub token");
  expect(codexRes.detail).not.toContain("GitHub CLI not found");

  // Claude: stored-token resolver, gh absent -> still ok (base URL is right).
  const claudeToken: ClaudeFacts = {
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings.json"),
    settingsExists: true,
    helperPath: join("/h/.claude", "copilot-token.sh"),
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: false,
    providerMode: "direct",
    wired: true,
    otherReason: null,
    directAuth: { command: null, authenticated: false },
    directUsesToken: true,
  };
  const claudeRes = checkClaude(claudeToken);
  expect(claudeRes.status).toBe("ok");
  expect(claudeRes.detail).toContain("stored GitHub token");
  expect(claudeRes.detail).not.toContain("GitHub CLI not found");
});

// --- auth (credential) check ------------------------------------------------

test("checkAuth: a stored token reports ok", () => {
  const res = checkAuth({
    storedToken: true,
    ghAuthenticated: false,
    provider: "gh-token",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(res.group).toBe("auth");
  expect(res.status).toBe("ok");
  expect(res.detail).toContain("stored GitHub token");
  expect(res.detail).toContain("gh-token");
  expect(res.fix).toBeUndefined();
});

test("checkAuth: no stored token but gh authed reports ok (falls back to gh)", () => {
  const res = checkAuth({
    storedToken: false,
    ghAuthenticated: true,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(res.status).toBe("ok");
  expect(res.detail).toContain("gh CLI");
});

test("checkAuth: neither stored token nor gh reports warn with the agent auth fix", () => {
  const res = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    provider: null,
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(res.status).toBe("warn");
  expect(res.detail).toContain("not authenticated");
  expect(res.fix).toBe("agent auth");
});

test("checkAuth: gh-cli with an UNPROVEN gh probe warns could-not-check, never `gh auth login` advice", () => {
  const unproven = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    ghAuthUnproven: true,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(unproven.status).toBe("warn");
  expect(unproven.detail).toBe([
    "provider 'gh-cli' is selected but its credential could not be checked",
    "could not check gh authentication (`gh auth token` did not run to completion)",
  ].join("\n"));
  expect(unproven.fix).toBe("agent auth");
  expect(unproven.value).toMatchObject({ ghAuthUnproven: true });
  // The PROVEN miss keeps the landed confident wording + advice.
  const proven = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(proven.detail).toBe([
    "provider 'gh-cli' is selected but no credential resolves",
    "`gh` is unauthenticated - run `gh auth login`, or `agent auth` to switch provider",
  ].join("\n"));
});

// --- live (--live) checks ---------------------------------------------------

test("checkCodexLive/checkClaudeLive: ok responds, fail warns, missing skips", () => {
  expect(checkCodexLive({ kind: "ok", cli: "/bin/codex" }).status).toBe("ok");
  const codexFail = checkCodexLive({ kind: "failed", cli: "/bin/codex", detail: "exit 1" });
  expect(codexFail.status).toBe("warn");
  expect(codexFail.fix).toBe("agent codex");
  const codexSkip = checkCodexLive({ kind: "skipped" });
  expect(codexSkip.status).toBe("ok");
  expect(codexSkip.detail).toContain("skipped");

  // The captured output is surfaced verbatim (a failed probe ALWAYS carries it).
  const codexFailWithDetail = checkCodexLive({
    kind: "failed",
    cli: "/bin/codex",
    detail: '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
  });
  expect(codexFailWithDetail.status).toBe("warn");
  expect(codexFailWithDetail.detail).toContain("401 Unauthorized");
  expect(codexFailWithDetail.detail).not.toContain("did not answer");

  expect(checkClaudeLive({ kind: "ok", cli: "/bin/claude" }).status).toBe("ok");
  const claudeFail = checkClaudeLive({ kind: "failed", cli: "/bin/claude", detail: "exit 1" });
  expect(claudeFail.status).toBe("warn");
  expect(claudeFail.fix).toBe("agent claude");
  // Claude surfaces the full captured error too (symmetric with codex).
  const claudeFailWithDetail = checkClaudeLive({
    kind: "failed",
    cli: "/bin/claude",
    detail: "API Error: 401 invalid x-api-key",
  });
  expect(claudeFailWithDetail.detail).toContain("401 invalid x-api-key");
  expect(claudeFailWithDetail.detail).not.toContain("did not answer");
  expect(checkClaudeLive({ kind: "skipped" }).status).toBe("ok");
});

test("live checks: a skip off a FAILED look says could-not-check, never 'not installed'", () => {
  const codexSkip = checkCodexLive({ kind: "skipped", lookFailed: true });
  expect(codexSkip.status).toBe("ok");
  expect(codexSkip.detail).toBe(
    "skipped (could not check for the codex CLI - the command probe failed to run)",
  );
  expect(codexSkip.value).toEqual({ ran: false, ok: false, cli: null, lookFailed: true });
  const claudeSkip = checkClaudeLive({ kind: "skipped", lookFailed: true });
  expect(claudeSkip.status).toBe("ok");
  expect(claudeSkip.detail).toBe(
    "skipped (could not check for the claude CLI - the command probe failed to run)",
  );
  // The proven-absent skip keeps the landed wording, unmarked.
  const proven = checkCodexLive({ kind: "skipped" });
  expect(proven.detail).toBe("skipped (codex CLI not installed)");
  expect(proven.value).toEqual({ ran: false, ok: false, cli: null });
});

test("runLiveCli: a FAILED CLI look skips MARKED; a proven absence skips unmarked", async () => {
  expect(
    await runLiveCli("codex", [], "/tmp", "CODEX_HOME", [], () => ({
      path: null,
      launchFailed: true,
    })),
  ).toEqual({ kind: "skipped", lookFailed: true });
  expect(await runLiveCli("codex", [], "/tmp", "CODEX_HOME", [], () => ({ path: null }))).toEqual({
    kind: "skipped",
  });
});

test("evaluateAll(full) includes the live checks only when their facts are present", () => {
  const facts: HealthFacts = {
    codexLive: { kind: "ok", cli: "/bin/codex" },
    claudeLive: { kind: "failed", cli: "/bin/claude", detail: "exit 1" },
  };
  const ids = evaluateAll("full", facts).map((r) => r.id);
  expect(ids).toContain("codex.live");
  expect(ids).toContain("claude.live");
  // No live facts => no live checks.
  expect(evaluateAll("full", {}).map((r) => r.id)).not.toContain("codex.live");
});

// --- pure sub-evaluators ----------------------------------------------------

test("evalShellFiles: launchersWired is the config key; markers stay per-file facts", () => {
  const integration = "# copilot-env shell integration";
  const launchers = "# copilot-env launchers";
  const facts = evalShellFiles([
    { path: "/a", content: `before\n${integration}\nsource x\n` },
    { path: "/b", content: `${launchers}\nsource y\n` },
    { path: "/c", content: null },
  ], true);
  expect(facts.integrationWired).toBe(true);
  expect(facts.launchersWired).toBe(true);
  // The legacy launchers marker stays a per-file fact (a leftover block), but it
  // no longer decides launchersWired -- the config key does.
  expect(facts.files.find((f) => f.path === "/b")?.hasLaunchers).toBe(true);
  expect(facts.files.find((f) => f.path === "/c")?.hasIntegration).toBe(false);
  expect(
    evalShellFiles([{ path: "/b", content: `${launchers}\nsource y\n` }], false)
      .launchersWired,
  ).toBe(false);
});

test("evalShellFiles reports unwired when no markers present and the key is off", () => {
  const facts = evalShellFiles([{ path: "/a", content: "export FOO=1\n" }], false);
  expect(facts.integrationWired).toBe(false);
  expect(facts.launchersWired).toBe(false);
});

test("evalCodex: no config.toml at the home reads as not-configured", () => {
  const f = evalCodex("/c", null, null, 4141, false);
  expect(f.configExists).toBe(false);
  expect(f.providerWired).toBe(false);
  expect(f.home).toBe("/c");
  expect(f.providerMode).toBe("none");
});

test("evalCodex: provider wired only when default + env_key + host:port all match", () => {
  const good =
    `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:4141/v1"\nenv_key = "OPENAI_API_KEY"\n`;
  const stalePort =
    `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:9999/v1"\nenv_key = "OPENAI_API_KEY"\n`;
  const wrongEnvKey =
    `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:4141/v1"\nenv_key = "COPILOT_API_KEY"\n`;
  const env = "OPENAI_API_KEY=sk-test\n";
  expect(evalCodex("/c", good, env, 4141, false)).toMatchObject({
    providerMode: "proxy",
    providerWired: true,
    envKeyInDotenv: true,
    tokenAvailable: true,
  });
  expect(evalCodex("/c", stalePort, env, 4141, false).providerWired).toBe(false);
  expect(evalCodex("/c", wrongEnvKey, env, 4141, false).providerWired).toBe(false);
  // No token in .env, but present in the environment => still available.
  expect(evalCodex("/c", good, "FOO=1\n", 4141, true)).toMatchObject({
    envKeyInDotenv: false,
    envKeyInEnviron: true,
    tokenAvailable: true,
  });
  // No token anywhere => not available.
  expect(evalCodex("/c", good, "FOO=1\n", 4141, false).tokenAvailable).toBe(false);
});

test("evalCodex: direct provider reports direct mode without requiring OPENAI_API_KEY", () => {
  const direct =
    `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "https://api.githubcopilot.com"\n`;
  expect(evalCodex("/c", direct, null, 4141, false)).toMatchObject({
    providerMode: "direct",
    providerWired: true,
    tokenAvailable: false,
  });
});

test("evalCodex: a port that only appears as a substring does not match", () => {
  // base_url port 41410 must NOT satisfy expected port 4141 (old substring bug).
  const decoy =
    `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:41410/v1"\nenv_key = "OPENAI_API_KEY"\n`;
  expect(evalCodex("/c", decoy, "OPENAI_API_KEY=x\n", 4141, false).providerWired).toBe(false);
});

test("evalCodex: base_url must be the full http://localhost:<port>/v1 contract", () => {
  const mk = (url: string) =>
    `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "${url}"\nenv_key = "OPENAI_API_KEY"\n`;
  const env = "OPENAI_API_KEY=x\n";
  // Right host+port but missing /v1, or https, or a different path => not wired.
  expect(evalCodex("/c", mk("http://localhost:4141"), env, 4141, false).baseUrlMatches).toBe(false);
  expect(evalCodex("/c", mk("https://localhost:4141/v1"), env, 4141, false).baseUrlMatches).toBe(
    false,
  );
  expect(evalCodex("/c", mk("http://localhost:4141/not-v1"), env, 4141, false).baseUrlMatches).toBe(
    false,
  );
  // The managed contract (and the 127.0.0.1 equivalent, trailing slash) match.
  expect(evalCodex("/c", mk("http://localhost:4141/v1"), env, 4141, false).baseUrlMatches).toBe(
    true,
  );
  expect(evalCodex("/c", mk("http://127.0.0.1:4141/v1/"), env, 4141, false).baseUrlMatches).toBe(
    true,
  );
});

test("evalCodex: OPENAI_API_KEY with spaces after = still counts as present in .env", () => {
  const good =
    `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:4141/v1"\nenv_key = "OPENAI_API_KEY"\n`;
  expect(evalCodex("/c", good, "OPENAI_API_KEY = sk-test\n", 4141, false).envKeyInDotenv).toBe(
    true,
  );
});

test("checkCodexHost: the codex-host key against the disk, every drift warns with `agent codex`", () => {
  const hostHome = "/h/.codex/hosts/box";
  const configLine = `config.toml: ${join(hostHome, "config.toml")}`;
  const on: CodexHostFacts = {
    supported: true,
    hostHome,
    exists: true,
    wired: true,
    probeError: null,
    active: true,
    setting: true,
  };
  // Key on, farm wired and recorded as the active home: the one healthy on-state.
  const active = checkCodexHost(on);
  expect(active.status).toBe("ok");
  expect(active.fix).toBeUndefined();
  expect(active.detail).toBe(`active per-host CODEX_HOME: ${hostHome}\n${configLine}`);
  expect(active.value).toEqual({
    supported: true,
    hostHome,
    configFile: join(hostHome, "config.toml"),
    exists: true,
    wired: true,
    probeError: null,
    active: true,
    setting: true,
  });
  // Every disagreement is a warn carrying the wiring pass that resolves it.
  const missing =
    `codex-host is on but the per-host CODEX_HOME farm is missing at ${hostHome}; run \`agent codex\` to rebuild it`;
  const disabled =
    `codex-host is off but a per-host CODEX_HOME farm is still present at ${hostHome}; run \`agent codex\` to remove it`;
  const drifts: Array<
    { facts: CodexHostFacts; summary: string; withConfig: boolean; fix?: string }
  > = [
    // On but hand-deleted (nothing on disk).
    { facts: { ...on, exists: false, wired: false }, summary: missing, withConfig: false },
    // On but only half-built (dir without config.toml).
    { facts: { ...on, wired: false }, summary: missing, withConfig: true },
    // On and wired, but no wiring pass recorded it as the active home yet.
    {
      facts: { ...on, active: false },
      summary:
        `codex-host is on but ${hostHome} is not the active CODEX_HOME; run \`agent codex\` to activate it`,
      withConfig: true,
    },
    // Unset with a wired farm: the next pass adopts it.
    {
      facts: { ...on, active: false, setting: null },
      summary:
        `codex-host is unset but a per-host CODEX_HOME farm exists at ${hostHome}; run \`agent codex\` to adopt it (records codex-host = true)`,
      withConfig: true,
    },
    // A farm the probe cannot read: wiring unproven, so the pass will refuse to decide.
    {
      facts: { ...on, wired: false, probeError: "EACCES: permission denied", setting: null },
      summary:
        `the per-host CODEX_HOME farm at ${hostHome} cannot be inspected (EACCES: permission denied); fix that, then run \`agent codex\``,
      withConfig: true,
    },
    // Off (or unset without a wired config) with a farm still on disk: the next pass removes it.
    { facts: { ...on, active: false, setting: false }, summary: disabled, withConfig: true },
    // Off wins over an unreadable probe: the removal needs no proof of wiring, and an
    // unprobeable DIR (present unproven) is still pending removal.
    {
      facts: { ...on, wired: false, probeError: "EACCES", setting: false },
      summary: disabled,
      withConfig: true,
    },
    {
      facts: { ...on, exists: false, wired: false, probeError: "EACCES", setting: false },
      summary: disabled,
      withConfig: false,
    },
    {
      facts: { ...on, wired: false, active: true, setting: null },
      summary: disabled,
      withConfig: true,
    },
    // Unset with an unrecorded half-built dir: not proven ours, so the user decides.
    {
      facts: { ...on, wired: false, active: false, setting: null },
      summary:
        `an unwired directory sits at the per-host CODEX_HOME farm path ${hostHome} and no wiring pass recorded it; set codex-host true to build the farm there or false to remove it`,
      withConfig: true,
      fix: "agent config --set codex-host true|false",
    },
  ];
  for (const { facts, summary, withConfig, fix } of drifts) {
    const result = checkCodexHost(facts);
    expect(result.status).toBe("warn");
    expect(result.fix).toBe(fix ?? "agent codex");
    expect(result.detail).toBe(withConfig ? `${summary}\n${configLine}` : summary);
  }
  // Not built, not wanted (off or unset): informational, and the path is not echoed.
  for (const setting of [false, null]) {
    const unbuilt = checkCodexHost({ ...on, exists: false, wired: false, active: false, setting });
    expect(unbuilt.status).toBe("ok");
    expect(unbuilt.fix).toBeUndefined();
    expect(unbuilt.detail).toBe("not built (optional)");
  }
  // Windows: no farm is possible, whatever the key says.
  const unsupported = checkCodexHost({ ...on, supported: false, setting: false });
  expect(unsupported.status).toBe("ok");
  expect(unsupported.detail).toBe("not built (unsupported on Windows)");
});

test("checkAutoupdate: full status always shown (disabled too); recorded error warns", () => {
  const base = { enabled: false, cooldownDays: 7, lastCheckMs: 0, lastResult: "" };
  const disabled = checkAutoupdate(base);
  expect(disabled.status).toBe("ok");
  // Even when disabled, cooldown / last check / last result are surfaced.
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

test("evaluateAll(runtime) yields exactly the two runtime checks", () => {
  const facts: HealthFacts = { runtimes: [defaultTarget()] };
  const ids = evaluateAll("runtime", facts).map((r) => r.id);
  expect(ids).toEqual(["runtime.port", "runtime.pid"]);
});

test("evaluateAll(codex) yields only the Codex wiring check", () => {
  const facts: HealthFacts = {
    codex: {
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
      otherReason: null,
    },
    codexHost: {
      supported: false,
      hostHome: "/h/.codex/hosts/box",
      exists: false,
      wired: false,
      probeError: null,
      active: false,
      setting: false,
    },
  };
  const ids = evaluateAll("codex", facts).map((r) => r.id);
  expect(ids).toEqual(["setup.codex"]);
});

test("evaluateAll(full) includes runtime.paths and setup checks", () => {
  const facts: HealthFacts = {
    runtimes: [defaultTarget()],
    bootstrap: BOOTSTRAP_OK,
    proxy: {
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds: 604800,
      floatSkips: false,
      resolved: null,
      sidecar: { kind: "dev", pin: "2.9.5", denoBin: "/deno", standalone: false },
    },
    shell: { files: [], integrationWired: true, launchersWired: false },
    clis: [{ command: "claude", name: "Claude", look: { path: null } }],
    tools: { node: { path: "/n" }, npm: { path: "/m" } },
    codex: {
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
      otherReason: null,
    },
    codexHost: {
      supported: false,
      hostHome: "/h/.codex/hosts/box",
      exists: false,
      wired: false,
      probeError: null,
      active: false,
      setting: false,
    },
    claude: {
      home: "/h/.claude",
      settingsPath: "/h/.claude/settings.json",
      settingsExists: false,
      helperPath: null,
      baseUrl: null,
      baseUrlMatches: false,
      providerMode: "none",
      wired: false,
      otherReason: null,
      directAuth: { command: null, authenticated: false },
      directUsesToken: false,
    },
    autoupdate: { enabled: false, cooldownDays: 7, lastCheckMs: 0, lastResult: "" },
  };
  const ids = evaluateAll("full", facts).map((r) => r.id);
  expect(ids).toContain("runtime.paths");
  expect(ids).toContain("setup.cli.claude");
  expect(ids).toContain("proxy.package");
  expect(ids).toContain("setup.codex-host");
  expect(ids).toContain("setup.claude");
  expect(ids).toContain("setup.autoupdate");
});

test("checkAuth renders the named-profiles detail line from the swept facts", () => {
  // The producer sweeps the store via profileNames(), so only validated names
  // arrive here (pinned in state.test.ts); this pins the non-empty rendering.
  const res = checkAuth({
    storedToken: true,
    ghAuthenticated: false,
    provider: "gh-token",
    profiles: {
      [parseProfileName("fast")]: { provider: null, mode: "proxy", integrationIdentity: null },
      [parseProfileName("work")]: {
        provider: "gh-token",
        mode: "direct",
        integrationIdentity: "copilot-developer-cli",
      },
    },
    pinnedIntegrationId: null,
  });
  expect(res.detail).toContain(
    "named profiles: fast (no auth, proxy), work (gh-token, direct, copilot-developer-cli)",
  );
});
