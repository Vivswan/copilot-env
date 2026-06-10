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
  checkAutoupdate,
  checkBun,
  checkClaude,
  checkCli,
  checkCliVersion,
  checkCodex,
  checkCodexHost,
  checkGatewayPackage,
  checkLaunchers,
  checkNodeModules,
  checkRuntimePid,
  checkRuntimePort,
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
  paths: {
    home: "/h",
    configFile: "/h/config.json",
    runDir: "/h/.run/x",
    stateFile: "/h/.run/x/.state.json",
    logFile: "/h/.run/x/.log",
    sqliteDb: "/h/.run/x/db.sqlite",
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
    result("runtime.port", "ok", ["full", "gateway", "runtime"]),
    result("setup.shell", "warn", ["full", "setup"]),
    result("setup.codex", "ok", ["full", "setup", "codex"]),
    result("bootstrap.bun", "ok", ["full", "gateway"]),
  ];
  expect(filterByScope(all, "runtime").map((r) => r.id)).toEqual(["runtime.port"]);
  expect(filterByScope(all, "setup").map((r) => r.id)).toEqual(["setup.shell", "setup.codex"]);
  expect(filterByScope(all, "codex").map((r) => r.id)).toEqual(["setup.codex"]);
  expect(filterByScope(all, "gateway").map((r) => r.id)).toEqual(["runtime.port", "bootstrap.bun"]);
  expect(filterByScope(all, "full").map((r) => r.id)).toEqual([
    "runtime.port",
    "setup.shell",
    "setup.codex",
    "bootstrap.bun",
  ]);
});

test("isHealthScope narrows known scopes and rejects others", () => {
  for (const s of ["full", "runtime", "gateway", "setup", "codex", "claude"]) {
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

// --- gateway version checks -------------------------------------------------

test("gateway package: missing and below-floor fail, above-ceiling warns, in-bounds ok", () => {
  expect(
    checkGatewayPackage({
      version: null,
      bounds: { ok: false, reason: "missing", version: null },
      configError: null,
      cooldownSeconds: 604800,
    }).status,
  ).toBe("fail");
  expect(
    checkGatewayPackage({
      version: "1.0.0",
      bounds: { ok: false, reason: "belowFloor", version: "1.0.0", floor: "1.10.0" },
      configError: null,
      cooldownSeconds: 604800,
    }).status,
  ).toBe("fail");
  const above = checkGatewayPackage({
    version: "2.0.0",
    bounds: { ok: false, reason: "aboveCeiling", version: "2.0.0", ceiling: "1.99.0" },
    configError: null,
    cooldownSeconds: 604800,
  });
  expect(above.status).toBe("warn");
  expect(above.fix).toBe("agent update");
  expect(
    checkGatewayPackage({
      version: "1.10.5",
      bounds: { ok: true, version: "1.10.5" },
      configError: null,
      cooldownSeconds: 604800,
    }).status,
  ).toBe("ok");
});

test("gateway package detail shows the float cooldown window", () => {
  const ok = (cooldownSeconds: number | null) =>
    checkGatewayPackage({
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

test("gateway package fails (not throws) when copilot-env.config is unreadable", () => {
  const r = checkGatewayPackage({
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

test("runtime port fails only when unreachable", () => {
  expect(checkRuntimePort(RUNTIME_OK).status).toBe("ok");
  expect(checkRuntimePort({ ...RUNTIME_OK, reachable: false }).status).toBe("fail");
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
  };
  // No config at all -> ok (user never wired Codex).
  expect(checkCodex({ ...wired, configExists: false, providerWired: false }).status).toBe("ok");
  // Fully wired -> ok, multi-line detail: wiring, gateway, then each token source.
  const ok = checkCodex(wired);
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("copilot-env");
  expect(ok.detail).toContain("4141");
  expect(ok.detail).toContain("provider: proxy");
  expect(ok.detail.split("\n")).toHaveLength(5);
  expect(ok.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  expect(ok.detail).toContain(`${join("/c", ".env")}: present`);
  expect(ok.detail).toContain("in environment: absent");
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
  // env_key is not OPENAI_API_KEY.
  const wrongEnvKey = checkCodex({ ...wired, envKeyMatches: false, providerWired: false });
  expect(wrongEnvKey.detail).toContain("env_key");
  expect(wrongEnvKey.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  // provider wired but no token in .env or environment.
  const missingToken = checkCodex({ ...wired, envKeyInDotenv: false, tokenAvailable: false });
  expect(missingToken.detail).toContain("OPENAI_API_KEY");
  expect(missingToken.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  // token only in the environment (not .env) is still wired-ok.
  const fromEnv = checkCodex({
    ...wired,
    envKeyInDotenv: false,
    envKeyInEnviron: true,
    tokenAvailable: true,
  });
  expect(fromEnv.status).toBe("ok");
  expect(fromEnv.detail).toContain("in environment: present");

  const direct = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "github-copilot-direct",
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
    modelProvider: "github-copilot-direct",
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
    modelProvider: "github-copilot-direct",
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
});

test("checkClaude: direct needs gh + managed base URL; proxy/none/other informational", () => {
  const direct: ClaudeFacts = {
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings.json"),
    settingsExists: true,
    apiKeyHelper: join("/h/.claude", "copilot-token.sh"),
    baseUrl: "https://api.githubcopilot.com",
    providerMode: "direct",
    directAuth: { command: "/bin/gh", authenticated: true },
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

  // Direct helper present but the managed base URL was dropped/altered: warn.
  const staleBase = checkClaude({ ...direct, baseUrl: null });
  expect(staleBase.status).toBe("warn");
  expect(staleBase.detail).toContain("(missing)");
  expect(staleBase.fix).toBe("agent setup-claude-config --direct");

  // Proxy: gateway-backed via settings.json (localhost base URL + gateway helper).
  const proxy = checkClaude({
    ...direct,
    apiKeyHelper: join("/h/.claude", "copilot-gateway-token.sh"),
    baseUrl: "http://localhost:4141",
    providerMode: "proxy",
    directAuth: { command: null, authenticated: false },
  });
  expect(proxy.status).toBe("ok");
  expect(proxy.detail).toContain("provider: proxy");
  expect(proxy.detail).toContain("ANTHROPIC_BASE_URL → http://localhost:4141");
  expect(proxy.detail).toContain("apiKeyHelper → ");

  // Never configured: informational; cl defaults it to the gateway.
  const none = checkClaude({
    ...direct,
    settingsExists: false,
    apiKeyHelper: null,
    baseUrl: null,
    providerMode: "none",
    directAuth: { command: null, authenticated: false },
  });
  expect(none.status).toBe("ok");
  expect(none.detail).toContain("provider: none");
  expect(none.detail).toContain("not configured");

  // Custom apiKeyHelper the user set — left alone, reported informationally.
  const other = checkClaude({
    ...direct,
    apiKeyHelper: "/opt/x/helper.sh",
    baseUrl: null,
    providerMode: "other",
  });
  expect(other.status).toBe("ok");
  expect(other.detail).toContain("provider: other");
  expect(other.detail).toContain("not managed");
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
  const direct = `model_provider = "github-copilot-direct"\n[model_providers.github-copilot-direct]\nbase_url = "https://api.githubcopilot.com"\n`;
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
    gateway: {
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
    },
    codexHost: { supported: false, hostHome: "/h/.codex/hosts/box", exists: false, active: false },
    claude: {
      home: "/h/.claude",
      settingsPath: "/h/.claude/settings.json",
      settingsExists: false,
      apiKeyHelper: null,
      baseUrl: null,
      providerMode: "none",
      directAuth: { command: null, authenticated: false },
    },
    autoupdate: { enabled: false, cooldownDays: 7, lastCheckMs: 0, lastResult: "" },
  };
  const ids = evaluateAll("full", facts).map((r) => r.id);
  expect(ids).toContain("runtime.paths");
  expect(ids).toContain("setup.cli.claude");
  expect(ids).toContain("gateway.package");
  expect(ids).toContain("setup.codex-host");
  expect(ids).toContain("setup.claude");
  expect(ids).toContain("setup.autoupdate");
});
