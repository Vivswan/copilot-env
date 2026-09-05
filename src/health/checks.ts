// Pure evaluators: HealthFacts -> CheckResult[]. No I/O -- every input is a fact
// gathered by probe.ts, so each check is independently unit-testable.
import { DIRECT_BASE_URL } from "../claude/config.ts";
import { type ClaudeDesktopStatus, renderClaudeDesktopStatus } from "../claude/desktop.ts";
import { directHelperPath } from "../claude/paths.ts";
import { type CodexOtherReason, codexProviderId } from "../codex/config.ts";
import { codexHostDriftFrom, codexHostDriftLine } from "../codex/host.ts";
import { codexConfigPath } from "../codex/paths.ts";
import {
  type AuthProvider,
  type StoredCredential,
  storedCredentialKind,
} from "../copilot_api/env_state.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { PROXY_PACKAGE_NAME, type ProxyVersionStatus } from "../copilot_api/version.ts";
import { lastActivityMs } from "../scripts/idle_watchdog.ts";
import { assertNever } from "../utils/assert.ts";
import type { CommandLook } from "../utils/command.ts";
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
  DaemonProbeFacts,
  DefaultHomeMigrationFacts,
  HealthFacts,
  LiveProbeFacts,
  NamedRuntimeTarget,
  ProfileAuthFacts,
  ProxyFacts,
  RuntimeTarget,
  ShellFacts,
} from "./probe.ts";
import type { CheckGroup, CheckOutcome, CheckResult, HealthScope } from "./types.ts";
import { CHECK_DESCRIPTORS, type RegisteredCheckId, SETUP_SCOPES as SETUP } from "./types.ts";

/** The identity fields of a registered check, from the single descriptor table
 *  (the one source of each id's label/group/scopes). */
function meta(id: RegisteredCheckId): {
  id: RegisteredCheckId;
  label: string;
  group: CheckGroup;
  scopes: readonly HealthScope[];
} {
  const d = CHECK_DESCRIPTORS[id];
  return { id, label: d.label, group: d.group, scopes: d.scopes };
}

/** The `agent start` fix for a runtime target, addressed at its profile. */
function startFix(profile: Profile): string {
  return profile === null ? "agent start" : `agent start --profile ${profile}`;
}

/** The re-wire fix for a NAMED profile (mode is sticky from the store on a re-add). */
function profileAddFix(name: ProfileName): string {
  return `agent profile --add ${name}`;
}

/** Whether a classified credential actually resolves -- THE predicate shared by
 *  checkAuth and checkProfileAuth (a stored token resolves by presence, gh-cli
 *  by the live gh probe, none never). Exhaustive on the credential union. */
function credentialResolves(kind: StoredCredential["kind"], ghAuthenticated: boolean): boolean {
  switch (kind) {
    case "stored":
      return true;
    case "gh-cli":
      return ghAuthenticated;
    case "none":
      return false;
  }
}

/**
 * The gh-auth status shared by Codex and Claude Direct (gh-backed) checks: both
 * mint the bearer via `gh auth token`. Returns whether it's usable, a one-line
 * detail, and the gh-specific fix. Callers wrap `ghFix` in their own fix
 * selection (e.g. a base-URL/provider fix takes precedence). An UNPROVEN probe
 * (the gh look or the `gh auth token` spawn never ran to completion) keeps the
 * warn direction but wears could-not-check words -- "not found"/"not
 * authenticated" and their advice would be false claims about a check that
 * never happened.
 */
function describeDirectGhAuth(a: CodexDirectAuthFacts): {
  ok: boolean;
  detail: string;
  ghFix: string;
} {
  if (a.unproven) {
    return {
      ok: false,
      detail: a.command === null
        ? "gh auth: could not check for the GitHub CLI (the command probe failed to run)"
        : "gh auth: could not check gh authentication (`gh auth token` did not run to completion)",
      ghFix: "re-run `agent health` (the gh check did not run to completion)",
    };
  }
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

/** The shared direct-mode auth verdict: ok, or warn carrying its fix. */
type DirectAuthVerdict =
  | { status: "ok"; authLine: string }
  | { status: "warn"; authLine: string; fix: string };

/**
 * The shared direct-mode auth verdict for `checkCodex`/`checkClaude`: an identical
 * three-way decision (stored token -> gh-cli -> no credential resolves) over the same
 * facts. `wiringOk` is each agent's "rest of the wiring is correct" signal (Codex:
 * `providerWired`; Claude: base URL matches) and `directFix` is its `agent <cli> --direct`
 * repair hint. Each check wraps this with its own provider/base-url header lines.
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
): DirectAuthVerdict {
  const getCommand = profile === null
    ? "agent auth --get"
    : `agent auth --get --profile ${profile}`;
  const authFix = profile === null ? "agent auth" : `agent auth --profile ${profile}`;
  if (f.directUsesToken) {
    const authLine = `auth: stored GitHub token (${getCommand}, no gh CLI)`;
    return wiringOk ? { status: "ok", authLine } : { status: "warn", authLine, fix: directFix };
  }
  if (f.provider === "gh-cli") {
    const { ok: authOk, detail: authLine, ghFix } = describeDirectGhAuth(f.directAuth);
    return wiringOk && authOk
      ? { status: "ok", authLine }
      : { status: "warn", authLine, fix: wiringOk ? ghFix : directFix };
  }
  return {
    status: "warn",
    authLine: `auth: no credential resolves via \`${getCommand}\` - run \`${authFix}\``,
    fix: wiringOk ? authFix : directFix,
  };
}

export function checkCliVersion(f: BootstrapFacts): CheckResult {
  return {
    ...meta("bootstrap.version"),
    profile: null,
    status: "ok",
    detail: f.cliVersion,
    value: { version: f.cliVersion },
  };
}

export function checkDeno(f: BootstrapFacts): CheckResult {
  const { available, version } = f.deno;
  const base = { ...meta("bootstrap.deno"), profile: null, value: { available, version } };
  return available ? { ...base, status: "ok", detail: `deno ${version ?? "?"}` } : {
    ...base,
    status: "fail",
    detail: "Deno runtime not detected",
    fix: "install Deno (https://deno.com)",
  };
}

export function checkNodeModules(f: BootstrapFacts): CheckResult {
  const base = { ...meta("bootstrap.nodeModules"), profile: null };
  if (f.nodeModules === null) {
    // Compiled binary: dependencies are embedded and the proxy floats into its
    // own cache, so there is no node_modules to be missing or stale.
    return {
      ...base,
      status: "ok",
      detail: "embedded in the compiled binary",
      value: { embedded: true },
    };
  }
  const { present, fresh } = f.nodeModules;
  const value = { present, fresh };
  if (!present) {
    return {
      ...base,
      status: "fail",
      detail: "node_modules is missing",
      fix: "deno install --frozen",
      value,
    };
  }
  if (!fresh) {
    return {
      ...base,
      status: "warn",
      detail: "node_modules is stale (older than the lockfile)",
      fix: "deno install --frozen",
      value,
    };
  }
  return { ...base, status: "ok", detail: "installed and up to date", value };
}

export function checkProxyPackage(f: ProxyFacts): CheckResult {
  const base = { ...meta("proxy.package"), profile: null };
  // A config that couldn't be read means we can't judge bounds -- surface that
  // as the failure rather than letting the exception escape the report.
  if (f.configError !== null || f.bounds === null) {
    return {
      ...base,
      status: "fail",
      detail: `could not read copilot-env.config: ${f.configError ?? "unknown error"}`,
      fix: "check copilot-env.config",
      value: { version: f.version, configError: f.configError },
    };
  }
  const bounds: ProxyVersionStatus = f.bounds;
  let outcome: CheckOutcome;
  let standaloneMissing = false;
  if (bounds.ok) {
    // Version + cooldown as separate lines -> rendered as `-` sub-items.
    outcome = {
      status: "ok",
      detail: `${PROXY_PACKAGE_NAME} ${bounds.version}\nfloat ${
        floatCooldownLabel(f.cooldownSeconds)
      }`,
    };
  } else if (bounds.reason === "missing") {
    if (f.sidecar.standalone) {
      // A compiled install ships no deno.json baseline: the float resolves the
      // proxy into its own cache at `agent start`, so "missing" is the normal
      // pre-start state there, not a broken install.
      standaloneMissing = true;
      outcome = {
        status: "ok",
        detail: f.floatSkips
          ? `${PROXY_PACKAGE_NAME} not resolved; not required (Codex + Claude are both direct, so the proxy is unused)`
          : `${PROXY_PACKAGE_NAME} not resolved yet; \`agent start\` floats it in`,
      };
    } else {
      // In a checkout a missing package is a broken install; the fix always works.
      outcome = {
        status: "fail",
        detail: `${PROXY_PACKAGE_NAME} is not installed`,
        fix: "deno install --frozen",
      };
    }
  } else if (bounds.reason === "belowFloor") {
    outcome = {
      status: "fail",
      detail: `proxy ${bounds.version} is below the floor ${bounds.floor}`,
      fix: "deno install --frozen",
    };
  } else {
    outcome = {
      status: "warn",
      detail: `proxy ${bounds.version} is above the ceiling ${bounds.ceiling}`,
      fix: "agent update",
    };
  }
  let exempted = false;
  if (!bounds.ok && bounds.reason !== "missing" && f.floatSkips) {
    // The float itself skips (proxyFloatSkips: proxy unused, no env pin), so
    // the bounds are unenforceable -- the suggested fixes would not move the
    // version -- and must not read as a failure. A proxy rewire (or a proxy
    // profile) re-enables the float, which enforces them again.
    exempted = true;
    outcome = {
      status: "ok",
      detail:
        `${outcome.detail}; not enforced (Codex + Claude are both direct, so the proxy float skips)`,
    };
  }
  return {
    ...base,
    ...outcome,
    // floatSkips/standalone are stamped only when they changed the verdict,
    // mirroring the runtime checks' bothDirect stamp, so --json consumers can
    // tell "in bounds" from "out of bounds but exempted".
    value: {
      version: f.version,
      cooldownSeconds: f.cooldownSeconds,
      ...(exempted ? { floatSkips: true } : {}),
      ...(standaloneMissing ? { standalone: true } : {}),
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
 * The deno the proxy runs on. A checkout runs on its own runtime and needs nothing; a
 * compiled binary is not a deno CLI, so it CANNOT spawn the proxy until the pinned
 * sidecar is provisioned -- which is a failure, not a note.
 */
export function checkProxySidecar(f: ProxyFacts): CheckResult {
  const base = { ...meta("proxy.sidecar"), profile: null };
  const { kind, pin, denoBin, standalone } = f.sidecar;
  if (kind === "absent") {
    if (f.floatSkips) {
      // Direct-only: nothing spawns the proxy, so an unprovisioned sidecar is
      // idle capacity, not a failure. A proxy rewire re-enables the requirement.
      return {
        ...base,
        status: "ok",
        detail:
          `deno ${pin} not provisioned; not required (Codex + Claude are both direct, so the proxy is unused)`,
        value: { kind, pin, standalone, floatSkips: true },
      };
    }
    return {
      ...base,
      status: standalone ? "fail" : "warn",
      detail: `deno ${pin} is not provisioned${
        standalone ? "; a compiled build cannot spawn the proxy without it" : ""
      }`,
      fix: "agent start",
      value: { kind, pin, standalone },
    };
  }
  return {
    ...base,
    status: "ok",
    detail: kind === "dev"
      ? `running on this checkout's own deno\n${denoBin}`
      : `deno ${pin} provisioned\n${denoBin}`,
    value: { kind, pin, standalone },
  };
}

/**
 * The float's resolved-version record and the cache it points at -- the pair the daemon
 * actually launches from. Absent, the deno.json baseline in node_modules runs instead,
 * which is a working fallback rather than a failure; a record whose cache has gone
 * missing is not (the launch asks for that exact version offline and would fail).
 */
export function checkProxyResolved(f: ProxyFacts): CheckResult {
  const base = { ...meta("proxy.resolved"), profile: null };
  const resolved = f.resolved;
  if (resolved === null) {
    return {
      ...base,
      status: "ok",
      detail: f.floatSkips
        ? "not floated; Codex + Claude are both direct, so the proxy is unused"
        : f.sidecar.standalone
        ? "not floated yet; `agent start` resolves it (a compiled install has no baseline)"
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

export function checkRuntimePort(f: RuntimeTarget, p: DaemonProbeFacts): CheckResult {
  const base = { ...meta("runtime.port"), profile: f.profile };
  // Both agents direct => no agent routes to this port, so neither an empty port
  // nor some unrelated service listening there is a proxy problem.
  if (!f.proxyExpected) {
    return {
      ...base,
      status: "ok",
      detail: p.reachable
        ? `port ${f.port} has a listener, but no agent routes to it (Codex + Claude are both direct)`
        : `proxy not running on port ${f.port}; not required (Codex + Claude are both direct)`,
      value: { port: f.port, reachable: p.reachable, bothDirect: true },
    };
  }
  // Managed lifecycle on => the resolver launches the daemon on demand, so a
  // down daemon is expected between sessions, not a failure.
  if (!p.reachable && f.watchdog.autoStart) {
    return {
      ...base,
      status: "ok",
      detail: `proxy not running on port ${f.port}; starts on demand (auto-start on)`,
      value: { port: f.port, reachable: p.reachable, autoStart: true },
    };
  }
  const value = { port: f.port, reachable: p.reachable };
  return p.reachable ? { ...base, status: "ok", detail: `listening on port ${f.port}`, value } : {
    ...base,
    status: "fail",
    detail: `nothing reachable on port ${f.port}`,
    fix: startFix(f.profile),
    value,
  };
}

export function checkRuntimePid(f: RuntimeTarget, p: DaemonProbeFacts): CheckResult {
  const tracked = p.pidTracked;
  const base = { ...meta("runtime.pid"), profile: f.profile };
  // An unproven identity scan (pidScanUnproven) is "failed to look", never "not ours":
  // every arm below words it honestly, and the final verdict is a warn, not the
  // confident stale-or-foreign fail. The two excused arms (both-direct, down +
  // auto-start) may keep their ok: there the verdict is INVARIANT under the unknown --
  // a "yes" reading would also land on ok (tracked pids always do) -- so the flatten
  // decides nothing; only the honest detail and the value stamp carry the failed look.
  let detail: string;
  if (p.trackedPid === null) {
    detail = "no tracked copilot-api pid";
  } else if (tracked) {
    detail = `tracked copilot-api pid ${p.trackedPid}`;
  } else if (p.pidScanUnproven) {
    detail = `tracked pid ${p.trackedPid} could not be verified (the process scan failed)`;
  } else {
    detail = `tracked pid ${p.trackedPid} is stale or foreign`;
  }
  const scanNote = p.pidScanUnproven ? { scanUnproven: true } : {};
  // Both agents direct => no proxy needed, so a missing tracked pid is fine.
  if (!tracked && !f.proxyExpected) {
    return {
      ...base,
      status: "ok",
      detail: `${detail}; not required (Codex + Claude are both direct)`,
      value: { pid: p.trackedPid, tracked, alive: p.pidAlive, bothDirect: true, ...scanNote },
    };
  }
  // Down daemon + managed lifecycle on => it starts on demand; not a failure.
  // Reachable-but-untracked is NOT down (that is runtime.orphan/identity
  // territory), so auto-start never excuses it here.
  if (!tracked && !p.reachable && f.watchdog.autoStart) {
    return {
      ...base,
      status: "ok",
      detail: `${detail}; starts on demand (auto-start on)`,
      value: { pid: p.trackedPid, tracked, alive: p.pidAlive, autoStart: true, ...scanNote },
    };
  }
  const value = { pid: p.trackedPid, tracked, alive: p.pidAlive, ...scanNote };
  if (tracked) return { ...base, status: "ok", detail, value };
  if (p.trackedPid !== null && p.pidScanUnproven) {
    return {
      ...base,
      status: "warn",
      detail,
      fix: "re-run `agent health` from a shell that can read the process table",
      value,
    };
  }
  return { ...base, status: "fail", detail, fix: startFix(f.profile), value };
}

export function checkRuntimePaths(f: RuntimeTarget): CheckResult {
  // Multi-line detail: report.ts indents each line so state/log sit on their own.
  return {
    ...meta("runtime.paths"),
    profile: f.profile,
    status: "ok",
    detail: `state ${f.paths.stateFile}\nlog ${f.paths.logFile}`,
    value: { ...f.paths },
  };
}

export function checkRuntimeWatchdog(f: RuntimeTarget): CheckResult {
  const w = f.watchdog;
  // Scoped to full + proxy, NOT the launchers' fast `runtime` probe (this is informational and
  // reads the config + activity file). Always "ok": it reports state, it never fails a run.
  const base = { ...meta("runtime.watchdog"), profile: f.profile, status: "ok" as const };
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

export function checkRuntimeIdentity(f: RuntimeTarget, p: DaemonProbeFacts): CheckResult {
  // Is whatever is reachable on the port actually copilot-api? checkRuntimePort only proves
  // SOMETHING answers; a foreign service squatting the port would read green there while every
  // agent request silently misroutes. Warn-only (never fails a run) and full+proxy scope.
  // The misroute claim presumes something routes to the port: the probe gates on
  // proxyExpected, so a target with no route to the port (both modes direct and no
  // proxy base URL) always arrives here with identityConfirmed null.
  const base = { ...meta("runtime.identity"), profile: f.profile };
  if (!p.reachable || p.identityConfirmed === null) {
    // Nothing reachable (runtime.port owns that verdict) or identity not probed.
    const notProbed = !f.proxyExpected
      ? `not probed (no agent routes to port ${f.port}; Codex + Claude are both direct)`
      : "identity not probed";
    return {
      ...base,
      status: "ok",
      detail: p.reachable ? notProbed : `not probed (nothing reachable on port ${f.port})`,
      value: { reachable: p.reachable, confirmed: null },
    };
  }
  if (p.identityConfirmed) {
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

export function checkRuntimeOrphan(f: RuntimeTarget, p: DaemonProbeFacts): CheckResult {
  // The port-ownership verdict: one exhaustive switch over the probe's own
  // PortState reconciliation (classifyPortState in probe.ts) -- this check no
  // longer re-derives who holds the port. Pure (no I/O), full+proxy scope.
  const base = { ...meta("runtime.orphan"), profile: f.profile };
  const state = p.portState;
  switch (state.kind) {
    case "foreign":
      // The detail must not claim the tracked daemon owns the port when identity says the
      // responder is foreign (pidTracked only proves the saved pid is a copilot-api process,
      // not that it owns THIS port) -- defer that wording to runtime.identity.
      return {
        ...base,
        status: "ok",
        detail: "port responder is not copilot-api (see proxy identity)",
        value: { orphan: false },
      };
    case "unrouted":
      // SOMETHING is reachable on the port, but both agents are configured direct, so no
      // proxy is required -- the both-direct gate (not the facts) is why this isn't an
      // orphan warning. Say that -- even with a tracked pid alive, since identity is never
      // probed for a both-direct target (proxyExpected gates the probe), nothing here
      // proves who owns the port, and nothing routes to it anyway.
      return {
        ...base,
        status: "ok",
        detail: `a process is on port ${f.port}, but both agents are direct (no proxy required)`,
        value: { orphan: false },
      };
    case "tracked":
      return {
        ...base,
        status: "ok",
        detail: "port held by the tracked daemon",
        value: { orphan: false },
      };
    case "down":
      return {
        ...base,
        status: "ok",
        detail: "no untracked copilot-api on the port",
        value: { orphan: false },
      };
    case "orphan": {
      const stopFix = f.profile === null ? "agent stop" : `agent stop --profile ${f.profile}`;
      // An unproven identity scan means "not the tracked daemon" was never established:
      // the responder may well BE the tracked daemon. Warn with the honest unproven
      // detail instead of the confident orphan claim below.
      if (p.pidScanUnproven && p.trackedPid !== null) {
        return {
          ...base,
          status: "warn",
          detail:
            `a process is on port ${f.port}, but the tracked pid ${p.trackedPid} could not be verified (the process scan failed) - it may be the tracked daemon`,
          fix: "re-run `agent health` from a shell that can read the process table",
          value: { orphan: null, trackedPid: p.trackedPid, scanUnproven: true },
        };
      }
      // Identity is confirmed copilot-api or indeterminate (probe failed) -- don't
      // over-claim "copilot-api".
      const what = state.identity === "confirmed"
        ? "copilot-api"
        : "a process (identity unconfirmed)";
      return {
        ...base,
        status: "warn",
        detail:
          `${what} is on port ${f.port} but is not the tracked daemon (orphaned -- started outside 'agent start', or the run-state was cleared)`,
        fix: `${stopFix}, then ${startFix(f.profile)} (re-tracks the daemon)`,
        value: { orphan: true, trackedPid: p.trackedPid },
      };
    }
  }
}

/**
 * NAMED targets only (the type says so): do the profile's two halves -- the
 * store slot (the source of truth for credential + mode) and the on-disk daemon
 * home (derived, proxy mode only) -- agree? A profile is created/deleted
 * atomically by `agent profile`, so a lone half is an interrupted add/del; warn
 * with the command that finishes the job. Never a failure: the profile's own
 * runtime rows own hard verdicts.
 */
export function checkProfileConsistency(f: NamedRuntimeTarget): CheckResult {
  const name = f.profile;
  const slot = f.slot;
  const homeExists = f.homeExists;
  const base = {
    ...meta("profile.consistency"),
    profile: name,
    value: {
      slotExists: slot.exists,
      mode: slot.mode,
      homeExists,
    },
  };
  if (!slot.exists) {
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
  resolution: { storedToken: boolean; ghAuthenticated: boolean; ghAuthUnproven?: true },
): CheckResult {
  const base = {
    ...meta("setup.auth"),
    profile: name,
    value: {
      provider: slot?.provider ?? null,
      mode: slot?.mode ?? null,
      integrationIdentity: slot?.integrationIdentity ?? null,
      storedToken: resolution.storedToken,
      ghAuthenticated: resolution.ghAuthenticated,
      ...(resolution.ghAuthUnproven ? { ghAuthUnproven: true } : {}),
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
  const source = storedCredentialKind(slot.provider, resolution.storedToken);
  const resolves = credentialResolves(source, resolution.ghAuthenticated);
  if (!resolves) {
    // An unproven gh probe keeps this warn arm (the credential still isn't shown
    // to work) but must not claim gh IS unauthenticated -- gh was never asked.
    const unproven = slot.provider === "gh-cli" && resolution.ghAuthUnproven === true;
    return {
      ...base,
      status: "warn",
      detail: [
        unproven
          ? `provider 'gh-cli' is recorded for profile '${name}' but its credential could not be checked`
          : `provider '${slot.provider}' is recorded for profile '${name}' but no credential resolves`,
        slot.provider === "gh-cli"
          ? unproven
            ? "could not check gh authentication (`gh auth token` did not run to completion)"
            : "`gh` is unauthenticated - run `gh auth login`, or re-provision the profile"
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

/**
 * An unfinished 3.5.6 default-home move: the fix-up stages the flat root's
 * daemon files under `profiles/` and flips with one atomic rename, so a kill
 * inside that window leaves the staging dir behind. The system still works --
 * home resolution keeps answering the flat root until the flip -- so this is an
 * unfinished migration (warn), never a breakage (fail); re-running the
 * migration completes the move.
 */
export function checkDefaultHomeMigration(f: DefaultHomeMigrationFacts): CheckResult {
  const base = {
    ...meta("runtime.defaultHomeMigration"),
    profile: null,
    value: { stagingPath: f.stagingPath, staged: f.staged },
  };
  if (!f.staged) {
    return { ...base, status: "ok", detail: "no unfinished default-home migration" };
  }
  return {
    ...base,
    status: "warn",
    detail: [
      `an interrupted default-home migration left the staging dir ${f.stagingPath} behind`,
      "the default daemon still runs from the flat root until the move completes",
    ].join("\n"),
    fix: "agent migrate 3.5.6 3.5.7",
  };
}

export function checkShellIntegration(f: ShellFacts): CheckResult {
  const base = {
    ...meta("setup.shell"),
    profile: null,
    value: {
      integrationWired: f.integrationWired,
      files: f.files,
      ...(f.targetsUnproven ? { targetsUnproven: true } : {}),
    },
  };
  if (f.integrationWired) return { ...base, status: "ok", detail: "wired into a shell rc/profile" };
  // Target discovery never ran: the empty census proves nothing, so keep the
  // warn + fix but never the confident "not wired" claim.
  if (f.targetsUnproven) {
    return {
      ...base,
      status: "warn",
      detail: "could not check the shell rc/profile files (target discovery failed to run)",
      fix: "agent shell",
    };
  }
  return {
    ...base,
    status: "warn",
    detail: "not wired into any shell rc/profile",
    fix: "agent shell",
  };
}

export function checkLaunchers(f: ShellFacts): CheckResult {
  const base = {
    ...meta("setup.launchers"),
    profile: null,
    value: { launchersWired: f.launchersWired },
  };
  return f.launchersWired
    ? {
      ...base,
      status: "ok",
      detail: "enabled (the `launchers` config key; `agent env` defines them)",
    }
    : {
      ...base,
      status: "warn",
      detail: "not enabled (optional)",
      fix: "agent config --set launchers true",
    };
}

export function checkCli(c: CliFacts): CheckResult {
  const base = {
    // The one check family whose id is minted outside the descriptor table: the
    // CLI list is runtime data (see CHECK_DESCRIPTORS).
    id: `setup.cli.${c.command}` as const,
    label: `${c.name} (${c.command})`,
    group: "setup" as const,
    profile: null,
    scopes: SETUP,
    value: {
      command: c.command,
      resolved: c.look.path,
      ...(c.look.launchFailed ? { lookFailed: true } : {}),
    },
  };
  if (c.look.path !== null) return { ...base, status: "ok", detail: c.look.path };
  // A FAILED look is not a proven absence: same warn + fix, honest words.
  if (c.look.launchFailed) {
    return {
      ...base,
      status: "warn",
      detail: "could not check (the command probe failed to run)",
      fix: "agent shell --clis",
    };
  }
  return { ...base, status: "warn", detail: "not installed (optional)", fix: "agent shell --clis" };
}

export function checkTool(name: "node" | "npm", look: CommandLook): CheckResult {
  const base = {
    ...meta(`setup.tool.${name}`),
    profile: null,
    value: { resolved: look.path, ...(look.launchFailed ? { lookFailed: true } : {}) },
  };
  if (look.path !== null) return { ...base, status: "ok", detail: look.path };
  if (look.launchFailed) {
    return {
      ...base,
      status: "warn",
      detail: "could not check (the command probe failed to run)",
      fix: "agent shell --clis",
    };
  }
  return { ...base, status: "warn", detail: "not installed (optional)", fix: "agent shell --clis" };
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
    ...meta("setup.auth"),
    profile: null,
    value: {
      storedToken: f.storedToken,
      ghAuthenticated: f.ghAuthenticated,
      ...(f.ghAuthUnproven ? { ghAuthUnproven: true } : {}),
      provider: f.provider,
      profiles: f.profiles,
      pinnedIntegrationId: f.pinnedIntegrationId,
    },
  };
  // Provider classification owned by storedCredentialKind() (env_state.ts); a
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
  const source = storedCredentialKind(f.provider, f.storedToken);
  const resolves = credentialResolves(source, f.ghAuthenticated);
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
  // An unproven gh probe keeps this warn arm (nothing was shown to resolve) but
  // must not claim gh IS unauthenticated -- `gh auth token` never ran to
  // completion, so the `gh auth login` advice would be handed out unearned.
  const unproven = f.provider === "gh-cli" && f.ghAuthUnproven === true;
  return {
    ...base,
    status: "warn",
    detail: [
      unproven
        ? "provider 'gh-cli' is selected but its credential could not be checked"
        : `provider '${f.provider}' is selected but no credential resolves`,
      f.provider === "gh-cli"
        ? unproven
          ? "could not check gh authentication (`gh auth token` did not run to completion)"
          : "`gh` is unauthenticated - run `gh auth login`, or `agent auth` to switch provider"
        : "the stored token is missing - run `agent auth` to re-provision",
      ...profilesLine,
      ...identityLine,
    ].join("\n"),
    fix: "agent auth",
  };
}

/** The repair line of a Codex "other" classification, keyed off the reason the
 *  classifier minted (exhaustive, so a new reason forces a verdict here). Null
 *  = "custom": a foreign selection is re-wirable, so the generic model_provider
 *  reporting in checkCodex owns it. */
function codexOtherLine(reason: CodexOtherReason): string | null {
  switch (reason) {
    case "malformed":
      return "config.toml is present but not valid TOML";
    case "read-error":
      return "config.toml exists but could not be read";
    case "custom":
      return null;
    default:
      return assertNever(reason);
  }
}

export function checkCodex(f: CodexFacts, profile: Profile = null): CheckResult {
  const configPath = codexConfigPath(f.home);
  // A named profile's whole wiring (both agents, one mode) is (re)written by ONE
  // command, so every named repair points there instead of `agent codex ...`.
  const directFix = profile === null ? "agent codex --direct" : profileAddFix(profile);
  const proxyFix = profile === null ? "agent codex --proxy" : profileAddFix(profile);
  const base = {
    ...meta("setup.codex"),
    profile,
    value: {
      home: f.home,
      configFile: configPath,
      configExists: f.configExists,
      modelProvider: f.modelProvider,
      providerMode: f.providerMode,
      otherReason: f.otherReason,
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
    const detail = [
      "provider: direct",
      `config.toml: ${configPath}`,
      `model_provider ${f.modelProvider ?? "(unset)"} (direct) → ${f.baseUrl ?? "(missing)"}`,
      verdict.authLine,
    ].join("\n");
    return verdict.status === "ok"
      ? { ...base, status: "ok", detail }
      : { ...base, status: "warn", detail, fix: verdict.fix };
  }
  // A config.toml we could not parse or read: the managed writers REFUSE such a
  // file, so a re-wire fix cannot land -- the repair comes first (mirrors the
  // Claude malformed/read-error arm; codexOtherLine's null sends a foreign
  // "custom" selection to the generic re-wire path below).
  if (f.providerMode === "other") {
    const otherLine = codexOtherLine(f.otherReason);
    if (otherLine !== null) {
      const rewire = profile === null ? "agent codex" : profileAddFix(profile);
      return {
        ...base,
        status: "warn",
        detail: ["provider: other", `config.toml: ${configPath}`, otherLine].join("\n"),
        fix: `repair ${configPath}, then re-run \`${rewire}\``,
      };
    }
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

/** Report the per-host CODEX_HOME farm (~/.codex/hosts/<hostname>) against the
 *  `codex-host` key that derives it: any key-vs-disk drift warns with the wiring
 *  pass that resolves it (the same verdict `agent codex --check` prints). */
export function checkCodexHost(f: CodexHostFacts): CheckResult {
  const configFile = codexConfigPath(f.hostHome);
  const detail = (summary: string) => f.exists ? `${summary}\nconfig.toml: ${configFile}` : summary;
  const base = {
    ...meta("setup.codex-host"),
    profile: null,
    value: {
      supported: f.supported,
      hostHome: f.hostHome,
      configFile,
      exists: f.exists,
      wired: f.wired,
      probeError: f.probeError,
      active: f.active,
      enabled: f.enabled,
    },
  };
  const warn = (summary: string): CheckResult => ({
    ...base,
    status: "warn",
    detail: detail(summary),
    fix: "agent codex",
  });
  if (!f.supported) return { ...base, status: "ok", detail: "not built (unsupported on Windows)" };
  const drift = codexHostDriftFrom(f.enabled, {
    hostHome: f.hostHome,
    present: f.exists,
    wired: f.wired,
    probeError: f.probeError,
    active: f.active,
  });
  if (drift !== null) return warn(codexHostDriftLine(drift));
  if (f.enabled) {
    return { ...base, status: "ok", detail: detail(`active per-host CODEX_HOME: ${f.hostHome}`) };
  }
  // Not built, not wanted. Informational -- it's an optional feature.
  return { ...base, status: "ok", detail: "not built (optional)" };
}

/** The one-line reading of a Claude "other" classification, keyed off the
 *  reason the classifier minted (never re-derived from paths here). */
function claudeOtherLine(f: ClaudeFacts & { providerMode: "other" }): string {
  switch (f.otherReason) {
    case "malformed":
      return "settings.json is present but not valid JSON";
    case "read-error":
      return "settings.json exists but could not be read";
    case "legacy-unrecognized":
      return `apiKeyHelper → ${f.helperPath} (the retired copilot-env helper path), but copilot-env cannot verify the helper body (missing, unreadable, or unrecognized)`;
    case "custom":
      return `custom apiKeyHelper/ANTHROPIC_BASE_URL set (${f.helperPath ?? f.baseUrl})`;
    default:
      return assertNever(f.otherReason);
  }
}

/** Report Claude Code wiring (settings.json, or a named profile's
 *  settings-<name>.json): direct / proxy / custom. */
export function checkClaude(f: ClaudeFacts, profile: Profile = null): CheckResult {
  const directFix = profile === null ? "agent claude --direct" : profileAddFix(profile);
  const base = {
    ...meta("setup.claude"),
    profile,
    value: {
      home: f.home,
      settingsFile: f.settingsPath,
      settingsExists: f.settingsExists,
      providerMode: f.providerMode,
      otherReason: f.otherReason,
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
    const detail = [
      "provider: direct",
      `settings.json: ${f.settingsPath}`,
      baseUrlLine,
      verdict.authLine,
    ].join("\n");
    return verdict.status === "ok"
      ? { ...base, status: "ok", detail }
      : { ...base, status: "warn", detail, fix: verdict.fix };
  }
  if (f.providerMode === "proxy") {
    // Proxy-backed via settings.json (apiKeyHelper prints the proxy token, base URL points at
    // the local proxy). Runtime reachability is the proxy check's job; here we confirm the
    // wiring is present AND that ANTHROPIC_BASE_URL actually points at the resolved proxy port
    // -- a stale base URL (e.g. after `config port` changed and the daemon rebound) would send
    // Claude to the wrong/absent port, so it must not read green. Mirrors the Codex check.
    // A named profile's repair is its own atomic re-add (which re-reserves and re-bakes).
    const baseUrlOk = f.baseUrl !== null && f.baseUrlMatches;
    const detail = [
      "provider: proxy",
      `settings.json: ${f.settingsPath}`,
      `ANTHROPIC_BASE_URL → ${f.baseUrl ?? "(missing)"}${
        baseUrlOk ? "" : " (does not match the resolved proxy port)"
      }`,
      `apiKeyHelper → ${f.helperPath ?? "(missing)"}`,
    ].join("\n");
    return baseUrlOk ? { ...base, status: "ok", detail } : {
      ...base,
      status: "warn",
      detail,
      fix: profile === null
        // --proxy explicitly: the bare commands auto-detect a mode, which is not
        // guaranteed to re-bake the proxy wiring this fix is repairing.
        ? "Re-run `agent claude --proxy` to repoint ANTHROPIC_BASE_URL at the current proxy port."
        : `Re-run \`${
          profileAddFix(profile)
        }\` to repoint ANTHROPIC_BASE_URL at the profile's proxy port.`,
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
          `${claudeOtherLine(f)}; profile '${profile}' expects managed wiring`,
        ].join("\n"),
        fix: `remove ${f.settingsPath} (not managed by copilot-env), then ${
          profileAddFix(profile)
        }`,
      };
    }
    // Default-profile exceptions to "the user's own business", keyed off the
    // classifier's reason: a legacy helper path whose body could not be verified
    // is likelier a broken leftover than custom wiring, and a settings file we
    // could not read/parse will trip Claude itself too.
    if (f.otherReason === "legacy-unrecognized") {
      // The rewire to suggest follows the mode the helper filename encodes.
      const fix = f.helperPath === directHelperPath(f.home)
        ? "agent claude --direct"
        : "agent claude --proxy";
      return {
        ...base,
        status: "warn",
        detail: ["provider: other", `settings.json: ${f.settingsPath}`, claudeOtherLine(f)]
          .join("\n"),
        fix,
      };
    }
    if (f.otherReason === "malformed" || f.otherReason === "read-error") {
      return {
        ...base,
        status: "warn",
        detail: ["provider: other", `settings.json: ${f.settingsPath}`, claudeOtherLine(f)]
          .join("\n"),
        fix: `repair ${f.settingsPath}, then re-run \`agent claude\``,
      };
    }
    return {
      ...base,
      status: "ok",
      detail: [
        "provider: other",
        `settings.json: ${f.settingsPath}`,
        `${claudeOtherLine(f)}; not managed`,
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

/** The Claude Desktop library against the `claude-desktop` key: a rendered fix (drift) is a
 *  warn, anything else informational. The drift rule lives in renderClaudeDesktopStatus,
 *  shared with `agent claude --check`. */
export function checkClaudeDesktop(f: ClaudeDesktopStatus): CheckResult {
  const { lines, fix } = renderClaudeDesktopStatus(f);
  const base = {
    ...meta("setup.claude-desktop"),
    profile: null,
    value: {
      kind: f.kind,
      enabled: f.enabled,
      installed: f.installed,
      helperPaths: f.helperPaths,
      ...(f.kind === "unreadable" ? { metaPath: f.metaPath } : {}),
      ...(f.kind === "unjudged" ? { reason: f.reason } : {}),
      ...(f.kind === "inspected"
        ? {
          libraryDir: f.libraryDir,
          ownedPaths: f.ownedPaths,
          unlisted: f.unlisted,
          entries: f.entries.map((e) => ({ profile: e.profile, mode: e.mode, ...e.verdict })),
          orphans: f.orphans,
        }
        : {}),
    },
  };
  const detail = lines.join("\n");
  return fix === null
    ? { ...base, status: "ok", detail }
    : { ...base, status: "warn", detail, fix };
}

/** Report opt-in autoupdate status (mirrors `agent update --auto-status`). */
export function checkAutoupdate(f: AutoupdateStatus): CheckResult {
  const base = {
    ...meta("setup.autoupdate"),
    profile: null,
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
    `status: ${f.enabled ? "enabled" : "disabled"} (the auto-update config key)`,
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
  const base = {
    ...meta(agent === "codex" ? "codex.live" : "claude.live"),
    profile,
    // The JSON report's historical shape: ran/ok/cli, derived from the probe kind.
    value: {
      ran: f.kind !== "skipped",
      ok: f.kind === "ok",
      cli: f.kind === "skipped" ? null : f.cli,
      ...(f.kind === "skipped" && f.lookFailed ? { lookFailed: true } : {}),
    },
  };
  if (f.kind === "skipped") {
    // A skip off a FAILED look is a could-not-check, never a proven absence.
    return {
      ...base,
      status: "ok",
      detail: f.lookFailed
        ? `skipped (could not check for the ${agent} CLI - the command probe failed to run)`
        : `skipped (${agent} CLI not installed)`,
    };
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
  if (facts.proxy) {
    out.push(
      checkProxyPackage(facts.proxy),
      checkProxyResolved(facts.proxy),
      checkProxySidecar(facts.proxy),
    );
  }
  // One block of runtime checks per target, in gather order (the default target
  // first, then named profiles). A named target opens with its consistency
  // check; per-daemon rows render exactly for the targets whose daemon was
  // interrogated (the probe's own `probed` outcome -- rows can never describe a
  // probe that did not happen).
  for (const target of facts.runtimes ?? []) {
    if (target.profile !== null) out.push(checkProfileConsistency(target));
    const probe = target.probe;
    if (probe.kind === "skipped") continue;
    out.push(checkRuntimePort(target, probe), checkRuntimePid(target, probe));
    out.push(checkRuntimePaths(target), checkRuntimeWatchdog(target));
    out.push(checkRuntimeIdentity(target, probe), checkRuntimeOrphan(target, probe));
  }
  if (facts.defaultHomeMigration) {
    out.push(checkDefaultHomeMigration(facts.defaultHomeMigration));
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
  if (facts.claudeDesktop) out.push(checkClaudeDesktop(facts.claudeDesktop));
  if (facts.claudeLive) out.push(checkClaudeLive(facts.claudeLive, runProfile));
  if (facts.autoupdate) out.push(checkAutoupdate(facts.autoupdate));
  // Keep only the checks that participate in `scope` (single source of the rule,
  // shared with the --json path and the unit tests).
  return filterByScope(out, scope);
}
