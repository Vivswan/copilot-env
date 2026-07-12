import { expect, test } from "bun:test";
import { join } from "node:path";

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
  checkBun,
  checkClaude,
  checkClaudeLive,
  checkCli,
  checkCliVersion,
  checkCodex,
  checkCodexHost,
  checkCodexLive,
  checkLaunchers,
  checkNodeModules,
  checkProxyPackage,
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
  type ClaudeFacts,
  type CodexFacts,
  evalCodex,
  evalShellFiles,
  gatherFacts,
  type HealthFacts,
  type RuntimeFacts,
} from "../src/health/probe.ts";
import type { CheckResult, CheckStatus, HealthScope } from "../src/health/types.ts";

// --- fixtures ---------------------------------------------------------------

function result(id: string, status: CheckStatus, scopes: HealthScope[]): CheckResult {
  return { id, label: id, group: "runtime", scopes, status, detail: "" };
}

const RUNTIME_OK: RuntimeFacts = {
  port: 4141,
  reachable: true,
  trackedPid: 1234,
  pidTracked: true,
  pidAlive: true,
  bothDirect: false,
  identityConfirmed: true,
  paths: {
    home: "/h",
    configFile: "/h/config.json",
    runDir: "/h/.run/x",
    stateFile: "/h/.run/x/.state.json",
    logFile: "/h/.run/x/.log",
    sqliteDb: "/h/.run/x/db.sqlite",
  },
  watchdog: {
    autoStart: false,
    idleTimeoutMs: 3_600_000,
    lastEnsureAt: null,
    lastRequestMs: null,
    now: 1_000_000_000,
  },
};

const BOOTSTRAP_OK: BootstrapFacts = {
  cliVersion: "3.1.0",
  bun: { available: true, version: "1.2.0" },
  nodeModules: { present: true, fresh: true },
};

// --- aggregate --------------------------------------------------------------

test("worstStatus picks fail > warn > ok and defaults ok when empty", () => {
  expect(worstStatus([])).toBe("ok");
  expect(worstStatus([result("a", "ok", ["full"]), result("b", "warn", ["full"])])).toBe("warn");
  expect(
    worstStatus([
      result("a", "warn", ["full"]),
      result("b", "fail", ["full"]),
      result("c", "ok", ["full"]),
    ]),
  ).toBe("fail");
});

test("exitCodeFor is 1 iff any fail; warnings alone exit 0", () => {
  expect(exitCodeFor([result("a", "ok", ["full"]), result("b", "warn", ["full"])])).toBe(0);
  expect(exitCodeFor([result("a", "fail", ["full"])])).toBe(1);
  expect(exitCodeFor([])).toBe(0);
});

test("filterByScope keeps only participating checks, preserving order", () => {
  const all = [
    result("runtime.port", "ok", ["full", "proxy", "runtime"]),
    result("setup.shell", "warn", ["full", "setup"]),
    result("setup.codex", "ok", ["full", "setup", "codex"]),
    result("bootstrap.bun", "ok", ["full", "proxy"]),
  ];
  expect(filterByScope(all, "runtime").map((r) => r.id)).toEqual(["runtime.port"]);
  expect(filterByScope(all, "setup").map((r) => r.id)).toEqual(["setup.shell", "setup.codex"]);
  expect(filterByScope(all, "codex").map((r) => r.id)).toEqual(["setup.codex"]);
  expect(filterByScope(all, "proxy").map((r) => r.id)).toEqual(["runtime.port", "bootstrap.bun"]);
  expect(filterByScope(all, "full").map((r) => r.id)).toEqual([
    "runtime.port",
    "setup.shell",
    "setup.codex",
    "bootstrap.bun",
  ]);
});

test("isHealthScope narrows known scopes and rejects others", () => {
  for (const s of ["full", "runtime", "proxy", "setup", "codex", "claude"]) {
    expect(isHealthScope(s)).toBe(true);
  }
  expect(isHealthScope("bogus")).toBe(false);
});

test("buildHealthJson exposes scope/ok/status/exitCode/checks with ok === no-fail", () => {
  const okJson = buildHealthJson("full", [result("a", "warn", ["full"])]);
  expect(okJson).toMatchObject({ scope: "full", ok: true, status: "warn", exitCode: 0 });
  expect(okJson.checks).toHaveLength(1);

  const failJson = buildHealthJson("runtime", [result("a", "fail", ["runtime"])]);
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
    }).status,
  ).toBe("fail");
  expect(
    checkProxyPackage({
      version: "1.0.0",
      bounds: { ok: false, reason: "belowFloor", version: "1.0.0", floor: "1.10.0" },
      configError: null,
      cooldownSeconds: 604800,
    }).status,
  ).toBe("fail");
  const above = checkProxyPackage({
    version: "2.0.0",
    bounds: { ok: false, reason: "aboveCeiling", version: "2.0.0", ceiling: "1.99.0" },
    configError: null,
    cooldownSeconds: 604800,
  });
  expect(above.status).toBe("warn");
  expect(above.fix).toBe("agent update");
  expect(
    checkProxyPackage({
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds: 604800,
    }).status,
  ).toBe("ok");
});

test("proxy package detail shows the float cooldown window", () => {
  const ok = (cooldownSeconds: number | null) =>
    checkProxyPackage({
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds,
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
  });
  expect(r.status).toBe("fail");
  expect(r.detail).toContain("copilot-env.config");
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
  expect(checkRuntimePort(RUNTIME_OK).status).toBe("ok");
  expect(checkRuntimePort({ ...RUNTIME_OK, reachable: false }).status).toBe("fail");
});

test("runtime: a down proxy is OK when both Codex and Claude are direct", () => {
  const down = { ...RUNTIME_OK, reachable: false, trackedPid: null, pidTracked: false };
  // Proxy not required => no failure (warnings/ok only), so the overall exit is 0.
  expect(checkRuntimePort(down).status).toBe("fail");
  expect(checkRuntimePid(down).status).toBe("fail");
  const bothDirect = { ...down, bothDirect: true };
  expect(checkRuntimePort(bothDirect).status).toBe("ok");
  expect(checkRuntimePort(bothDirect).detail).toContain("both direct");
  expect(checkRuntimePid(bothDirect).status).toBe("ok");
});

test("runtime pid: stale/foreign and untracked fail, tracked ok", () => {
  expect(checkRuntimePid(RUNTIME_OK).status).toBe("ok");
  // reachable but not our pid (foreign squatter / stale): pid check fails, port ok
  const foreign = { ...RUNTIME_OK, pidTracked: false };
  expect(checkRuntimePid(foreign).status).toBe("fail");
  expect(checkRuntimePort(foreign).status).toBe("ok");
  const untracked = { ...RUNTIME_OK, trackedPid: null, pidTracked: false, pidAlive: false };
  expect(checkRuntimePid(untracked).status).toBe("fail");
});

test("runtime watchdog: off, disabled, and active states are all ok with informative detail", () => {
  // auto-start off -> reports off, never auto-stops.
  const off = checkRuntimeWatchdog(RUNTIME_OK); // RUNTIME_OK has watchdog.autoStart=false
  expect(off.status).toBe("ok");
  expect(off.detail).toContain("off");
  expect(off.value).toEqual({ autoStart: false });

  // auto-start on but idle-timeout 0 -> auto-stop disabled.
  const disabled = checkRuntimeWatchdog({
    ...RUNTIME_OK,
    watchdog: { ...RUNTIME_OK.watchdog, autoStart: true, idleTimeoutMs: 0 },
  });
  expect(disabled.detail).toContain("disabled");

  // Active: window 1h, last beat 20m ago, no request traffic -> 40m remaining, 20m idle.
  const now = 1_000_000_000;
  const active = checkRuntimeWatchdog({
    ...RUNTIME_OK,
    watchdog: {
      autoStart: true,
      idleTimeoutMs: 3_600_000,
      lastEnsureAt: now - 20 * 60_000,
      lastRequestMs: null,
      now,
    },
  });
  expect(active.status).toBe("ok");
  expect(active.detail).toContain("auto-stops in 40m");
  expect(active.detail).toContain("idle for 20m");
  expect(active.detail).toContain("last beat 20m ago");
  expect(active.detail).toContain("last request none");
  expect(active.value?.remainingMs).toBe(40 * 60_000);
  expect(active.value?.idleMs).toBe(20 * 60_000);

  // Idle past the window clamps remaining to 0; log mtime counts as the latest activity.
  const expired = checkRuntimeWatchdog({
    ...RUNTIME_OK,
    watchdog: {
      autoStart: true,
      idleTimeoutMs: 600_000,
      lastEnsureAt: now - 3_600_000,
      lastRequestMs: now - 1_200_000, // 20m ago, more recent than the beat
      now,
    },
  });
  expect(expired.value?.idleMs).toBe(1_200_000);
  expect(expired.value?.remainingMs).toBe(0);
  expect(expired.detail).toContain("auto-stops in 0s");

  // No activity recorded yet -> idle AND remaining are unknown (the daemon's real baseline
  // includes a startedAtMs the probe can't see, so we don't fake a precise full window).
  const fresh = checkRuntimeWatchdog({
    ...RUNTIME_OK,
    watchdog: {
      autoStart: true,
      idleTimeoutMs: 3_600_000,
      lastEnsureAt: null,
      lastRequestMs: null,
      now,
    },
  });
  expect(fresh.detail).toContain("idle for unknown");
  expect(fresh.detail).toContain("auto-stops in unknown");
  expect(fresh.value?.idleMs).toBeNull();
  expect(fresh.value?.remainingMs).toBeNull();
});

test("runtime watchdog is scoped to full + proxy, not the launchers' fast runtime probe", () => {
  expect(checkRuntimeWatchdog(RUNTIME_OK).scopes).toEqual(["full", "proxy"]);
});

test("runtime identity: confirmed ok, foreign warns, down/not-probed stays ok", () => {
  // x-trace-id present -> confirmed copilot-api.
  const ok = checkRuntimeIdentity(RUNTIME_OK); // identityConfirmed: true
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("confirmed copilot-api");

  // Reachable but no x-trace-id -> a foreign service squats the port.
  const foreign = checkRuntimeIdentity({ ...RUNTIME_OK, identityConfirmed: false });
  expect(foreign.status).toBe("warn");
  expect(foreign.detail).toContain("non-copilot-api");
  expect(foreign.fix).toContain("free the port");

  // Not reachable / not probed -> ok (runtime.port owns the down verdict).
  expect(
    checkRuntimeIdentity({ ...RUNTIME_OK, reachable: false, identityConfirmed: null }).status,
  ).toBe("ok");
  expect(checkRuntimeIdentity({ ...RUNTIME_OK, identityConfirmed: null }).status).toBe("ok");
  expect(checkRuntimeIdentity(RUNTIME_OK).scopes).toEqual(["full", "proxy"]);
});

test("runtime orphan: untracked-but-ours warns, foreign defers to identity, tracked ok", () => {
  // Reachable copilot-api (or unknown) but no tracked pid, proxy required -> orphan warn.
  const orphan = checkRuntimeOrphan({
    ...RUNTIME_OK,
    pidTracked: false,
    trackedPid: null,
    identityConfirmed: true,
  });
  expect(orphan.status).toBe("warn");
  expect(orphan.detail).toContain("orphaned");
  expect(orphan.fix).toContain("agent stop");

  // A foreign listener is runtime.identity's verdict -> orphan must NOT also warn.
  expect(
    checkRuntimeOrphan({ ...RUNTIME_OK, pidTracked: false, identityConfirmed: false }).status,
  ).toBe("ok");

  // Foreign responder while our tracked pid is alive: orphan stays ok but must NOT claim the
  // tracked daemon owns the port (that wording belongs to runtime.identity).
  const foreignTracked = checkRuntimeOrphan({ ...RUNTIME_OK, identityConfirmed: false });
  expect(foreignTracked.status).toBe("ok");
  expect(foreignTracked.detail).not.toContain("tracked daemon");
  expect(foreignTracked.detail).toContain("not copilot-api");

  // Tracked daemon -> ok.
  expect(checkRuntimeOrphan(RUNTIME_OK).status).toBe("ok");

  // Both agents direct -> no proxy required -> a missing tracked pid is not an orphan.
  expect(checkRuntimeOrphan({ ...RUNTIME_OK, pidTracked: false, bothDirect: true }).status).toBe(
    "ok",
  );
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
  expect(facts.runtime?.identityConfirmed).toBeNull();
});

test("health's own proxy probes do not move the watchdog activity signal", async () => {
  // lastRequestMs reads the inference handler logs, which health's reach/identity GET / requests
  // never write to. So even though the proxy IS probed, the 'last request' / idle signal is the
  // handler-log value, untouched -- observing the proxy can't reset the numbers.
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
      lastRequestMs: () => 100, // a fixed, old "last real request" (handler-log mtime)
      now: () => 5000,
      autoStartEnabled: () => true,
      idleTimeoutMs: () => 60_000,
    },
  );
  expect(probes).toBeGreaterThan(0); // the proxy WAS probed (reach + identity)
  expect(facts.runtime?.watchdog.lastRequestMs).toBe(100); // ...yet the signal is unchanged
  expect(facts.runtime?.watchdog.now).toBe(5000);
});

// --- bootstrap checks -------------------------------------------------------

test("bun unavailable fails; node_modules absent fails, stale warns, fresh ok", () => {
  expect(checkBun(BOOTSTRAP_OK).status).toBe("ok");
  expect(checkBun({ ...BOOTSTRAP_OK, bun: { available: false, version: null } }).status).toBe(
    "fail",
  );
  expect(checkNodeModules(BOOTSTRAP_OK).status).toBe("ok");
  expect(
    checkNodeModules({ ...BOOTSTRAP_OK, nodeModules: { present: false, fresh: false } }).status,
  ).toBe("fail");
  expect(
    checkNodeModules({ ...BOOTSTRAP_OK, nodeModules: { present: true, fresh: false } }).status,
  ).toBe("warn");
});

// --- setup checks -----------------------------------------------------------

test("shell + launcher wiring: missing warns, present ok", () => {
  const wired = { files: [], integrationWired: true, launchersWired: true };
  const bare = { files: [], integrationWired: false, launchersWired: false };
  expect(checkShellIntegration(wired).status).toBe("ok");
  expect(checkShellIntegration(bare).status).toBe("warn");
  expect(checkLaunchers(wired).status).toBe("ok");
  expect(checkLaunchers(bare).status).toBe("warn");
});

test("optional CLI + tools: missing warns (not fail), present ok", () => {
  expect(checkCli({ command: "claude", name: "Claude", resolved: "/bin/claude" }).status).toBe(
    "ok",
  );
  expect(checkCli({ command: "codex", name: "Codex", resolved: null }).status).toBe("warn");
  expect(checkTool("node", "/usr/bin/node").status).toBe("ok");
  expect(checkTool("npm", null).status).toBe("warn");
});

test("codex: not configured is ok; each broken part warns with a precise message", () => {
  const wired: CodexFacts = {
    home: "/c",
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
    directAuth: { command: "/bin/gh", authenticated: true },
    directUsesToken: false,
    provider: "gh-cli",
  };
  // No config at all -> ok (user never wired Codex).
  expect(checkCodex({ ...wired, configExists: false, providerWired: false }).status).toBe("ok");
  // Fully wired -> ok, multi-line detail: wiring, proxy, then the auth.command resolver.
  const ok = checkCodex(wired);
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("copilot-env");
  expect(ok.detail).toContain("4141");
  expect(ok.detail).toContain("provider: proxy");
  expect(ok.detail.split("\n")).toHaveLength(4);
  expect(ok.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  expect(ok.detail).toContain("proxy-token resolver");
  // model_provider not selected.
  expect(
    checkCodex({ ...wired, providerSelected: false, modelProvider: "openai", providerWired: false })
      .detail,
  ).toContain("model_provider");
  expect(
    checkCodex({ ...wired, providerSelected: false, modelProvider: "openai", providerWired: false })
      .detail,
  ).toContain(`config.toml: ${join("/c", "config.toml")}`);
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

test("checkClaude: direct needs gh + managed base URL; proxy/none/other informational", () => {
  const direct: ClaudeFacts = {
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings.json"),
    settingsExists: true,
    helperPath: join("/h/.claude", "copilot-token.sh"),
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: false,
    providerMode: "direct",
    directAuth: { command: "/bin/gh", authenticated: true },
    directUsesToken: false,
    provider: "gh-cli",
  };
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
  expect(proxyStale.fix).toContain("agent init");

  // Never configured: informational; cl defaults it to the proxy.
  const none = checkClaude({
    ...direct,
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
    helperPath: "/opt/x/helper.sh",
    baseUrl: null,
    providerMode: "other",
  });
  expect(other.status).toBe("ok");
  expect(other.detail).toContain("provider: other");
  expect(other.detail).toContain("not managed");
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
  const res = checkAuth({ storedToken: true, ghAuthenticated: false, provider: "gh-token" });
  expect(res.group).toBe("auth");
  expect(res.status).toBe("ok");
  expect(res.detail).toContain("stored GitHub token");
  expect(res.detail).toContain("gh-token");
  expect(res.fix).toBeUndefined();
});

test("checkAuth: no stored token but gh authed reports ok (falls back to gh)", () => {
  const res = checkAuth({ storedToken: false, ghAuthenticated: true, provider: "gh-cli" });
  expect(res.status).toBe("ok");
  expect(res.detail).toContain("gh CLI");
});

test("checkAuth: neither stored token nor gh reports warn with the agent auth fix", () => {
  const res = checkAuth({ storedToken: false, ghAuthenticated: false, provider: null });
  expect(res.status).toBe("warn");
  expect(res.detail).toContain("not authenticated");
  expect(res.fix).toBe("agent auth");
});

// --- live (--live) checks ---------------------------------------------------

test("checkCodexLive/checkClaudeLive: ok responds, fail warns, missing skips", () => {
  expect(checkCodexLive({ ran: true, ok: true, cli: "/bin/codex" }).status).toBe("ok");
  const codexFail = checkCodexLive({ ran: true, ok: false, cli: "/bin/codex" });
  expect(codexFail.status).toBe("warn");
  expect(codexFail.fix).toBe("agent codex");
  const codexSkip = checkCodexLive({ ran: false, ok: false, cli: null });
  expect(codexSkip.status).toBe("ok");
  expect(codexSkip.detail).toContain("skipped");

  // When the probe captured output, the full error is surfaced verbatim (no
  // generic "did not answer" placeholder).
  const codexFailWithDetail = checkCodexLive({
    ran: true,
    ok: false,
    cli: "/bin/codex",
    detail: '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
  });
  expect(codexFailWithDetail.status).toBe("warn");
  expect(codexFailWithDetail.detail).toContain("401 Unauthorized");
  expect(codexFailWithDetail.detail).not.toContain("did not answer");

  expect(checkClaudeLive({ ran: true, ok: true, cli: "/bin/claude" }).status).toBe("ok");
  const claudeFail = checkClaudeLive({ ran: true, ok: false, cli: "/bin/claude" });
  expect(claudeFail.status).toBe("warn");
  expect(claudeFail.fix).toBe("agent claude");
  // Claude surfaces the full captured error too (symmetric with codex).
  const claudeFailWithDetail = checkClaudeLive({
    ran: true,
    ok: false,
    cli: "/bin/claude",
    detail: "API Error: 401 invalid x-api-key",
  });
  expect(claudeFailWithDetail.detail).toContain("401 invalid x-api-key");
  expect(claudeFailWithDetail.detail).not.toContain("did not answer");
  expect(checkClaudeLive({ ran: false, ok: false, cli: null }).status).toBe("ok");
});

test("evaluateAll(full) includes the live checks only when their facts are present", () => {
  const facts: HealthFacts = {
    codexLive: { ran: true, ok: true, cli: "/bin/codex" },
    claudeLive: { ran: true, ok: false, cli: "/bin/claude" },
  };
  const ids = evaluateAll("full", facts).map((r) => r.id);
  expect(ids).toContain("codex.live");
  expect(ids).toContain("claude.live");
  // No live facts => no live checks.
  expect(evaluateAll("full", {}).map((r) => r.id)).not.toContain("codex.live");
});

// --- pure sub-evaluators ----------------------------------------------------

test("evalShellFiles detects integration and launcher markers", () => {
  const integration = "# copilot-env shell integration";
  const launchers = "# copilot-env launchers";
  const facts = evalShellFiles([
    { path: "/a", content: `before\n${integration}\nsource x\n` },
    { path: "/b", content: `${launchers}\nsource y\n` },
    { path: "/c", content: null },
  ]);
  expect(facts.integrationWired).toBe(true);
  expect(facts.launchersWired).toBe(true);
  expect(facts.files.find((f) => f.path === "/c")?.hasIntegration).toBe(false);
});

test("evalShellFiles reports unwired when no markers present", () => {
  const facts = evalShellFiles([{ path: "/a", content: "export FOO=1\n" }]);
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
  const good = `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:4141/v1"\nenv_key = "OPENAI_API_KEY"\n`;
  const stalePort = `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:9999/v1"\nenv_key = "OPENAI_API_KEY"\n`;
  const wrongEnvKey = `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:4141/v1"\nenv_key = "COPILOT_API_KEY"\n`;
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
  const direct = `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "https://api.githubcopilot.com"\n`;
  expect(evalCodex("/c", direct, null, 4141, false)).toMatchObject({
    providerMode: "direct",
    providerWired: true,
    tokenAvailable: false,
  });
});

test("evalCodex: a port that only appears as a substring does not match", () => {
  // base_url port 41410 must NOT satisfy expected port 4141 (old substring bug).
  const decoy = `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:41410/v1"\nenv_key = "OPENAI_API_KEY"\n`;
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
  const good = `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "http://localhost:4141/v1"\nenv_key = "OPENAI_API_KEY"\n`;
  expect(evalCodex("/c", good, "OPENAI_API_KEY = sk-test\n", 4141, false).envKeyInDotenv).toBe(
    true,
  );
});

test("checkCodexHost: active ok, active-missing warns, built/unbuilt informational", () => {
  const host = { supported: true, hostHome: "/h/.codex/hosts/box", exists: true, active: true };
  const active = checkCodexHost(host);
  expect(active.status).toBe("ok");
  expect(active.detail).toContain("active per-host");
  expect(active.detail).toContain(`config.toml: ${join(host.hostHome, "config.toml")}`);
  expect(active.value?.configFile).toBe(join(host.hostHome, "config.toml"));
  const activeMissing = checkCodexHost({ ...host, exists: false });
  expect(activeMissing.status).toBe("warn");
  expect(activeMissing.detail).not.toContain("config.toml:");
  const built = checkCodexHost({ ...host, active: false });
  expect(built.detail).toContain("built but not active");
  expect(built.detail).toContain(`config.toml: ${join(host.hostHome, "config.toml")}`);
  const unbuilt = { ...host, active: false, exists: false };
  const unbuiltResult = checkCodexHost(unbuilt);
  expect(unbuiltResult.status).toBe("ok");
  expect(unbuiltResult.detail).toBe("not built (optional)");
  expect(unbuiltResult.detail).not.toContain(host.hostHome);
  expect(unbuiltResult.detail).not.toContain("config.toml:");
  const unsupported = checkCodexHost({ ...unbuilt, supported: false });
  expect(unsupported.detail).toBe("not built (unsupported on Windows)");
  expect(unsupported.detail).not.toContain(host.hostHome);
  expect(unsupported.detail).not.toContain("config.toml:");
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

  const errored = { ...enabled, lastResult: "error: bun install failed after update" };
  const r = checkAutoupdate(errored);
  expect(r.status).toBe("warn");
  expect(r.fix).toBe("agent update --auto-status");
});

// --- evaluateAll scope filtering --------------------------------------------

test("evaluateAll(runtime) yields exactly the two runtime checks", () => {
  const facts: HealthFacts = { runtime: RUNTIME_OK };
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
    },
    codexHost: { supported: false, hostHome: "/h/.codex/hosts/box", exists: false, active: false },
  };
  const ids = evaluateAll("codex", facts).map((r) => r.id);
  expect(ids).toEqual(["setup.codex"]);
});

test("evaluateAll(full) includes runtime.paths and setup checks", () => {
  const facts: HealthFacts = {
    runtime: RUNTIME_OK,
    bootstrap: BOOTSTRAP_OK,
    proxy: {
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds: 604800,
    },
    shell: { files: [], integrationWired: true, launchersWired: false },
    clis: [{ command: "claude", name: "Claude", resolved: null }],
    tools: { node: "/n", npm: "/m" },
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
    },
    codexHost: { supported: false, hostHome: "/h/.codex/hosts/box", exists: false, active: false },
    claude: {
      home: "/h/.claude",
      settingsPath: "/h/.claude/settings.json",
      settingsExists: false,
      helperPath: null,
      baseUrl: null,
      baseUrlMatches: false,
      providerMode: "none",
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
