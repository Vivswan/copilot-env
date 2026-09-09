import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { directHelperCommand } from "../src/claude/config.ts";
import { DEFAULT_HOME_STAGING_DIR, PROFILES_DIR_NAME } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import type { TextReadResult } from "../src/utils/fs.ts";
import { proxyTokenCommand } from "../src/utils/root.ts";
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
  checkCli,
  checkCliVersion,
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
import { checkClaude, checkCodex } from "../src/health/checks_agents.ts";
import {
  type BootstrapFacts,
  classifyPortState,
  type DaemonProbed,
  type DefaultRuntimeTarget,
  type HealthFacts,
  type PortState,
  type ProxyFacts,
  type RuntimeTarget,
  type WatchdogFacts,
} from "../src/health/facts.ts";
import {
  directAuthFromSpawn,
  evalCodex,
  evalShellFiles,
  gatherFacts,
  runLiveCli,
} from "../src/health/probe.ts";
import type { CheckId, CheckResult, CheckStatus, HealthScope } from "../src/health/types.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";
import {
  codexConfigToml,
  envSnapshot,
  writeClaudeSettings,
  writeCodexConfigToml,
} from "./helpers.ts";

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
      ghUser: null,
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
      sidecar: {
        kind: "dev",
        referenceVersion: "2.9.5",
        denoBin: "/deno",
        version: "2.9.5",
        standalone: false,
      },
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
      sidecar: {
        kind: "dev",
        referenceVersion: "2.9.5",
        denoBin: "/deno",
        version: "2.9.5",
        standalone: false,
      },
    }).status,
  ).toBe("fail");
  const above = checkProxyPackage({
    version: "2.0.0",
    bounds: { ok: false, reason: "aboveCeiling", version: "2.0.0", ceiling: "1.99.0" },
    configError: null,
    cooldownSeconds: 604800,
    floatSkips: false,
    resolved: null,
    sidecar: {
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/deno",
      version: "2.9.5",
      standalone: false,
    },
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
      sidecar: {
        kind: "dev",
        referenceVersion: "2.9.5",
        denoBin: "/deno",
        version: "2.9.5",
        standalone: false,
      },
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

  // A missing package is a broken CHECKOUT in any mode: the exemption must not
  // swallow it (a reinstall genuinely fixes it, float or no float).
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

  // An in-bounds proxy on a direct-only machine reads plain ok: no note glued
  // onto the version/cooldown detail, no floatSkips stamp.
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

  // An unreadable copilot-env.config stays a failure in any mode: the early
  // return fires before the exemption, and its fix is actionable regardless.
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
});

test("proxy package: a compiled install treats missing as pre-start, not broken", () => {
  // A compiled binary ships no deno.json baseline -- the float resolves the proxy
  // into its own cache at `agent start`. "Missing" is therefore the normal state
  // of a fresh or direct-only binary install and must not fail.
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
      sidecar: {
        kind: "dev",
        referenceVersion: "2.9.5",
        denoBin: "/deno",
        version: "2.9.5",
        standalone: false,
      },
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
    sidecar: {
      kind: "dev",
      referenceVersion: "2.9.5",
      denoBin: "/deno",
      version: "2.9.5",
      standalone: false,
    },
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

  // A PATH deno is the normal answer under the user's-toolchain-wins policy:
  // ok at or above the tested reference, a WARN (never a block) when older,
  // and unknown-version reads ok (an unreadable version is not a verdict).
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

  // Direct-only (the float skips): nothing spawns the proxy, so an absent
  // sidecar is idle capacity, not a failure -- even on a compiled build.
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
  const root = tempDir("copilot-health-bothdirect-");
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
  const root = tempDir("copilot-health-proxywired-");
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
  const root = tempDir("copilot-health-staging-");
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
  // The account pin travels on the fact (so the check can name it); auto adds
  // nothing, keeping the pre-pin fact shape byte-identical.
  expect(directAuthFromSpawn("/bin/gh", { status: 1 }, "work-bot")).toEqual({
    command: "/bin/gh",
    authenticated: false,
    ghUser: "work-bot",
  });
  expect(directAuthFromSpawn("/bin/gh", { status: 0 }, null)).toEqual({
    command: "/bin/gh",
    authenticated: true,
  });
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
  // A PINNED slot's verdict names its account (the probe ran `gh auth token
  // --user`); gh's active account may well be fine.
  const pinned = checkAuth({
    storedToken: false,
    ghAuthenticated: false,
    ghUser: "work-bot",
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
    provider: "gh-cli",
    profiles: {},
    pinnedIntegrationId: null,
  });
  expect(pinnedOk.status).toBe("ok");
  expect(pinnedOk.detail).toContain("gh CLI (`gh auth token --user work-bot`)");
});

// --- live (--live) checks ---------------------------------------------------

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

/** The managed proxy config at `baseUrl`: the `agent proxy-token` auth block. */
function proxyToml(baseUrl: string): string {
  return codexConfigToml({ baseUrl, auth: proxyTokenCommand() });
}

test("evalCodex: provider wired only when default + managed auth + host:port all match", () => {
  const good = proxyToml("http://localhost:4141/v1");
  const stalePort = proxyToml("http://localhost:9999/v1");
  const foreignAuth = codexConfigToml({
    baseUrl: "http://localhost:4141/v1",
    auth: { command: "/usr/local/bin/other", args: ["--yes"] },
  });
  const env = "OPENAI_API_KEY=sk-test\n";
  expect(evalCodex("/c", good, env, 4141, false)).toMatchObject({
    providerMode: "proxy",
    providerWired: true,
    envKeyInDotenv: true,
    tokenAvailable: true,
  });
  expect(evalCodex("/c", stalePort, env, 4141, false).providerWired).toBe(false);
  expect(evalCodex("/c", foreignAuth, env, 4141, false).providerWired).toBe(false);
  // The pre-4.0.0 default proxy shape (`env_key` instead of the managed auth block), with
  // the token present: proxy by base_url, but never managed wiring -- the 4.0.0
  // migration rewrites it, and `agent health` sends an unconverted one to `agent codex`.
  const legacyEnvKey = codexConfigToml({
    baseUrl: "http://localhost:4141/v1",
    envKey: "OPENAI_API_KEY",
  });
  expect(evalCodex("/c", legacyEnvKey, env, 4141, false)).toMatchObject({
    providerMode: "proxy",
    envKeyMatches: false,
    providerWired: false,
    tokenAvailable: true,
  });
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
  const decoy = proxyToml("http://localhost:41410/v1");
  expect(evalCodex("/c", decoy, "OPENAI_API_KEY=x\n", 4141, false).providerWired).toBe(false);
});

test("evalCodex: base_url must be the full http://localhost:<port>/v1 contract", () => {
  const mk = proxyToml;
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
  const good = proxyToml("http://localhost:4141/v1");
  expect(evalCodex("/c", good, "OPENAI_API_KEY = sk-test\n", 4141, false).envKeyInDotenv).toBe(
    true,
  );
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
      enabled: false,
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
      sidecar: {
        kind: "dev",
        referenceVersion: "2.9.5",
        denoBin: "/deno",
        version: "2.9.5",
        standalone: false,
      },
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
      enabled: false,
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
    claudeDesktop: { kind: "no-library", enabled: true, installed: false, helperPaths: [] },
    autoupdate: { enabled: false, cooldownDays: 7, lastCheckMs: 0, lastResult: "" },
  };
  const ids = evaluateAll("full", facts).map((r) => r.id);
  expect(ids).toContain("runtime.paths");
  expect(ids).toContain("setup.cli.claude");
  expect(ids).toContain("proxy.package");
  expect(ids).toContain("setup.codex-host");
  expect(ids).toContain("setup.claude");
  expect(ids).toContain("setup.claude-desktop");
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
