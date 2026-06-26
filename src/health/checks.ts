// Pure evaluators: HealthFacts -> CheckResult[]. No I/O -- every input is a fact
// gathered by probe.ts, so each check is independently unit-testable.
import { join } from "node:path";
import type { AutoupdateData } from "../autoupdate/state.ts";
import { DIRECT_BASE_URL } from "../claude/config.ts";
import type { ProxyVersionStatus } from "../copilot_api/version.ts";
import { formatDuration, SECONDS_PER_DAY } from "../utils/time.ts";
import { filterByScope } from "./aggregate.ts";
import type {
  AuthFacts,
  BootstrapFacts,
  ClaudeFacts,
  CliFacts,
  CodexDirectAuthFacts,
  CodexFacts,
  CodexHostFacts,
  HealthFacts,
  LiveProbeFacts,
  ProxyFacts,
  RuntimeFacts,
  ShellFacts,
} from "./probe.ts";
import type { CheckResult, HealthScope } from "./types.ts";
import {
  AUTH_SCOPES as AUTH,
  BOOTSTRAP_SCOPES as BOOTSTRAP,
  CLAUDE_SCOPES as CLAUDE,
  CODEX_SCOPES as CODEX,
  RUNTIME_SCOPES as RUNTIME,
  SETUP_SCOPES as SETUP,
} from "./types.ts";

/**
 * The gh-auth status shared by Codex and Claude Direct (gh-backed) checks: both
 * mint the bearer via `gh auth token`. Returns whether it's usable, a one-line
 * detail, and the gh-specific fix. Callers wrap `ghFix` in their own fix
 * selection (e.g. a base-URL/provider fix takes precedence).
 */
function describeDirectGhAuth(a: CodexDirectAuthFacts): {
  ok: boolean;
  detail: string;
  ghFix: string;
} {
  return {
    ok: a.command !== null && a.authenticated,
    detail:
      a.command === null
        ? "gh auth: GitHub CLI not found"
        : a.authenticated
          ? `gh auth: authenticated via ${a.command}`
          : `gh auth: ${a.command} is not authenticated`,
    ghFix: a.command === null ? "install gh and run gh auth login" : "gh auth login",
  };
}

/**
 * The shared direct-mode auth verdict for `checkCodex`/`checkClaude`: an identical
 * three-way decision (stored token -> gh-cli -> no credential resolves) over the same
 * facts. `wiringOk` is each agent's "rest of the wiring is correct" signal (Codex:
 * `providerWired`; Claude: base URL matches) and `directFix` is its `agent <cli> --direct`
 * repair hint. Returns the status, the auth detail line, and a fix that is present iff the
 * status is "warn" (every warn path has a fix; the ok path has none). Each check wraps this
 * with its own provider/base-url header lines.
 */
function directAuthVerdict(
  f: { directUsesToken: boolean; provider?: string | null; directAuth: CodexDirectAuthFacts },
  wiringOk: boolean,
  directFix: string,
): { status: "ok" | "warn"; authLine: string; fix?: string } {
  if (f.directUsesToken) {
    return {
      status: wiringOk ? "ok" : "warn",
      authLine: "auth: stored GitHub token (agent auth --get, no gh CLI)",
      ...(wiringOk ? {} : { fix: directFix }),
    };
  }
  if (f.provider === "gh-cli") {
    const { ok: authOk, detail: authDetail, ghFix } = describeDirectGhAuth(f.directAuth);
    const ok = wiringOk && authOk;
    return {
      status: ok ? "ok" : "warn",
      authLine: authDetail,
      ...(ok ? {} : { fix: wiringOk ? ghFix : directFix }),
    };
  }
  return {
    status: "warn",
    authLine: "auth: no credential resolves via `agent auth --get` — run `agent auth`",
    fix: wiringOk ? "agent auth" : directFix,
  };
}

export function checkCliVersion(f: BootstrapFacts): CheckResult {
  return {
    id: "bootstrap.version",
    label: "copilot-env version",
    group: "bootstrap",
    scopes: BOOTSTRAP,
    status: "ok",
    detail: f.cliVersion,
    value: { version: f.cliVersion },
  };
}

export function checkBun(f: BootstrapFacts): CheckResult {
  const { available, version } = f.bun;
  return {
    id: "bootstrap.bun",
    label: "Bun runtime",
    group: "bootstrap",
    scopes: BOOTSTRAP,
    status: available ? "ok" : "fail",
    detail: available ? `bun ${version ?? "?"}` : "Bun runtime not detected",
    ...(available ? {} : { fix: "install Bun (https://bun.sh)" }),
    value: { available, version },
  };
}

export function checkNodeModules(f: BootstrapFacts): CheckResult {
  const { present, fresh } = f.nodeModules;
  const status = !present ? "fail" : !fresh ? "warn" : "ok";
  const detail = !present
    ? "node_modules is missing"
    : !fresh
      ? "node_modules is stale (older than bun.lock)"
      : "installed and up to date";
  return {
    id: "bootstrap.nodeModules",
    label: "Dependencies (node_modules)",
    group: "bootstrap",
    scopes: BOOTSTRAP,
    status,
    detail,
    ...(status === "ok" ? {} : { fix: "bun install --frozen-lockfile" }),
    value: { present, fresh },
  };
}

export function checkProxyPackage(f: ProxyFacts): CheckResult {
  // A config that couldn't be read means we can't judge bounds -- surface that
  // as the failure rather than letting the exception escape the report.
  if (f.configError !== null || f.bounds === null) {
    return {
      id: "proxy.package",
      label: "Proxy package",
      group: "proxy",
      scopes: BOOTSTRAP,
      status: "fail",
      detail: `could not read copilot-env.config: ${f.configError ?? "unknown error"}`,
      fix: "check copilot-env.config",
      value: { version: f.version, configError: f.configError },
    };
  }
  const bounds: ProxyVersionStatus = f.bounds;
  let status: CheckResult["status"];
  let detail: string;
  let fix: string | undefined;
  if (bounds.ok) {
    status = "ok";
    // Version + cooldown as separate lines -> rendered as `-` sub-items.
    detail = `@jeffreycao/copilot-api ${bounds.version}\nfloat ${floatCooldownLabel(f.cooldownSeconds)}`;
  } else if (bounds.reason === "missing") {
    status = "fail";
    detail = "@jeffreycao/copilot-api is not installed";
    fix = "bun install --frozen-lockfile";
  } else if (bounds.reason === "belowFloor") {
    status = "fail";
    detail = `proxy ${bounds.version} is below the floor ${bounds.floor}`;
    fix = "bun install --frozen-lockfile";
  } else {
    status = "warn";
    detail = `proxy ${bounds.version} is above the ceiling ${bounds.ceiling}`;
    fix = "agent update";
  }
  return {
    id: "proxy.package",
    label: "Proxy package",
    group: "proxy",
    scopes: BOOTSTRAP,
    status,
    detail,
    ...(fix ? { fix } : {}),
    value: { version: f.version, cooldownSeconds: f.cooldownSeconds },
  };
}

/** Human label for the proxy float cooldown window (seconds, null = unknown). */
function floatCooldownLabel(seconds: number | null): string {
  if (seconds === null) return "cooldown: unknown";
  if (seconds === 0) return "no cooldown";
  if (seconds % SECONDS_PER_DAY === 0) return `cooldown ${seconds / SECONDS_PER_DAY}d`;
  return `cooldown ${seconds}s`;
}

export function checkRuntimePort(f: RuntimeFacts): CheckResult {
  const base = {
    id: "runtime.port",
    label: "Proxy port reachable",
    group: "runtime" as const,
    scopes: RUNTIME,
  };
  // Both agents direct => no proxy needed, so a down proxy is not a failure.
  if (!f.reachable && f.bothDirect) {
    return {
      ...base,
      status: "ok",
      detail: `proxy not running on port ${f.port}; not required (Codex + Claude are both direct)`,
      value: { port: f.port, reachable: f.reachable, bothDirect: true },
    };
  }
  return {
    ...base,
    status: f.reachable ? "ok" : "fail",
    detail: f.reachable ? `listening on port ${f.port}` : `nothing reachable on port ${f.port}`,
    ...(f.reachable ? {} : { fix: "agent start" }),
    value: { port: f.port, reachable: f.reachable },
  };
}

export function checkRuntimePid(f: RuntimeFacts): CheckResult {
  const tracked = f.pidTracked;
  const base = {
    id: "runtime.pid",
    label: "Tracked proxy process",
    group: "runtime" as const,
    scopes: RUNTIME,
  };
  let detail: string;
  if (f.trackedPid === null) {
    detail = "no tracked copilot-api pid";
  } else if (tracked) {
    detail = `tracked copilot-api pid ${f.trackedPid}`;
  } else {
    detail = `tracked pid ${f.trackedPid} is stale or foreign`;
  }
  // Both agents direct => no proxy needed, so a missing tracked pid is fine.
  if (!tracked && f.bothDirect) {
    return {
      ...base,
      status: "ok",
      detail: `${detail}; not required (Codex + Claude are both direct)`,
      value: { pid: f.trackedPid, tracked, alive: f.pidAlive, bothDirect: true },
    };
  }
  return {
    ...base,
    status: tracked ? "ok" : "fail",
    detail,
    ...(tracked ? {} : { fix: "agent start" }),
    value: { pid: f.trackedPid, tracked, alive: f.pidAlive },
  };
}

export function checkRuntimePaths(f: RuntimeFacts): CheckResult {
  // Multi-line detail: report.ts indents each line so state/log sit on their own.
  return {
    id: "runtime.paths",
    label: "Paths",
    group: "runtime",
    scopes: ["full"],
    status: "ok",
    detail: `state ${f.paths.stateFile}\nlog ${f.paths.logFile}`,
    value: { ...f.paths },
  };
}

export function checkRuntimeWatchdog(f: RuntimeFacts): CheckResult {
  const w = f.watchdog;
  // Scoped to full + proxy, NOT the launchers' fast `runtime` probe (this is informational and
  // reads the config + log mtime). Always "ok": it reports state, it never fails a run.
  const base = {
    id: "runtime.watchdog",
    label: "Idle watchdog",
    group: "runtime" as const,
    scopes: ["full", "proxy"] as const,
    status: "ok" as const,
  };
  if (!w.autoStart) {
    return {
      ...base,
      detail: "off (auto-start false) -- no auto-start, no auto-stop",
      value: { autoStart: false },
    };
  }
  if (w.idleTimeoutMs <= 0) {
    return {
      ...base,
      detail: "on; idle auto-stop disabled (idle-timeout 0) -- stays up until `agent stop`",
      value: { autoStart: true, idleTimeoutMs: 0 },
    };
  }
  // The in-daemon watchdog treats activity as the most recent of the heartbeat and the proxy
  // log mtime; mirror that here. With neither recorded yet, idle/remaining are unknown -- the
  // daemon's real baseline also includes a startedAtMs the probe cannot see, so don't fake a
  // precise full-window remaining.
  const lastActivity = Math.max(w.lastEnsureAt ?? 0, w.logMtimeMs ?? 0);
  const idleMs = lastActivity > 0 ? Math.max(0, w.now - lastActivity) : null;
  const remainingMs = idleMs === null ? null : Math.max(0, w.idleTimeoutMs - idleMs);
  const ago = (at: number | null): string =>
    at === null ? "none" : `${formatDuration(w.now - at)} ago`;
  const detail = [
    `auto-stops in ${remainingMs === null ? "unknown" : formatDuration(remainingMs)} (idle window ${formatDuration(w.idleTimeoutMs)})`,
    `idle for ${idleMs === null ? "unknown (no activity recorded yet)" : formatDuration(idleMs)}`,
    `last beat ${ago(w.lastEnsureAt)}`,
    `last request ${ago(w.logMtimeMs)}`,
  ].join("\n");
  return {
    ...base,
    detail,
    value: {
      autoStart: true,
      idleTimeoutMs: w.idleTimeoutMs,
      lastEnsureAt: w.lastEnsureAt,
      logMtimeMs: w.logMtimeMs,
      idleMs,
      remainingMs,
    },
  };
}

export function checkShellIntegration(f: ShellFacts): CheckResult {
  return {
    id: "setup.shell",
    label: "Shell integration",
    group: "setup",
    scopes: SETUP,
    status: f.integrationWired ? "ok" : "warn",
    detail: f.integrationWired
      ? "wired into a shell rc/profile"
      : "not wired into any shell rc/profile",
    ...(f.integrationWired ? {} : { fix: "agent shell" }),
    value: { integrationWired: f.integrationWired, files: f.files },
  };
}

export function checkLaunchers(f: ShellFacts): CheckResult {
  return {
    id: "setup.launchers",
    label: "Launchers (cl/co/cx)",
    group: "setup",
    scopes: SETUP,
    status: f.launchersWired ? "ok" : "warn",
    detail: f.launchersWired ? "wired into a shell rc/profile" : "not wired (optional)",
    ...(f.launchersWired ? {} : { fix: "agent shell --launchers" }),
    value: { launchersWired: f.launchersWired },
  };
}

export function checkCli(c: CliFacts): CheckResult {
  const present = c.resolved !== null;
  return {
    id: `setup.cli.${c.command}`,
    label: `${c.name} (${c.command})`,
    group: "setup",
    scopes: SETUP,
    status: present ? "ok" : "warn",
    detail: present ? (c.resolved as string) : "not installed (optional)",
    ...(present ? {} : { fix: "agent shell --clis" }),
    value: { command: c.command, resolved: c.resolved },
  };
}

export function checkTool(name: "node" | "npm", resolved: string | null): CheckResult {
  const present = resolved !== null;
  return {
    id: `setup.tool.${name}`,
    label: name,
    group: "setup",
    scopes: SETUP,
    status: present ? "ok" : "warn",
    detail: present ? resolved : "not installed (optional)",
    ...(present ? {} : { fix: "agent shell --clis" }),
    value: { resolved },
  };
}

export function checkAuth(f: AuthFacts): CheckResult {
  const base = {
    id: "setup.auth",
    label: "Authentication",
    group: "auth" as const,
    scopes: AUTH,
    value: { storedToken: f.storedToken, ghAuthenticated: f.ghAuthenticated, provider: f.provider },
  };
  // Provider-driven, matching `Credential.resolve()`: no provider => not auth (no
  // implicit gh fallback); gh-cli resolves via gh; copilot/gh-token via the stored
  // token. A chosen-but-unresolved provider is a warn, not OK.
  if (f.provider === null) {
    return {
      ...base,
      status: "warn",
      detail: [
        "not authenticated: no credential provider is configured",
        "run `agent auth` (Direct won't work; the proxy can still device-login on `agent start`)",
      ].join("\n"),
      fix: "agent auth",
    };
  }
  const resolves = f.provider === "gh-cli" ? f.ghAuthenticated : f.storedToken;
  if (resolves) {
    const how = f.provider === "gh-cli" ? "gh CLI (`gh auth token`)" : "stored GitHub token";
    return {
      ...base,
      status: "ok",
      detail: [
        `credential: ${how} (provider: ${f.provider})`,
        "resolved by `agent auth --get` for Direct; passed to the proxy on `agent start`",
      ].join("\n"),
    };
  }
  return {
    ...base,
    status: "warn",
    detail: [
      `provider '${f.provider}' is selected but no credential resolves`,
      f.provider === "gh-cli"
        ? "`gh` is unauthenticated — run `gh auth login`, or `agent auth` to switch provider"
        : "the stored token is missing — run `agent auth` to re-provision",
    ].join("\n"),
    fix: "agent auth",
  };
}

export function checkCodex(f: CodexFacts): CheckResult {
  const configPath = join(f.home, "config.toml");
  const base = {
    id: "setup.codex",
    label: "Codex wiring",
    group: "codex" as const,
    scopes: CODEX,
    value: {
      home: f.home,
      configFile: configPath,
      configExists: f.configExists,
      modelProvider: f.modelProvider,
      providerMode: f.providerMode,
      baseUrl: f.baseUrl,
      providerWired: f.providerWired,
      envFilePresent: f.envFilePresent,
      envKeyInDotenv: f.envKeyInDotenv,
      envKeyInEnviron: f.envKeyInEnviron,
      tokenAvailable: f.tokenAvailable,
      directAuth: f.directAuth,
      directUsesToken: f.directUsesToken,
    },
  };
  // No config at the effective CODEX_HOME: the user hasn't wired Codex -- fine.
  if (!f.configExists) {
    return {
      ...base,
      status: "ok",
      detail: `provider: none\nno Codex config at ${configPath} (not wired)`,
    };
  }
  if (f.providerMode === "direct") {
    // A stored token means the resolver (`agent auth --get`) needs no `gh`; wiring
    // alone decides. Otherwise it falls back to `gh auth token`, which must work.
    const verdict = directAuthVerdict(f, f.providerWired, "agent codex --direct");
    return {
      ...base,
      status: verdict.status,
      detail: [
        "provider: direct",
        `config.toml: ${configPath}`,
        `model_provider ${f.modelProvider ?? "(unset)"} (direct) → ${f.baseUrl ?? "(missing)"}`,
        verdict.authLine,
      ].join("\n"),
      ...(verdict.fix ? { fix: verdict.fix } : {}),
    };
  }
  // Config exists: report precisely which part of the wiring is off.
  const withConfigPath = (message: string) => `config.toml: ${configPath}\n${message}`;
  let detail: string | null = null;
  if (!f.providerSelected) {
    detail = [
      `provider: ${f.providerMode}`,
      withConfigPath(`model_provider is ${f.modelProvider ?? "unset"}, not "copilot-env"`),
    ].join("\n");
  } else if (!f.baseUrlMatches) {
    detail = [
      "provider: proxy",
      withConfigPath(`copilot-env base_url ${f.baseUrl ?? "(missing)"} is not the running proxy`),
    ].join("\n");
  } else if (!f.providerWired) {
    // Selected + base_url ok, but not fully wired: the managed proxy auth.command
    // (the shared proxy-token resolver, which ensures the proxy is up then prints its key)
    // is missing/foreign, and there's no legacy env_key token either.
    detail = [
      "provider: proxy",
      withConfigPath("copilot-env proxy is not fully wired — run `agent codex --proxy`"),
    ].join("\n");
  }
  if (detail !== null) {
    return { ...base, status: "warn", detail, fix: "agent codex --proxy" };
  }
  // Fully wired: the proxy resolves its key at runtime via the managed auth.command (the
  // proxy-token resolver, which ensures the proxy when the lifecycle is on), so there's no
  // baked token to report.
  const detailLines = [
    "provider: proxy",
    `config.toml: ${configPath}`,
    `model_provider copilot-env → ${f.baseUrl}`,
    "auth: local proxy key via the proxy-token resolver",
  ];
  return { ...base, status: "ok", detail: detailLines.join("\n") };
}

/** Report the per-host CODEX_HOME farm (~/.codex/hosts/<hostname>) status. */
export function checkCodexHost(f: CodexHostFacts): CheckResult {
  const configFile = join(f.hostHome, "config.toml");
  const detail = (summary: string) =>
    f.exists ? `${summary}\nconfig.toml: ${configFile}` : summary;
  const base = {
    id: "setup.codex-host",
    label: "Per-host CODEX_HOME",
    group: "codex" as const,
    scopes: SETUP,
    value: {
      supported: f.supported,
      hostHome: f.hostHome,
      configFile,
      exists: f.exists,
      active: f.active,
    },
  };
  // Active per-host home whose directory vanished is a real inconsistency.
  if (f.active && !f.exists) {
    return {
      ...base,
      status: "warn",
      detail: detail(`active CODEX_HOME ${f.hostHome} does not exist on disk`),
      fix: "agent codex --host",
    };
  }
  if (f.active) {
    return { ...base, status: "ok", detail: detail(`active per-host CODEX_HOME: ${f.hostHome}`) };
  }
  if (f.exists) {
    return {
      ...base,
      status: "ok",
      detail: detail(`built but not active (using another CODEX_HOME): ${f.hostHome}`),
    };
  }
  // Not built. Informational -- it's an optional feature (Linux/macOS only).
  const why = f.supported ? "not built (optional)" : "not built (unsupported on Windows)";
  return { ...base, status: "ok", detail: why };
}

/** Report Claude Code wiring (~/.claude/settings.json): direct / proxy / custom. */
export function checkClaude(f: ClaudeFacts): CheckResult {
  const base = {
    id: "setup.claude",
    label: "Claude wiring",
    group: "claude" as const,
    scopes: CLAUDE,
    value: {
      home: f.home,
      settingsFile: f.settingsPath,
      settingsExists: f.settingsExists,
      providerMode: f.providerMode,
      apiKeyHelper: f.helperPath,
      baseUrl: f.baseUrl,
      directAuth: f.directAuth,
      directUsesToken: f.directUsesToken,
    },
  };
  if (f.providerMode === "direct") {
    const baseOk = f.baseUrl === DIRECT_BASE_URL;
    // A stored token means the resolver (`agent auth --get`) needs no `gh`; only
    // the base URL must be right. Otherwise it falls back to `gh auth token`.
    const verdict = directAuthVerdict(f, baseOk, "agent claude --direct");
    const baseUrlLine = `ANTHROPIC_BASE_URL → ${f.baseUrl ?? "(missing)"}${
      baseOk ? "" : ` (expected ${DIRECT_BASE_URL})`
    }`;
    return {
      ...base,
      status: verdict.status,
      detail: [
        "provider: direct",
        `settings.json: ${f.settingsPath}`,
        baseUrlLine,
        verdict.authLine,
      ].join("\n"),
      ...(verdict.fix ? { fix: verdict.fix } : {}),
    };
  }
  if (f.providerMode === "proxy") {
    // Proxy-backed via settings.json (apiKeyHelper prints the proxy token,
    // base URL points at localhost). Runtime reachability is the proxy check's
    // job; here we just confirm the wiring is present.
    return {
      ...base,
      status: "ok",
      detail: [
        "provider: proxy",
        `settings.json: ${f.settingsPath}`,
        `ANTHROPIC_BASE_URL → ${f.baseUrl ?? "(missing)"}`,
        `apiKeyHelper → ${f.helperPath ?? "(missing)"}`,
      ].join("\n"),
    };
  }
  if (f.providerMode === "other") {
    return {
      ...base,
      status: "ok",
      detail: [
        "provider: other",
        `settings.json: ${f.settingsPath}`,
        `custom apiKeyHelper/ANTHROPIC_BASE_URL set (${f.helperPath ?? f.baseUrl}); not managed`,
      ].join("\n"),
    };
  }
  // none: never configured. `cl` will write proxy wiring on first launch.
  return {
    ...base,
    status: "ok",
    detail: [
      "provider: none",
      `settings.json: ${f.settingsPath}`,
      "not configured; run `agent claude` (or --direct/--proxy)",
    ].join("\n"),
  };
}

/** Report opt-in autoupdate status (mirrors `agent update --auto-status`). */
export function checkAutoupdate(f: AutoupdateData): CheckResult {
  const base = {
    id: "setup.autoupdate",
    label: "Autoupdate",
    group: "setup" as const,
    scopes: SETUP,
    value: {
      enabled: f.enabled,
      cooldownDays: f.cooldownDays,
      lastCheckMs: f.lastCheckMs,
      lastResult: f.lastResult,
    },
  };
  // Always show the full status (enabled, cooldown, last check, last result),
  // whether or not autoupdate is on -- matching `agent update --auto-status`. One
  // fact per line so the report renders them as `-` sub-items.
  const last = f.lastCheckMs > 0 ? new Date(f.lastCheckMs).toISOString() : "never";
  const detail = [
    `status: ${f.enabled ? "enabled" : "disabled"}`,
    `cooldown ${f.cooldownDays}d`,
    `last check ${last}`,
    `last result: ${f.lastResult || "(none)"}`,
  ].join("\n");
  // Surface a recorded self-update error as a warning, but never a hard failure.
  if (f.enabled && f.lastResult.startsWith("error:")) {
    return { ...base, status: "warn", detail, fix: "agent update --auto-status" };
  }
  return { ...base, status: "ok", detail };
}

/**
 * `--live` end-to-end check shared by Codex and Claude: did the agent actually
 * respond via its configured backend? Only the ids/labels/group/scopes/fix differ.
 */
function checkAgentLive(agent: "codex" | "claude", f: LiveProbeFacts): CheckResult {
  const meta =
    agent === "codex"
      ? { id: "codex.live", label: "Codex live prompt", group: "codex" as const, scopes: CODEX }
      : {
          id: "claude.live",
          label: "Claude live prompt",
          group: "claude" as const,
          scopes: CLAUDE,
        };
  const base = {
    id: meta.id,
    label: meta.label,
    group: meta.group,
    scopes: meta.scopes,
    value: { ran: f.ran, ok: f.ok, cli: f.cli },
  };
  if (!f.ran) {
    return { ...base, status: "ok", detail: `skipped (${agent} CLI not installed)` };
  }
  return f.ok
    ? { ...base, status: "ok", detail: `read-only prompt responded via ${f.cli}` }
    : {
        ...base,
        status: "warn",
        detail: `read-only prompt failed (${f.cli})${
          f.detail ? `\n${f.detail}` : "; the configured backend did not answer"
        }`,
        fix: `agent ${agent}`,
      };
}

/** `--live` end-to-end check: did Codex actually respond via its configured backend? */
export function checkCodexLive(f: LiveProbeFacts): CheckResult {
  return checkAgentLive("codex", f);
}
export function checkClaudeLive(f: LiveProbeFacts): CheckResult {
  return checkAgentLive("claude", f);
}

/** Build every check applicable to `scope` from the gathered facts. */
export function evaluateAll(scope: HealthScope, facts: HealthFacts): CheckResult[] {
  const out: CheckResult[] = [];
  if (facts.bootstrap) {
    out.push(
      checkCliVersion(facts.bootstrap),
      checkBun(facts.bootstrap),
      checkNodeModules(facts.bootstrap),
    );
  }
  if (facts.proxy) out.push(checkProxyPackage(facts.proxy));
  if (facts.runtime) {
    out.push(checkRuntimePort(facts.runtime), checkRuntimePid(facts.runtime));
    out.push(checkRuntimePaths(facts.runtime), checkRuntimeWatchdog(facts.runtime));
  }
  if (facts.shell) {
    out.push(checkShellIntegration(facts.shell), checkLaunchers(facts.shell));
  }
  if (facts.clis) {
    for (const c of facts.clis) out.push(checkCli(c));
  }
  if (facts.tools) {
    out.push(checkTool("node", facts.tools.node), checkTool("npm", facts.tools.npm));
  }
  if (facts.auth) out.push(checkAuth(facts.auth));
  if (facts.codex) out.push(checkCodex(facts.codex));
  if (facts.codexLive) out.push(checkCodexLive(facts.codexLive));
  if (facts.codexHost) out.push(checkCodexHost(facts.codexHost));
  if (facts.claude) out.push(checkClaude(facts.claude));
  if (facts.claudeLive) out.push(checkClaudeLive(facts.claudeLive));
  if (facts.autoupdate) out.push(checkAutoupdate(facts.autoupdate));
  // Keep only the checks that participate in `scope` (single source of the rule,
  // shared with the --json path and the unit tests).
  return filterByScope(out, scope);
}
