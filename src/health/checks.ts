// Pure evaluators: HealthFacts -> CheckResult[]. No I/O -- every input is a fact
// gathered by probe.ts, so each check is independently unit-testable.

import { configGetCommand, configSetCommand } from "../copilot_api/env_config.ts";
import {
  type AuthProvider,
  type ProfileMode,
  type StoredCredential,
  storedCredentialKind,
} from "../copilot_api/env_state.ts";
import { lastActivityMs } from "../copilot_api/idle_watchdog.ts";
import {
  agentAuthCommand,
  agentStartCommand,
  agentStopCommand,
  type Profile,
} from "../copilot_api/profile.ts";
import { PROXY_PACKAGE_NAME, type ProxyVersionStatus } from "../copilot_api/version.ts";
import { assertNever } from "../utils/assert.ts";
import { byCodeUnit } from "../utils/order.ts";
import { formatDuration, SECONDS_PER_DAY } from "../utils/time.ts";
import { filterByScope } from "./aggregate.ts";
import {
  checkAgentLive,
  checkClaude,
  checkClaudeDesktop,
  checkCodex,
  checkCodexHost,
  ghAccountClause,
  ghCouldNotCheck,
} from "./checks_agents.ts";
import type {
  AuthFacts,
  AutoupdateStatus,
  BootstrapFacts,
  CliFacts,
  DaemonProbeFacts,
  HealthFacts,
  NamedRuntimeTarget,
  ProfileAuthFacts,
  ProxyFacts,
  RuntimeTarget,
  ShellFacts,
} from "./facts.ts";
import type { CheckOutcome, CheckResult, HealthScope } from "./types.ts";
import { meta, profileAddFix, SETUP_SCOPES as SETUP } from "./types.ts";

type DefaultAuthFacts = Extract<AuthFacts, { profile: null }>;

/** THE predicate of checkAuth, for both targets: a stored token resolves by presence, gh-cli by
 *  the live gh probe, none never. */
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

function checkCliVersion(f: BootstrapFacts): CheckResult {
  return {
    ...meta("bootstrap.version"),
    profile: null,
    status: "ok",
    detail: f.cliVersion,
    value: { version: f.cliVersion },
  };
}

/** Health runs on bun, so the runtime is always present, and the proxy daemon runs from the same
 *  executable (src/copilot_api/process.ts spawns it as a bun CLI): one row names both. */
export function checkRuntime(f: BootstrapFacts): CheckResult {
  return {
    ...meta("bootstrap.runtime"),
    profile: null,
    status: "ok",
    detail: `bun ${f.runtimeVersion}; the proxy daemon runs from this executable\n${f.runtimePath}`,
    value: { available: true, version: f.runtimeVersion, executable: f.runtimePath },
  };
}

export function checkNodeModules(f: BootstrapFacts): CheckResult {
  const base = { ...meta("bootstrap.nodeModules"), profile: null };
  if (f.nodeModules === null) {
    // Compiled binary: dependencies are embedded and the proxy floats into its own cache, so
    // there is no node_modules to be missing or stale.
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
      fix: "bun install --frozen-lockfile",
      value,
    };
  }
  if (!fresh) {
    return {
      ...base,
      status: "warn",
      detail: "node_modules is stale (older than the lockfile)",
      fix: "bun install --frozen-lockfile",
      value,
    };
  }
  return { ...base, status: "ok", detail: "installed and up to date", value };
}

function floatCooldownLabel(seconds: number | null): string {
  if (seconds === null) return "cooldown: unknown";
  if (seconds === 0) return "no cooldown";
  if (seconds % SECONDS_PER_DAY === 0) return `cooldown ${seconds / SECONDS_PER_DAY}d`;
  return `cooldown ${seconds}s`;
}

/** A missing package: in a checkout a broken install (the fix always works); in a compiled
 *  install the normal pre-start state, since it ships no node_modules and the float installs the
 *  proxy into the proxy home at `agent start`. */
function missingProxyOutcome(f: ProxyFacts): CheckOutcome {
  if (!f.standalone) {
    return {
      status: "fail",
      detail: `${PROXY_PACKAGE_NAME} is not installed`,
      fix: "bun install --frozen-lockfile",
    };
  }
  if (f.floatSkips) {
    return {
      status: "ok",
      detail: `${PROXY_PACKAGE_NAME} not resolved; not required (Codex + Claude are both direct, so the proxy is unused)`,
    };
  }
  return {
    status: "ok",
    detail: `${PROXY_PACKAGE_NAME} not resolved yet; \`agent start\` floats it in`,
  };
}

/** The verdict of the version bounds alone, before the float-skips exemption. */
function proxyBoundsOutcome(f: ProxyFacts, bounds: ProxyVersionStatus): CheckOutcome {
  if (bounds.ok) {
    // Version and cooldown as separate lines: the report renders each as its own sub-item.
    const cooldown = floatCooldownLabel(f.cooldownSeconds);
    return { status: "ok", detail: `${PROXY_PACKAGE_NAME} ${bounds.version}\nfloat ${cooldown}` };
  }
  switch (bounds.reason) {
    case "missing":
      return missingProxyOutcome(f);
    case "belowFloor":
      return {
        status: "fail",
        detail: `proxy ${bounds.version} is below the floor ${bounds.floor}`,
        fix: "bun install --frozen-lockfile",
      };
    case "aboveCeiling":
      return {
        status: "warn",
        detail: `proxy ${bounds.version} is above the ceiling ${bounds.ceiling}`,
        fix: "agent update",
      };
  }
}

export function checkProxyPackage(f: ProxyFacts): CheckResult {
  const base = { ...meta("proxy.package"), profile: null };
  // An unreadable config means the bounds cannot be judged; that is the failure, rather than an
  // exception escaping the report.
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
  const missing = !bounds.ok && bounds.reason === "missing";
  const standaloneMissing = missing && f.standalone;
  // The float itself skips (proxyFloatSkips: proxy unused, no env pin), so the bounds are
  // unenforceable (the suggested fixes would not move the version) and must not read as a
  // failure. A proxy rewire or a proxy profile re-enables the float, which enforces them again.
  const exempted = !bounds.ok && !missing && f.floatSkips;
  let outcome = proxyBoundsOutcome(f, bounds);
  if (exempted) {
    outcome = {
      status: "ok",
      detail: `${outcome.detail}; not enforced (Codex + Claude are both direct, so the proxy float skips)`,
    };
  }
  return {
    ...base,
    ...outcome,
    // floatSkips/standalone are stamped only when they changed the verdict, mirroring the runtime
    // checks' bothDirect stamp, so --json consumers can tell "in bounds" from "exempted".
    value: {
      version: f.version,
      cooldownSeconds: f.cooldownSeconds,
      ...(exempted ? { floatSkips: true } : {}),
      ...(standaloneMissing ? { standalone: true } : {}),
    },
  };
}

/** Not resolved yet reads ok: the proxy waits for `agent start` to float it in. A RECORDED version
 *  whose install has gone missing fails, because the launch runs that exact version from it. */
export function checkProxyResolved(f: ProxyFacts): CheckResult {
  const base = { ...meta("proxy.resolved"), profile: null };
  const resolved = f.resolved;
  if (resolved === null) {
    return {
      ...base,
      status: "ok",
      detail: f.floatSkips
        ? "not floated; Codex + Claude are both direct, so the proxy is unused"
        : "not floated yet; `agent start` resolves it",
      value: { resolved: false },
    };
  }
  if (!resolved.installed) {
    return {
      ...base,
      status: "fail",
      detail:
        `${PROXY_PACKAGE_NAME} ${resolved.version} is recorded, but its install under the ` +
        "proxy home is missing",
      fix: "agent start",
      value: { resolved: true, version: resolved.version, installed: false },
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `${PROXY_PACKAGE_NAME} ${resolved.version}\ninstalled in the proxy home`,
    value: { resolved: true, version: resolved.version, installed: true },
  };
}

export function checkRuntimePort(f: RuntimeTarget, p: DaemonProbeFacts): CheckResult {
  const base = { ...meta("runtime.port"), profile: f.profile };
  // Both agents direct: no agent routes to this port, so neither an empty port nor an unrelated
  // service listening there is a proxy problem.
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
  // Managed lifecycle on: the resolver launches the daemon on demand, so a down daemon is
  // expected between sessions, not a failure.
  if (!p.reachable && f.watchdog.autoStart) {
    return {
      ...base,
      status: "ok",
      detail: `proxy not running on port ${f.port}; starts on demand (daemon.auto-start on)`,
      value: { port: f.port, reachable: p.reachable, autoStart: true },
    };
  }
  const value = { port: f.port, reachable: p.reachable };
  return p.reachable
    ? { ...base, status: "ok", detail: `listening on port ${f.port}`, value }
    : {
        ...base,
        status: "fail",
        detail: `nothing reachable on port ${f.port}`,
        fix: agentStartCommand(f.profile),
        value,
      };
}

export function checkRuntimePid(f: RuntimeTarget, p: DaemonProbeFacts): CheckResult {
  const tracked = p.pidTracked;
  const base = { ...meta("runtime.pid"), profile: f.profile };
  // An unproven identity scan (pidScanUnproven) is "failed to look", never "not ours": each arm
  // words it honestly and the final verdict is a warn, not the confident stale-or-foreign fail.
  // The two excused arms (both-direct, down + auto-start) keep their ok: a "yes" reading would
  // also land on ok there, so the flatten decides nothing.
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
  // Both agents direct: no proxy needed, so a missing tracked pid is fine.
  if (!tracked && !f.proxyExpected) {
    return {
      ...base,
      status: "ok",
      detail: `${detail}; not required (Codex + Claude are both direct)`,
      value: { pid: p.trackedPid, tracked, alive: p.pidAlive, bothDirect: true, ...scanNote },
    };
  }
  // Down daemon + managed lifecycle on: it starts on demand. Reachable-but-untracked is NOT down
  // (that is runtime.orphan/identity territory), so auto-start never excuses it here.
  if (!tracked && !p.reachable && f.watchdog.autoStart) {
    return {
      ...base,
      status: "ok",
      detail: `${detail}; starts on demand (daemon.auto-start on)`,
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
  return { ...base, status: "fail", detail, fix: agentStartCommand(f.profile), value };
}

function checkRuntimePaths(f: RuntimeTarget): CheckResult {
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
  // Scoped to full + proxy, NOT the fast `runtime` probe scope (informational; reads the
  // config and activity file). Always "ok": it reports state, it never fails a run.
  const base = { ...meta("runtime.watchdog"), profile: f.profile, status: "ok" as const };
  if (!f.proxyExpected) {
    // Marks left by an earlier run would render a countdown for a daemon no request will reach.
    return {
      ...base,
      detail: "not required (Codex + Claude are both direct)",
      value: { bothDirect: true },
    };
  }
  if (!w.autoStart) {
    return {
      ...base,
      detail: "off (daemon.auto-start false) -- no auto-start, no auto-stop",
      value: { autoStart: false },
    };
  }
  if (w.idleTimeoutMs <= 0) {
    return {
      ...base,
      detail: "on; idle auto-stop disabled (daemon.idle-timeout 0) -- stays up until `agent stop`",
      value: { autoStart: true, idleTimeoutMs: 0 },
    };
  }
  // lastActivityMs is the in-daemon watchdog's own rule (the later of the heartbeat and the last
  // real model call; liveness pings are NOT activity). With neither recorded, idle/remaining are
  // unknown: the daemon's baseline also includes a startedAtMs the probe cannot see, so no
  // precise window is faked.
  const lastActivity = lastActivityMs({ inferenceMs: w.lastRequestMs, ensureAtMs: w.lastEnsureAt });
  const idleMs = lastActivity > 0 ? Math.max(0, w.now - lastActivity) : null;
  const remainingMs = idleMs === null ? null : Math.max(0, w.idleTimeoutMs - idleMs);
  const ago = (at: number | null): string =>
    at === null ? "none" : `${formatDuration(w.now - at)} ago`;
  const detail = [
    `auto-stops in ${remainingMs === null ? "unknown" : formatDuration(remainingMs)} (idle window ${formatDuration(
      w.idleTimeoutMs,
    )})`,
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
  // checkRuntimePort only proves SOMETHING answers; a foreign service on the port would read
  // green there while every agent request misroutes. Warn-only, full+proxy scope. The probe
  // gates on proxyExpected, so a target with no route to the port always arrives with
  // identityConfirmed null.
  const base = { ...meta("runtime.identity"), profile: f.profile };
  if (!p.reachable || p.identityConfirmed === null) {
    // Nothing reachable (runtime.port owns that verdict) or identity not probed.
    const notProbed = f.proxyExpected
      ? "identity not probed"
      : `not probed (no agent routes to port ${f.port}; Codex + Claude are both direct)`;
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
    detail: `a non-copilot-api service is listening on port ${f.port} (no x-trace-id); agent requests would misroute to it`,
    fix: `free the port (stop the foreign process), then ${agentStartCommand(f.profile)}`,
    value: { reachable: true, confirmed: false },
  };
}

export function checkRuntimeOrphan(f: RuntimeTarget, p: DaemonProbeFacts): CheckResult {
  // One exhaustive switch over the probe's PortState (classifyPortState in facts.ts); this check
  // never re-derives who holds the port. Full+proxy scope.
  const base = { ...meta("runtime.orphan"), profile: f.profile };
  const state = p.portState;
  switch (state.kind) {
    case "foreign":
      // The detail must not claim the tracked daemon owns the port when identity says the
      // responder is foreign (pidTracked only proves the saved pid is a copilot-api process,
      // not that it owns THIS port); runtime.identity owns that wording.
      return {
        ...base,
        status: "ok",
        detail: "port responder is not copilot-api (see proxy identity)",
        value: { orphan: false },
      };
    case "unrouted":
      // Something answers, but both agents are direct, so no proxy is required: the both-direct
      // gate, not the facts, is why this is not an orphan warning. Identity is never probed for
      // such a target, so nothing here proves who owns the port either.
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
      const stopFix = agentStopCommand(f.profile);
      // An unproven identity scan means "not the tracked daemon" was never established: the
      // responder may well BE it. Warn with the honest detail instead of the orphan claim.
      if (p.pidScanUnproven && p.trackedPid !== null) {
        return {
          ...base,
          status: "warn",
          detail: `a process is on port ${f.port}, but the tracked pid ${p.trackedPid} could not be verified (the process scan failed) - it may be the tracked daemon`,
          fix: "re-run `agent health` from a shell that can read the process table",
          value: { orphan: null, trackedPid: p.trackedPid, scanUnproven: true },
        };
      }
      // Identity confirmed copilot-api, or indeterminate (probe failed): never over-claim.
      const what =
        state.identity === "confirmed" ? "copilot-api" : "a process (identity unconfirmed)";
      return {
        ...base,
        status: "warn",
        detail: `${what} is on port ${f.port} but is not the tracked daemon (orphaned -- started outside 'agent start', or the run-state was cleared)`,
        fix: `${stopFix}, then ${agentStartCommand(f.profile)} (re-tracks the daemon)`,
        value: { orphan: true, trackedPid: p.trackedPid },
      };
    }
  }
}

/** The ok line once slot and home agree: a proxy slot with no port recorded on this host says so,
 *  because its daemon was not probed. */
function profileAgreementDetail(f: NamedRuntimeTarget): string {
  if (f.slot.mode === "proxy" && !f.portPersisted) {
    return (
      "store slot (proxy) and daemon home agree; no port recorded on this host yet, " +
      `so the daemon was not probed (${agentStartCommand(f.profile)} records one)`
    );
  }
  if (f.slot.mode === "proxy") return "store slot (proxy) and daemon home agree";
  if (f.homeExists) return "store slot (direct); the leftover daemon home is unused";
  return "store slot (direct); no daemon home needed";
}

/**
 * NAMED targets only: do the store slot (credential + mode, the source of truth) and the on-disk
 * daemon home (derived, proxy mode only) agree? Only the slot write is atomic; `agent profile`
 * commits it BEFORE the wiring and deletes it BEFORE the home (src/commands/profile.ts), so each
 * lone half names the step that did not finish, and the fix is the command that finishes it.
 * Never a failure: the profile's own runtime rows own hard verdicts.
 *
 *   home, no slot        -> del stopped after the slot
 *   proxy slot, no home  -> add stopped before the wiring landed
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
    const fix = `agent profile ${name} add --direct|--proxy (or agent profile ${name} del)`;
    return homeExists
      ? {
          ...base,
          status: "warn",
          detail: "profile home exists but no store slot (half-created)",
          fix,
        }
      : {
          // Only reachable when the profile vanished between the sweep and this read (its name
          // came from the slots+homes union).
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
      fix: `agent profile ${name} add --direct|--proxy`,
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
  return { ...base, status: "ok", detail: profileAgreementDetail(f) };
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
  // Target discovery never ran: the empty census proves nothing, so keep the warn + fix but
  // never the confident "not wired" claim.
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
        detail: "enabled (the `shell.launchers` config key; `agent profile env` defines them)",
      }
    : {
        ...base,
        status: "warn",
        detail: "not enabled (optional)",
        fix: configSetCommand("shell.launchers", "true"),
      };
}

/** The one check family whose id is minted outside the descriptor table: the CLI list is runtime
 *  data (see CHECK_DESCRIPTORS). */
export function checkCli(c: CliFacts): CheckResult {
  const base: Pick<CheckResult, "id" | "label" | "group" | "scopes" | "profile"> = {
    id: `setup.cli.${c.command}`,
    label: `${c.name} (${c.command})`,
    group: "setup",
    scopes: SETUP,
    profile: null,
  };
  const value = { command: c.command };
  switch (c.look.kind) {
    case "found":
      return {
        ...base,
        value: { ...value, resolved: c.look.path },
        status: "ok",
        detail: c.look.path,
      };
    case "absent":
      return {
        ...base,
        value: { ...value, resolved: null },
        status: "warn",
        detail: "not installed (optional)",
        fix: "agent shell --clis",
      };
    default:
      return assertNever(c.look);
  }
}

/** The default's trailing lines: its named profiles, and the identity pin that overrides the
 *  per-credential identity probe (the knob a fine-grained PAT needs, copilot-developer-cli, when
 *  auto-detection is off). */
function defaultAuthTail(f: DefaultAuthFacts): string[] {
  const tail: string[] = [];
  const profileEntries = Object.entries(f.profiles).sort(([a], [b]) => byCodeUnit(a, b));
  if (profileEntries.length > 0) {
    const summary = profileEntries
      .map(([entry, s]) => `${entry} (${s.provider ?? "no auth"}, ${s.mode ?? "no mode"})`)
      .join(", ");
    tail.push(`named profiles: ${summary}`);
  }
  if (f.pinnedIntegrationId !== null) {
    const getCommand = configGetCommand("identity");
    tail.push(`Copilot integration id pinned to '${f.pinnedIntegrationId}' (\`${getCommand}\`)`);
  }
  return tail;
}

/** No provider chosen (or, for a named profile, no slot at all): a warn, never OK. */
function noProviderAuthOutcome(
  name: Profile,
  slot: ProfileAuthFacts | null,
  tail: string[],
): CheckOutcome {
  if (name === null) {
    return {
      status: "warn",
      detail: [
        "not authenticated: no credential provider is configured",
        "run `agent auth` (neither Direct nor `agent start` works without one)",
        ...tail,
      ].join("\n"),
      fix: agentAuthCommand(name),
    };
  }
  // A slot with no recorded mode (or none at all) needs an explicit mode flag on the re-add;
  // with a mode recorded the bare re-add keeps it (sticky).
  const fix =
    slot === null || slot.mode === null
      ? `agent profile ${name} add --direct|--proxy`
      : profileAddFix(name);
  return {
    status: "warn",
    detail: [
      `no credential recorded for profile '${name}'`,
      "named profiles never fall back to the default credential",
    ].join("\n"),
    fix,
  };
}

/** Why nothing resolves, naming the account on the gh lines (no hidden information). */
function unresolvedAuthReason(f: AuthFacts, provider: AuthProvider, unproven: boolean): string {
  if (provider !== "gh-cli") {
    return f.profile === null
      ? "the stored token is missing"
      : "the slot's stored token is missing";
  }
  const pin = f.ghUser ?? null;
  const accountClause = ghAccountClause(pin, f.ghActiveLogin ?? null);
  if (unproven) return ghCouldNotCheck(f.ghDetail, accountClause);
  if (pin === null) return `\`gh\` is unauthenticated (${accountClause})`;
  return `\`gh\` is not authenticated as account '${pin}'`;
}

/** A proven gh miss's fix: gh's login, or the default's other way out (another provider); a named
 *  slot is re-provisioned instead. */
function ghLoginFix(f: AuthFacts): string {
  const name = f.profile;
  const pin = f.ghUser ?? null;
  let orElse: string;
  if (name !== null) {
    orElse = `\`${agentAuthCommand(name)}\` to re-provision the profile`;
  } else if (pin === null) {
    orElse = "`agent auth` to switch provider";
  } else {
    orElse = "`agent auth` to switch";
  }
  if (pin === null) return `\`gh auth login\`, or ${orElse}`;
  return `\`gh auth login\` for that account, or ${orElse}`;
}

/** A chosen provider nothing resolves for. An unproven gh probe keeps this warn arm (nothing was
 *  shown to resolve) but must not claim gh IS unauthenticated: `gh auth token` never ran to
 *  completion, so the `gh auth login` advice would be handed out unearned. */
function unresolvedAuthOutcome(f: AuthFacts, provider: AuthProvider, tail: string[]): CheckOutcome {
  const name = f.profile;
  const unproven = provider === "gh-cli" && f.ghAuthUnproven === true;
  const where = name === null ? "is selected" : `is recorded for profile '${name}'`;
  const headline = unproven
    ? `provider 'gh-cli' ${where} but its credential could not be checked`
    : `provider '${provider}' ${where} but no credential resolves`;
  const fix = provider === "gh-cli" && !unproven ? ghLoginFix(f) : agentAuthCommand(name);
  return {
    status: "warn",
    detail: [headline, unresolvedAuthReason(f, provider, unproven), ...tail].join("\n"),
    fix,
  };
}

/** How the credential is minted: the gh call that serves it, naming the account, or the stored
 *  token. */
function credentialSource(f: AuthFacts, provider: AuthProvider): string {
  if (provider !== "gh-cli") return "stored GitHub token";
  const pin = f.ghUser ?? null;
  const followed = f.ghActiveLogin ?? null;
  if (pin !== null && f.ghCommand === undefined) return `gh CLI (\`gh auth token --user ${pin}\`)`;
  if (pin !== null) return `gh CLI (\`${f.ghCommand}\`, account ${pin})`;
  if (followed !== null) return `gh CLI (\`gh auth token\`, AUTO - currently account ${followed})`;
  return "gh CLI (`gh auth token`, AUTO - follows gh's active account)";
}

/** Where the resolved credential goes: Direct's resolver, the daemon, or both. */
function credentialUsage(name: Profile, mode: ProfileMode | null): string {
  if (name === null) {
    return "resolved by `agent auth --get` for Direct; passed to the proxy on `agent start`";
  }
  const authFix = agentAuthCommand(name);
  if (mode === "proxy") {
    return `resolved by \`${authFix} --get\`; passed to the profile's daemon on \`${agentStartCommand(name)}\``;
  }
  if (mode === "direct") return `resolved by \`${authFix} --get\` for Direct`;
  return `resolved by \`${authFix} --get\``;
}

/**
 * One credential line per target. The default's status is driven by the store's default
 * credential; named profiles surface there as a detail line only, because a named profile never
 * falls back to the default credential: its own line (a narrowed run's) warns when nothing
 * resolves, even while the default `setup.auth` is green. A named `slot` of null means the store
 * carries no slot at all (a half-created, home-only profile).
 */
export function checkAuth(f: AuthFacts): CheckResult {
  const name = f.profile;
  const slot: ProfileAuthFacts | null =
    f.profile === null ? { provider: f.provider, mode: null } : f.slot;
  const resolution = {
    storedToken: f.storedToken,
    ghAuthenticated: f.ghAuthenticated,
    ...(f.ghAuthUnproven ? { ghAuthUnproven: true } : {}),
  };
  const tail = f.profile === null ? defaultAuthTail(f) : [];
  const base = {
    ...meta("setup.auth"),
    profile: name,
    value:
      f.profile === null
        ? {
            ...resolution,
            provider: f.provider,
            profiles: f.profiles,
            pinnedIntegrationId: f.pinnedIntegrationId,
          }
        : { provider: slot?.provider ?? null, mode: slot?.mode ?? null, ...resolution },
  };
  // Provider classification is storedCredentialKind()'s (env_state.ts); a chosen-but-unresolved
  // provider is a warn, not OK.
  if (slot === null || slot.provider === null) {
    return { ...base, ...noProviderAuthOutcome(name, slot, tail) };
  }
  const provider = slot.provider;
  const resolves = credentialResolves(
    storedCredentialKind(provider, f.storedToken),
    f.ghAuthenticated,
  );
  if (!resolves) return { ...base, ...unresolvedAuthOutcome(f, provider, tail) };
  const mode = name === null ? "" : `, mode: ${slot.mode ?? "none"}`;
  return {
    ...base,
    status: "ok",
    detail: [
      `credential: ${credentialSource(f, provider)} (provider: ${provider}${mode})`,
      credentialUsage(name, slot.mode),
      ...tail,
    ].join("\n"),
  };
}

/** Mirrors `agent update --auto-status`. */
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
  // One fact per line: the report renders each as its own sub-item.
  const last = f.lastCheckMs > 0 ? new Date(f.lastCheckMs).toISOString() : "never";
  const detail = [
    `status: ${f.enabled ? "enabled" : "disabled"} (the update.auto config key)`,
    `cooldown ${f.cooldownDays}d`,
    `last check ${last}`,
    `last result: ${f.lastResult || "(none)"}`,
  ].join("\n");
  if (f.enabled && f.lastResult.startsWith("error:")) {
    return { ...base, status: "warn", detail, fix: "agent update --auto-status" };
  }
  return { ...base, status: "ok", detail };
}

/** One target's runtime block. Per-daemon rows render exactly for the targets whose daemon was
 *  interrogated (the probe's `probed` arm), so a row can never describe a probe that did not
 *  happen. */
function runtimeChecks(target: RuntimeTarget): CheckResult[] {
  const out: CheckResult[] = [];
  if (target.profile !== null) out.push(checkProfileConsistency(target));
  const probe = target.probe;
  if (probe.kind === "skipped") return out;
  out.push(checkRuntimePort(target, probe), checkRuntimePid(target, probe));
  out.push(checkRuntimePaths(target), checkRuntimeWatchdog(target));
  out.push(checkRuntimeIdentity(target, probe), checkRuntimeOrphan(target, probe));
  return out;
}

/** The agent rows in report order: each agent's wiring, then its live probe, with Codex's host
 *  farm and the Claude Desktop library between. */
function agentChecks(facts: HealthFacts): CheckResult[] {
  const runProfile = facts.profile ?? null;
  const out: CheckResult[] = [];
  if (facts.codex) out.push(checkCodex(facts.codex, runProfile));
  if (facts.codexLive) out.push(checkAgentLive("codex", facts.codexLive, runProfile));
  if (facts.codexHost) out.push(checkCodexHost(facts.codexHost));
  if (facts.claude) out.push(checkClaude(facts.claude, runProfile));
  if (facts.claudeDesktop) out.push(checkClaudeDesktop(facts.claudeDesktop));
  if (facts.claudeLive) out.push(checkAgentLive("claude", facts.claudeLive, runProfile));
  return out;
}

export function evaluateAll(scope: HealthScope, facts: HealthFacts): CheckResult[] {
  const out: CheckResult[] = [];
  if (facts.bootstrap) {
    out.push(
      checkCliVersion(facts.bootstrap),
      checkRuntime(facts.bootstrap),
      checkNodeModules(facts.bootstrap),
    );
  }
  if (facts.proxy) out.push(checkProxyPackage(facts.proxy), checkProxyResolved(facts.proxy));
  // One runtime block per target, in gather order.
  for (const target of facts.runtimes ?? []) out.push(...runtimeChecks(target));
  if (facts.shell) out.push(checkShellIntegration(facts.shell), checkLaunchers(facts.shell));
  for (const c of facts.clis ?? []) out.push(checkCli(c));
  if (facts.auth) out.push(checkAuth(facts.auth));
  out.push(...agentChecks(facts));
  if (facts.autoupdate) out.push(checkAutoupdate(facts.autoupdate));
  // The single source of the scope rule, shared with the --json path and the unit tests.
  return filterByScope(out, scope);
}
