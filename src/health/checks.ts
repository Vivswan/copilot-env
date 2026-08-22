// Pure evaluators: HealthFacts -> CheckResult[]. No I/O -- every input is a fact
// gathered by probe.ts, so each check is independently unit-testable.
import { DIRECT_BASE_URL } from "../claude/config.ts";
import { codexProviderId } from "../codex/config.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { credentialSource } from "../copilot_api/credential.ts";
import type { AuthProvider } from "../copilot_api/env_state.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { PROXY_PACKAGE_NAME, type ProxyVersionStatus } from "../copilot_api/version.ts";
import { lastActivityMs } from "../scripts/idle_watchdog.ts";
import { formatDuration, SECONDS_PER_DAY } from "../utils/time.ts";
import { filterByScope } from "./aggregate.ts";
import type {
  AuthFacts,
  AutoupdateStatus,
  BootstrapFacts,
  ClaudeFacts,
  CliFacts,
  CodexDirectAuthFacts,
  CodexFacts,
  CodexHostFacts,
  HealthFacts,
  LiveProbeFacts,
  ProfileAuthFacts,
  ProxyFacts,
  RuntimeTarget,
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

/** The `agent start` fix for a runtime target, addressed at its profile. */
function startFix(profile: Profile): string {
  return profile === null ? "agent start" : `agent start --profile ${profile}`;
}

/** The re-wire fix for a NAMED profile (mode is sticky from the store on a re-add). */
function profileAddFix(name: ProfileName): string {
  return `agent profile --add ${name}`;
}

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
    detail: a.command === null
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
  f: {
    directUsesToken: boolean;
    provider?: AuthProvider | null;
    directAuth: CodexDirectAuthFacts;
  },
  wiringOk: boolean,
  directFix: string,
  profile: Profile = null,
): { status: "ok" | "warn"; authLine: string; fix?: string } {
  const getCommand = profile === null
    ? "agent auth --get"
    : `agent auth --get --profile ${profile}`;
  const authFix = profile === null ? "agent auth" : `agent auth --profile ${profile}`;
  if (f.directUsesToken) {
    return {
      status: wiringOk ? "ok" : "warn",
      authLine: `auth: stored GitHub token (${getCommand}, no gh CLI)`,
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
    authLine: `auth: no credential resolves via \`${getCommand}\` - run \`${authFix}\``,
    fix: wiringOk ? authFix : directFix,
  };
}

export function checkCliVersion(f: BootstrapFacts): CheckResult {
  return {
    id: "bootstrap.version",
    label: "copilot-env version",
    group: "bootstrap",
    profile: null,
    scopes: BOOTSTRAP,
    status: "ok",
    detail: f.cliVersion,
    value: { version: f.cliVersion },
  };
}

export function checkDeno(f: BootstrapFacts): CheckResult {
  const { available, version } = f.deno;
  return {
    id: "bootstrap.deno",
    label: "Deno runtime",
    group: "bootstrap",
    profile: null,
    scopes: BOOTSTRAP,
    status: available ? "ok" : "fail",
    detail: available ? `deno ${version ?? "?"}` : "Deno runtime not detected",
    ...(available ? {} : { fix: "install Deno (https://deno.com)" }),
    value: { available, version },
  };
}

export function checkNodeModules(f: BootstrapFacts): CheckResult {
  const { present, fresh } = f.nodeModules;
  const status = !present ? "fail" : !fresh ? "warn" : "ok";
  const detail = !present
    ? "node_modules is missing"
    : !fresh
    ? "node_modules is stale (older than the lockfile)"
    : "installed and up to date";
  return {
    id: "bootstrap.nodeModules",
    label: "Dependencies (node_modules)",
    group: "bootstrap",
    profile: null,
    scopes: BOOTSTRAP,
    status,
    detail,
    ...(status === "ok" ? {} : { fix: "deno install --frozen" }),
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
      profile: null,
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
    detail = `${PROXY_PACKAGE_NAME} ${bounds.version}\nfloat ${
      floatCooldownLabel(f.cooldownSeconds)
    }`;
  } else if (bounds.reason === "missing") {
    // A missing package is a broken install in any mode; the fix always works.
    status = "fail";
    detail = `${PROXY_PACKAGE_NAME} is not installed`;
    fix = "deno install --frozen";
  } else if (bounds.reason === "belowFloor") {
    status = "fail";
    detail = `proxy ${bounds.version} is below the floor ${bounds.floor}`;
    fix = "deno install --frozen";
  } else {
    status = "warn";
    detail = `proxy ${bounds.version} is above the ceiling ${bounds.ceiling}`;
    fix = "agent update";
  }
  let exempted = false;
  if (!bounds.ok && bounds.reason !== "missing" && f.floatSkips) {
    // The float itself skips (proxyFloatSkips: proxy unused, no env pin), so
    // the bounds are unenforceable -- the suggested fixes would not move the
    // version -- and must not read as a failure. A proxy rewire (or a proxy
    // profile) re-enables the float, which enforces them again.
    exempted = true;
    status = "ok";
    detail = `${detail}; not enforced (Codex + Claude are both direct, so the proxy float skips)`;
    fix = undefined;
  }
  return {
    id: "proxy.package",
    label: "Proxy package",
    group: "proxy",
    profile: null,
    scopes: BOOTSTRAP,
    status,
    detail,
    ...(fix ? { fix } : {}),
    // floatSkips is stamped only when it changed the verdict, mirroring the
    // runtime checks' bothDirect stamp, so --json consumers can tell
    // "in bounds" from "out of bounds but exempted".
    value: {
      version: f.version,
      cooldownSeconds: f.cooldownSeconds,
      ...(exempted ? { floatSkips: true } : {}),
    },
  };
}

/** Human label for the proxy float cooldown window (seconds, null = unknown). */
function floatCooldownLabel(seconds: number | null): string {
  if (seconds === null) return "cooldown: unknown";
  if (seconds === 0) return "no cooldown";
  if (seconds % SECONDS_PER_DAY === 0) return `cooldown ${seconds / SECONDS_PER_DAY}d`;
  return `cooldown ${seconds}s`;
}

/**
 * The float's resolved-version record and the cache it points at -- the pair the daemon
 * actually launches from. Absent, the deno.json baseline in node_modules runs instead,
 * which is a working fallback rather than a failure; a record whose cache has gone
 * missing is not (the launch asks for that exact version offline and would fail).
 */
export function checkProxyResolved(f: ProxyFacts): CheckResult {
  const base = {
    id: "proxy.resolved",
    label: "Proxy resolved + cached",
    group: "proxy" as const,
    profile: null,
    scopes: BOOTSTRAP,
  };
  const resolved = f.resolved;
  if (resolved === null) {
    return {
      ...base,
      status: "ok",
      detail: f.floatSkips
        ? "not floated; Codex + Claude are both direct, so the proxy is unused"
        : "not floated yet; the deno.json baseline would run instead",
      value: { resolved: false },
    };
  }
  if (!resolved.cached) {
    return {
      ...base,
      status: "fail",
      detail: `${PROXY_PACKAGE_NAME} ${resolved.version} is recorded, but its cache ` +
        `${resolved.denoDir} is missing`,
      fix: "agent start",
      value: { resolved: true, version: resolved.version, cached: false },
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `${PROXY_PACKAGE_NAME} ${resolved.version}\ncached in ${resolved.denoDir}`,
    value: { resolved: true, version: resolved.version, cached: true },
  };
}

export function checkRuntimePort(f: RuntimeTarget): CheckResult {
  const base = {
    id: "runtime.port",
    label: "Proxy port reachable",
    group: "runtime" as const,
    profile: f.profile,
    scopes: RUNTIME,
  };
  // Both agents direct => no agent routes to this port, so neither an empty port
  // nor some unrelated service listening there is a proxy problem.
  if (!f.proxyExpected) {
    return {
      ...base,
      status: "ok",
      detail: f.reachable
        ? `port ${f.port} has a listener, but no agent routes to it (Codex + Claude are both direct)`
        : `proxy not running on port ${f.port}; not required (Codex + Claude are both direct)`,
      value: { port: f.port, reachable: f.reachable, bothDirect: true },
    };
  }
  // Managed lifecycle on => the resolver launches the daemon on demand, so a
  // down daemon is expected between sessions, not a failure.
  if (!f.reachable && f.watchdog.autoStart) {
    return {
      ...base,
      status: "ok",
      detail: `proxy not running on port ${f.port}; starts on demand (auto-start on)`,
      value: { port: f.port, reachable: f.reachable, autoStart: true },
    };
  }
  return {
    ...base,
    status: f.reachable ? "ok" : "fail",
    detail: f.reachable ? `listening on port ${f.port}` : `nothing reachable on port ${f.port}`,
    ...(f.reachable ? {} : { fix: startFix(f.profile) }),
    value: { port: f.port, reachable: f.reachable },
  };
}

export function checkRuntimePid(f: RuntimeTarget): CheckResult {
  const tracked = f.pidTracked;
  const base = {
    id: "runtime.pid",
    label: "Tracked proxy process",
    group: "runtime" as const,
    profile: f.profile,
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
  if (!tracked && !f.proxyExpected) {
    return {
      ...base,
      status: "ok",
      detail: `${detail}; not required (Codex + Claude are both direct)`,
      value: { pid: f.trackedPid, tracked, alive: f.pidAlive, bothDirect: true },
    };
  }
  // Down daemon + managed lifecycle on => it starts on demand; not a failure.
  // Reachable-but-untracked is NOT down (that is runtime.orphan/identity
  // territory), so auto-start never excuses it here.
  if (!tracked && !f.reachable && f.watchdog.autoStart) {
    return {
      ...base,
      status: "ok",
      detail: `${detail}; starts on demand (auto-start on)`,
      value: { pid: f.trackedPid, tracked, alive: f.pidAlive, autoStart: true },
    };
  }
  return {
    ...base,
    status: tracked ? "ok" : "fail",
    detail,
    ...(tracked ? {} : { fix: startFix(f.profile) }),
    value: { pid: f.trackedPid, tracked, alive: f.pidAlive },
  };
}

export function checkRuntimePaths(f: RuntimeTarget): CheckResult {
  // Multi-line detail: report.ts indents each line so state/log sit on their own.
  return {
    id: "runtime.paths",
    label: "Paths",
    group: "runtime",
    profile: f.profile,
    scopes: ["full"],
    status: "ok",
    detail: `state ${f.paths.stateFile}\nlog ${f.paths.logFile}`,
    value: { ...f.paths },
  };
}

export function checkRuntimeWatchdog(f: RuntimeTarget): CheckResult {
  const w = f.watchdog;
  // Scoped to full + proxy, NOT the launchers' fast `runtime` probe (this is informational and
  // reads the config + activity file). Always "ok": it reports state, it never fails a run.
  const base = {
    id: "runtime.watchdog",
    label: "Idle watchdog",
    group: "runtime" as const,
    profile: f.profile,
    scopes: ["full", "proxy"] as const,
    status: "ok" as const,
  };
  if (!f.proxyExpected) {
    // Marks left by an earlier run would render a countdown for a daemon no
    // request will reach.
    return {
      ...base,
      detail: "not required (Codex + Claude are both direct)",
      value: { bothDirect: true },
    };
  }
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
  // The shared activity rule (lastActivityMs, owned by the in-daemon watchdog): the most
  // recent of the heartbeat and the last real model call (the observer's persisted
  // `.activity.json` mark -- liveness GET / pings are NOT activity). With neither recorded
  // yet, idle/remaining are unknown -- the daemon's real baseline also includes a
  // startedAtMs the probe cannot see, so don't fake a precise window.
  const lastActivity = lastActivityMs({ inferenceMs: w.lastRequestMs, ensureAtMs: w.lastEnsureAt });
  const idleMs = lastActivity > 0 ? Math.max(0, w.now - lastActivity) : null;
  const remainingMs = idleMs === null ? null : Math.max(0, w.idleTimeoutMs - idleMs);
  const ago = (at: number | null): string =>
    at === null ? "none" : `${formatDuration(w.now - at)} ago`;
  const detail = [
    `auto-stops in ${remainingMs === null ? "unknown" : formatDuration(remainingMs)} (idle window ${
      formatDuration(w.idleTimeoutMs)
    })`,
    `idle for ${idleMs === null ? "unknown (no activity recorded yet)" : formatDuration(idleMs)}`,
    `last beat ${ago(w.lastEnsureAt)}`,
    `last request ${ago(w.lastRequestMs)}`,
  ].join("\n");
  return {
    ...base,
    detail,
    value: {
      autoStart: true,
      idleTimeoutMs: w.idleTimeoutMs,
      lastEnsureAt: w.lastEnsureAt,
      lastRequestMs: w.lastRequestMs,
      idleMs,
      remainingMs,
    },
  };
}

export function checkRuntimeIdentity(f: RuntimeTarget): CheckResult {
  // Is whatever is reachable on the port actually copilot-api? checkRuntimePort only proves
  // SOMETHING answers; a foreign service squatting the port would read green there while every
  // agent request silently misroutes. Warn-only (never fails a run) and full+proxy scope.
  // The misroute claim presumes something routes to the port: the probe gates on
  // proxyExpected, so a target with no route to the port (both modes direct and no
  // proxy base URL) always arrives here with identityConfirmed null.
  const base = {
    id: "runtime.identity",
    label: "Proxy identity",
    group: "runtime" as const,
    profile: f.profile,
    scopes: ["full", "proxy"] as const,
  };
  if (!f.reachable || f.identityConfirmed === null) {
    // Nothing reachable (runtime.port owns that verdict) or identity not probed.
    const notProbed = !f.proxyExpected
      ? `not probed (no agent routes to port ${f.port}; Codex + Claude are both direct)`
      : "identity not probed";
    return {
      ...base,
      status: "ok",
      detail: f.reachable ? notProbed : `not probed (nothing reachable on port ${f.port})`,
      value: { reachable: f.reachable, confirmed: null },
    };
  }
  if (f.identityConfirmed) {
    return {
      ...base,
      status: "ok",
      detail: `confirmed copilot-api on port ${f.port} (x-trace-id present)`,
      value: { reachable: true, confirmed: true },
    };
  }
  return {
    ...base,
    status: "warn",
    detail:
      `a non-copilot-api service is listening on port ${f.port} (no x-trace-id); agent requests would misroute to it`,
    fix: `free the port (stop the foreign process), then ${startFix(f.profile)}`,
    value: { reachable: true, confirmed: false },
  };
}

export function checkRuntimeOrphan(f: RuntimeTarget): CheckResult {
  // Reconcile the otherwise-contradictory runtime.port (ok: reachable) + runtime.pid (fail: no
  // tracked pid) when both describe the SAME state: copilot-api is on the port but is not the
  // daemon we track. A foreign listener is runtime.identity's verdict, not an "orphan", so we
  // defer that case to avoid double-warning. Pure (no I/O), full+proxy scope.
  const base = {
    id: "runtime.orphan",
    label: "Proxy port ownership",
    group: "runtime" as const,
    profile: f.profile,
    scopes: ["full", "proxy"] as const,
  };
  const foreign = f.identityConfirmed === false;
  const orphan = f.reachable && !f.pidTracked && f.proxyExpected && !foreign;
  if (!orphan) {
    // The detail must not claim the tracked daemon owns the port when identity says the
    // responder is foreign (pidTracked only proves the saved pid is a copilot-api process,
    // not that it owns THIS port) -- defer that wording to runtime.identity.
    let detail: string;
    if (foreign) {
      detail = "port responder is not copilot-api (see proxy identity)";
    } else if (!f.proxyExpected && f.reachable) {
      // SOMETHING is reachable on the port, but both agents are configured direct, so no
      // proxy is required -- the both-direct gate (not the facts) is why this isn't an
      // orphan warning. Say that -- even with a tracked pid alive, since identity is never
      // probed for a both-direct target (proxyExpected gates the probe), nothing here
      // proves who owns the port, and nothing routes to it anyway.
      detail = `a process is on port ${f.port}, but both agents are direct (no proxy required)`;
    } else if (f.reachable && f.pidTracked) {
      detail = "port held by the tracked daemon";
    } else {
      detail = "no untracked copilot-api on the port";
    }
    return { ...base, status: "ok", detail, value: { orphan: false } };
  }
  // Orphan: reachable, untracked, proxy required, not a known-foreign responder. Identity is
  // confirmed copilot-api or indeterminate (probe failed) -- don't over-claim "copilot-api".
  const what = f.identityConfirmed === true ? "copilot-api" : "a process (identity unconfirmed)";
  const stopFix = f.profile === null ? "agent stop" : `agent stop --profile ${f.profile}`;
  return {
    ...base,
    status: "warn",
    detail:
      `${what} is on port ${f.port} but is not the tracked daemon (orphaned -- started outside 'agent start', or the run-state was cleared)`,
    fix: `${stopFix}, then ${startFix(f.profile)} (re-tracks the daemon)`,
    value: { orphan: true, trackedPid: f.trackedPid },
  };
}

/**
 * NAMED targets only: do the profile's two halves -- the store slot (the source
 * of truth for credential + mode) and the on-disk daemon home (derived, proxy
 * mode only) -- agree? A profile is created/deleted atomically by `agent
 * profile`, so a lone half is an interrupted add/del; warn with the command that
 * finishes the job. Never a failure: the profile's own runtime rows own hard
 * verdicts.
 */
export function checkProfileConsistency(f: RuntimeTarget): CheckResult {
  const name = f.profile;
  if (name === null) {
    throw new Error("profile.consistency is a named-target check (default target passed)");
  }
  const slot = f.slot;
  const homeExists = f.homeExists === true;
  const base = {
    id: "profile.consistency",
    label: "Profile consistency",
    group: "runtime" as const,
    profile: name,
    scopes: RUNTIME,
    value: {
      slotExists: slot?.exists === true,
      mode: slot?.mode ?? null,
      homeExists,
    },
  };
  if (slot?.exists !== true) {
    // No slot has no recorded mode, so a re-add must pick one explicitly.
    const fix = `agent profile --add ${name} --direct|--proxy (or agent profile --del ${name})`;
    return homeExists
      ? {
        ...base,
        status: "warn",
        detail: "profile home exists but no store slot (half-created)",
        fix,
      }
      : {
        // Only reachable when the profile vanished between the sweep and this
        // read (its name came from the slots+homes union).
        ...base,
        status: "warn",
        detail: "no store slot and no daemon home (profile no longer exists)",
        fix,
      };
  }
  if (slot.mode === null) {
    return {
      ...base,
      status: "warn",
      detail: "no mode recorded in the store slot (interrupted add)",
      fix: `agent profile --add ${name} --direct|--proxy`,
    };
  }
  if (slot.mode === "proxy" && !homeExists) {
    return {
      ...base,
      status: "warn",
      detail: "proxy profile has no daemon home (wiring incomplete)",
      fix: profileAddFix(name),
    };
  }
  const detail = slot.mode === "proxy"
    ? f.portPersisted
      ? "store slot (proxy) and daemon home agree"
      : `store slot (proxy) and daemon home agree; no port recorded on this host yet, so the daemon was not probed (agent start --profile ${name} records one)`
    : homeExists
    ? "store slot (direct); the leftover daemon home is unused"
    : "store slot (direct); no daemon home needed";
  return { ...base, status: "ok", detail };
}

/**
 * A narrowed run's credential line: the addressed NAMED profile's slot (provider,
 * mode, probed direct identity) plus whether the credential actually RESOLVES --
 * a token in the slot, or a live gh login for a gh-cli slot -- mirroring the
 * default checkAuth's provider-driven verdict. `slot` null means the store
 * carries no slot at all (a half-created, home-only profile). Named profiles
 * hard-fail rather than fall back to the default credential, so a missing or
 * unresolvable credential is a warn here even though the default `setup.auth`
 * might be green.
 */
export function checkProfileAuth(
  name: ProfileName,
  slot: ProfileAuthFacts | null,
  resolution: { storedToken: boolean; ghAuthenticated: boolean },
): CheckResult {
  const base = {
    id: "setup.auth",
    label: "Authentication",
    group: "auth" as const,
    profile: name,
    scopes: AUTH,
    value: {
      provider: slot?.provider ?? null,
      mode: slot?.mode ?? null,
      integrationIdentity: slot?.integrationIdentity ?? null,
      storedToken: resolution.storedToken,
      ghAuthenticated: resolution.ghAuthenticated,
    },
  };
  // A slot with no recorded mode (or none at all) needs an explicit mode flag on
  // the re-add; with a mode recorded the bare re-add keeps it (sticky).
  const addFix = slot === null || slot.mode === null
    ? `agent profile --add ${name} --direct|--proxy`
    : profileAddFix(name);
  if (slot === null || slot.provider === null) {
    return {
      ...base,
      status: "warn",
      detail: [
        `no credential recorded for profile '${name}'`,
        "named profiles never fall back to the default credential",
      ].join("\n"),
      fix: addFix,
    };
  }
  const source = credentialSource(slot.provider, resolution.storedToken);
  const resolves = source === "gh-cli" ? resolution.ghAuthenticated : source === "stored-token";
  if (!resolves) {
    return {
      ...base,
      status: "warn",
      detail: [
        `provider '${slot.provider}' is recorded for profile '${name}' but no credential resolves`,
        slot.provider === "gh-cli"
          ? "`gh` is unauthenticated - run `gh auth login`, or re-provision the profile"
          : `the slot's stored token is missing - run \`agent auth --profile ${name}\` to re-provision`,
      ].join("\n"),
      fix: `agent auth --profile ${name}`,
    };
  }
  const how = slot.provider === "gh-cli" ? "gh CLI (`gh auth token`)" : "stored GitHub token";
  const identity = slot.integrationIdentity === null ? "" : `, ${slot.integrationIdentity}`;
  const usage = slot.mode === "proxy"
    ? `resolved by \`agent auth --get --profile ${name}\`; passed to the profile's daemon on \`agent start --profile ${name}\``
    : slot.mode === "direct"
    ? `resolved by \`agent auth --get --profile ${name}\` for Direct`
    : `resolved by \`agent auth --get --profile ${name}\``;
  return {
    ...base,
    status: "ok",
    detail: [
      `credential: ${how} (provider: ${slot.provider}, mode: ${slot.mode ?? "none"}${identity})`,
      usage,
    ].join("\n"),
  };
}

export function checkShellIntegration(f: ShellFacts): CheckResult {
  return {
    id: "setup.shell",
    label: "Shell integration",
    group: "setup",
    profile: null,
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
    profile: null,
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
    profile: null,
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
    profile: null,
    scopes: SETUP,
    status: present ? "ok" : "warn",
    detail: present ? resolved : "not installed (optional)",
    ...(present ? {} : { fix: "agent shell --clis" }),
    value: { resolved },
  };
}

export function checkAuth(f: AuthFacts): CheckResult {
  // Named profiles surface as a detail line only (their hard-fail resolution is a
  // per-profile concern; the default credential drives this check's status).
  const profileEntries = Object.entries(f.profiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const profilesLine = profileEntries.length === 0 ? [] : [
    `named profiles: ${
      profileEntries
        .map(([name, slot]) => {
          const identity = slot.integrationIdentity ? `, ${slot.integrationIdentity}` : "";
          return `${name} (${slot.provider ?? "no auth"}, ${slot.mode ?? "no mode"}${identity})`;
        })
        .join(", ")
    }`,
  ];
  // The Copilot client identity: a pin overrides the per-credential probe (the knob a
  // fine-grained PAT needs -- copilot-developer-cli -- when auto-detection is off).
  const identityLine = f.pinnedIntegrationId === null ? [] : [
    `Copilot integration id pinned to '${f.pinnedIntegrationId}' (\`agent config integration-id\`)`,
  ];
  const base = {
    id: "setup.auth",
    label: "Authentication",
    group: "auth" as const,
    profile: null,
    scopes: AUTH,
    value: {
      storedToken: f.storedToken,
      ghAuthenticated: f.ghAuthenticated,
      provider: f.provider,
      profiles: f.profiles,
      pinnedIntegrationId: f.pinnedIntegrationId,
    },
  };
  // Provider classification owned by credentialSource() (credential.ts); a
  // chosen-but-unresolved provider is a warn, not OK.
  if (f.provider === null) {
    return {
      ...base,
      status: "warn",
      detail: [
        "not authenticated: no credential provider is configured",
        "run `agent auth` (Direct won't work; the proxy can still device-login on `agent start`)",
        ...profilesLine,
        ...identityLine,
      ].join("\n"),
      fix: "agent auth",
    };
  }
  const source = credentialSource(f.provider, f.storedToken);
  const resolves = source === "gh-cli" ? f.ghAuthenticated : source === "stored-token";
  if (resolves) {
    const how = f.provider === "gh-cli" ? "gh CLI (`gh auth token`)" : "stored GitHub token";
    return {
      ...base,
      status: "ok",
      detail: [
        `credential: ${how} (provider: ${f.provider})`,
        "resolved by `agent auth --get` for Direct; passed to the proxy on `agent start`",
        ...profilesLine,
        ...identityLine,
      ].join("\n"),
    };
  }
  return {
    ...base,
    status: "warn",
    detail: [
      `provider '${f.provider}' is selected but no credential resolves`,
      f.provider === "gh-cli"
        ? "`gh` is unauthenticated - run `gh auth login`, or `agent auth` to switch provider"
        : "the stored token is missing - run `agent auth` to re-provision",
      ...profilesLine,
      ...identityLine,
    ].join("\n"),
    fix: "agent auth",
  };
}

export function checkCodex(f: CodexFacts, profile: Profile = null): CheckResult {
  const configPath = codexConfigPath(f.home);
  // A named profile's whole wiring (both agents, one mode) is (re)written by ONE
  // command, so every named repair points there instead of `agent codex ...`.
  const directFix = profile === null ? "agent codex --direct" : profileAddFix(profile);
  const proxyFix = profile === null ? "agent codex --proxy" : profileAddFix(profile);
  const base = {
    id: "setup.codex",
    label: "Codex wiring",
    group: "codex" as const,
    profile,
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
      // The store-aware "Direct needs no gh" verdict, under the key this JSON
      // report has always used.
      directUsesToken: f.directNeedsNoGh,
    },
  };
  // No config at the effective CODEX_HOME: the user hasn't wired Codex -- fine
  // for the default, but a NAMED profile promises both-agent wiring, so its
  // absence is an interrupted `agent profile --add`.
  if (!f.configExists) {
    if (profile !== null) {
      return {
        ...base,
        status: "warn",
        detail:
          `provider: none\nno Codex config at ${configPath} (profile '${profile}' is not wired into Codex)`,
        fix: profileAddFix(profile),
      };
    }
    return {
      ...base,
      status: "ok",
      detail: `provider: none\nno Codex config at ${configPath} (not wired)`,
    };
  }
  // A NAMED profile's wiring is DERIVED from its store slot's recorded mode; a
  // managed wiring in the OTHER mode is an interrupted rewire (`profile --add`
  // switched the slot but not this agent) and must not read green.
  if (
    profile !== null &&
    f.expectedMode != null &&
    (f.providerMode === "direct" || f.providerMode === "proxy") &&
    f.providerMode !== f.expectedMode
  ) {
    return {
      ...base,
      status: "warn",
      detail: [
        `provider: ${f.providerMode}`,
        `config.toml: ${configPath}`,
        `wired ${f.providerMode}, but the profile's recorded mode is ${f.expectedMode} (out of step with the store slot)`,
      ].join("\n"),
      fix: profileAddFix(profile),
    };
  }
  if (f.providerMode === "direct") {
    // A stored token means the resolver (`agent auth --get`) needs no `gh`; wiring
    // alone decides. Otherwise it falls back to `gh auth token`, which must work.
    const verdict = directAuthVerdict(
      { directUsesToken: f.directNeedsNoGh, provider: f.provider, directAuth: f.directAuth },
      f.providerWired,
      directFix,
      profile,
    );
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
      withConfigPath(
        `model_provider is ${f.modelProvider ?? "unset"}, not "${codexProviderId(profile)}"`,
      ),
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
      withConfigPath(`copilot-env proxy is not fully wired - run \`${proxyFix}\``),
    ].join("\n");
  }
  if (detail !== null) {
    return { ...base, status: "warn", detail, fix: proxyFix };
  }
  // Fully wired: the proxy resolves its key at runtime via the managed auth.command (the
  // proxy-token resolver, which ensures the proxy when the lifecycle is on), so there's no
  // baked token to report.
  const detailLines = [
    "provider: proxy",
    `config.toml: ${configPath}`,
    `model_provider ${codexProviderId(profile)} → ${f.baseUrl}`,
    "auth: local proxy key via the proxy-token resolver",
  ];
  return { ...base, status: "ok", detail: detailLines.join("\n") };
}

/** Report the per-host CODEX_HOME farm (~/.codex/hosts/<hostname>) status. */
export function checkCodexHost(f: CodexHostFacts): CheckResult {
  const configFile = codexConfigPath(f.hostHome);
  const detail = (summary: string) => f.exists ? `${summary}\nconfig.toml: ${configFile}` : summary;
  const base = {
    id: "setup.codex-host",
    label: "Per-host CODEX_HOME",
    group: "codex" as const,
    profile: null,
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

/** Report Claude Code wiring (settings.json, or a named profile's
 *  settings-<name>.json): direct / proxy / custom. */
export function checkClaude(f: ClaudeFacts, profile: Profile = null): CheckResult {
  const directFix = profile === null ? "agent claude --direct" : profileAddFix(profile);
  const base = {
    id: "setup.claude",
    label: "Claude wiring",
    group: "claude" as const,
    profile,
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
  // A NAMED profile's settings file is derived from its slot's recorded mode; a
  // managed wiring in the OTHER mode is an interrupted rewire (see checkCodex).
  if (
    profile !== null &&
    f.expectedMode != null &&
    (f.providerMode === "direct" || f.providerMode === "proxy") &&
    f.providerMode !== f.expectedMode
  ) {
    return {
      ...base,
      status: "warn",
      detail: [
        `provider: ${f.providerMode}`,
        `settings.json: ${f.settingsPath}`,
        `wired ${f.providerMode}, but the profile's recorded mode is ${f.expectedMode} (out of step with the store slot)`,
      ].join("\n"),
      fix: profileAddFix(profile),
    };
  }
  if (f.providerMode === "direct") {
    const baseOk = f.baseUrl === DIRECT_BASE_URL;
    // A stored token means the resolver (`agent auth --get`) needs no `gh`; only
    // the base URL must be right. Otherwise it falls back to `gh auth token`.
    const verdict = directAuthVerdict(f, baseOk, directFix, profile);
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
    // Proxy-backed via settings.json (apiKeyHelper prints the proxy token, base URL points at
    // the local proxy). Runtime reachability is the proxy check's job; here we confirm the
    // wiring is present AND that ANTHROPIC_BASE_URL actually points at the resolved proxy port
    // -- a stale base URL (e.g. after `config port` changed and the daemon rebound) would send
    // Claude to the wrong/absent port, so it must not read green. Mirrors the Codex check.
    // A named profile's repair is its own atomic re-add (which re-reserves and re-bakes).
    const baseUrlOk = f.baseUrl !== null && f.baseUrlMatches;
    return {
      ...base,
      status: baseUrlOk ? "ok" : "warn",
      detail: [
        "provider: proxy",
        `settings.json: ${f.settingsPath}`,
        `ANTHROPIC_BASE_URL → ${f.baseUrl ?? "(missing)"}${
          baseUrlOk ? "" : " (does not match the resolved proxy port)"
        }`,
        `apiKeyHelper → ${f.helperPath ?? "(missing)"}`,
      ].join("\n"),
      ...(baseUrlOk ? {} : {
        fix: profile === null
          ? "Re-run `agent init` (or `agent claude`) to repoint ANTHROPIC_BASE_URL at the current proxy port."
          : `Re-run \`${
            profileAddFix(profile)
          }\` to repoint ANTHROPIC_BASE_URL at the profile's proxy port.`,
      }),
    };
  }
  if (f.providerMode === "other") {
    // Foreign wiring in the DEFAULT settings.json is the user's own business; in
    // a NAMED profile's settings file it is drift -- the profile promises managed
    // wiring, and `profile --add` refuses to overwrite an unmanaged file, so the
    // fix names the removal first.
    if (profile !== null) {
      return {
        ...base,
        status: "warn",
        detail: [
          "provider: other",
          `settings.json: ${f.settingsPath}`,
          `custom apiKeyHelper/ANTHROPIC_BASE_URL set (${
            f.helperPath ?? f.baseUrl
          }); profile '${profile}' expects managed wiring`,
        ].join("\n"),
        fix: `remove ${f.settingsPath} (not managed by copilot-env), then ${
          profileAddFix(profile)
        }`,
      };
    }
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
  // none: never configured. Fine for the default (`cl` writes proxy wiring on
  // first launch); a NAMED profile promises both-agent wiring, so its absence is
  // an interrupted `agent profile --add`.
  if (profile !== null) {
    return {
      ...base,
      status: "warn",
      detail: [
        "provider: none",
        `settings.json: ${f.settingsPath}`,
        `profile '${profile}' is not wired into Claude`,
      ].join("\n"),
      fix: profileAddFix(profile),
    };
  }
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
export function checkAutoupdate(f: AutoupdateStatus): CheckResult {
  const base = {
    id: "setup.autoupdate",
    label: "Autoupdate",
    group: "setup" as const,
    profile: null,
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
function checkAgentLive(
  agent: "codex" | "claude",
  f: LiveProbeFacts,
  profile: Profile = null,
): CheckResult {
  const meta = agent === "codex"
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
    profile,
    scopes: meta.scopes,
    // The JSON report's historical shape: ran/ok/cli, derived from the probe kind.
    value: {
      ran: f.kind !== "skipped",
      ok: f.kind === "ok",
      cli: f.kind === "skipped" ? null : f.cli,
    },
  };
  if (f.kind === "skipped") {
    return { ...base, status: "ok", detail: `skipped (${agent} CLI not installed)` };
  }
  return f.kind === "ok"
    ? { ...base, status: "ok", detail: `read-only prompt responded via ${f.cli}` }
    : {
      ...base,
      status: "warn",
      detail: `read-only prompt failed (${f.cli})\n${f.detail}`,
      fix: profile === null ? `agent ${agent}` : profileAddFix(profile),
    };
}

/** `--live` end-to-end check: did Codex actually respond via its configured backend? */
export function checkCodexLive(f: LiveProbeFacts, profile: Profile = null): CheckResult {
  return checkAgentLive("codex", f, profile);
}
export function checkClaudeLive(f: LiveProbeFacts, profile: Profile = null): CheckResult {
  return checkAgentLive("claude", f, profile);
}

/** Build every check applicable to `scope` from the gathered facts. */
export function evaluateAll(scope: HealthScope, facts: HealthFacts): CheckResult[] {
  const runProfile = facts.profile ?? null;
  const out: CheckResult[] = [];
  if (facts.bootstrap) {
    out.push(
      checkCliVersion(facts.bootstrap),
      checkDeno(facts.bootstrap),
      checkNodeModules(facts.bootstrap),
    );
  }
  if (facts.proxy) out.push(checkProxyPackage(facts.proxy), checkProxyResolved(facts.proxy));
  // One block of runtime checks per target, in gather order (the default target
  // first, then named profiles). A named target opens with its consistency
  // check; per-daemon rows render exactly for the targets whose daemon was
  // interrogated (daemonProbed, the probe's own stamp -- rows can never describe
  // a probe that did not happen).
  for (const target of facts.runtimes ?? []) {
    if (target.profile !== null) {
      out.push(checkProfileConsistency(target));
      if (!target.daemonProbed) continue;
    }
    out.push(checkRuntimePort(target), checkRuntimePid(target));
    out.push(checkRuntimePaths(target), checkRuntimeWatchdog(target));
    out.push(checkRuntimeIdentity(target), checkRuntimeOrphan(target));
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
  if (facts.profileAuth) {
    out.push(checkProfileAuth(facts.profileAuth.name, facts.profileAuth.slot, facts.profileAuth));
  }
  if (facts.codex) out.push(checkCodex(facts.codex, runProfile));
  if (facts.codexLive) out.push(checkCodexLive(facts.codexLive, runProfile));
  if (facts.codexHost) out.push(checkCodexHost(facts.codexHost));
  if (facts.claude) out.push(checkClaude(facts.claude, runProfile));
  if (facts.claudeLive) out.push(checkClaudeLive(facts.claudeLive, runProfile));
  if (facts.autoupdate) out.push(checkAutoupdate(facts.autoupdate));
  // Keep only the checks that participate in `scope` (single source of the rule,
  // shared with the --json path and the unit tests).
  return filterByScope(out, scope);
}
