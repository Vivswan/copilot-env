// Pure evaluators: HealthFacts -> CheckResult[]. No I/O -- every input is a fact
// gathered by probe.ts, so each check is independently unit-testable.
import { type StoredCredential, storedCredentialKind } from "../copilot_api/env_state.ts";
import { compareDenoVersions, SIDECAR_DENO_ENV } from "../copilot_api/sidecar.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { PROXY_PACKAGE_NAME, type ProxyVersionStatus } from "../copilot_api/version.ts";
import { lastActivityMs } from "../scripts/idle_watchdog.ts";
import type { CommandLook } from "../utils/command.ts";
import { formatDuration, SECONDS_PER_DAY } from "../utils/time.ts";
import { filterByScope } from "./aggregate.ts";
import {
  checkClaude,
  checkClaudeDesktop,
  checkClaudeLive,
  checkCodex,
  checkCodexHost,
  checkCodexLive,
} from "./checks_agents.ts";
import type {
  AuthFacts,
  AutoupdateStatus,
  BootstrapFacts,
  CliFacts,
  DaemonProbeFacts,
  DefaultHomeMigrationFacts,
  HealthFacts,
  NamedRuntimeTarget,
  ProfileAuthFacts,
  ProxyFacts,
  RuntimeTarget,
  ShellFacts,
} from "./facts.ts";
import type { CheckOutcome, CheckResult, HealthScope } from "./types.ts";
import { meta, profileAddFix, SETUP_SCOPES as SETUP } from "./types.ts";

/** The `agent start` fix for a runtime target, addressed at its profile. */
function startFix(profile: Profile): string {
  return profile === null ? "agent start" : `agent start --profile ${profile}`;
}

/** THE predicate shared by checkAuth and checkProfileAuth: a stored token resolves by presence,
 *  gh-cli by the live gh probe, none never. */
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
      // A compiled install ships no deno.json baseline: the float resolves the proxy into its
      // own cache at `agent start`, so "missing" is the normal pre-start state, not a broken
      // install.
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
    // The float itself skips (proxyFloatSkips: proxy unused, no env pin), so the bounds are
    // unenforceable (the suggested fixes would not move the version) and must not read as a
    // failure. A proxy rewire or a proxy profile re-enables the float, which enforces them again.
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

/** Human label for the proxy float cooldown window (seconds, null = unknown). */
function floatCooldownLabel(seconds: number | null): string {
  if (seconds === null) return "cooldown: unknown";
  if (seconds === 0) return "no cooldown";
  if (seconds % SECONDS_PER_DAY === 0) return `cooldown ${seconds / SECONDS_PER_DAY}d`;
  return `cooldown ${seconds}s`;
}

/** A checkout runs on its own runtime; a compiled binary is not a deno CLI, so it needs one from
 *  PATH, the SIDECAR_DENO_ENV override, or the provisioned copy, and having none of the three is
 *  a failure, not a note. */
export function checkProxySidecar(f: ProxyFacts): CheckResult {
  const base = { ...meta("proxy.sidecar"), profile: null };
  const { kind, referenceVersion, denoBin, version, standalone } = f.sidecar;
  if (kind === "absent") {
    if (f.floatSkips) {
      // Direct-only: nothing spawns the proxy, so a missing deno is idle capacity, not a
      // failure. A proxy rewire re-enables the requirement.
      return {
        ...base,
        status: "ok",
        detail:
          "no deno found; not required (Codex + Claude are both direct, so the proxy is unused)",
        value: { kind, referenceVersion, standalone, floatSkips: true },
      };
    }
    return {
      ...base,
      status: standalone ? "fail" : "warn",
      detail: `no deno found (PATH or provisioned)${
        standalone ? "; a compiled build cannot spawn the proxy without one" : ""
      }`,
      fix: "install deno (https://deno.com), or `agent start` to provision one",
      value: { kind, referenceVersion, standalone },
    };
  }
  // A PATH/override deno older than the tested reference still works: warn, never block
  // (upgrading is the user's job). An unreadable version is not a verdict, so it reads ok.
  const behind = version !== null &&
    (compareDenoVersions(version, referenceVersion) ?? 0) < 0;
  const named = version === null ? "deno (version unknown)" : `deno ${version}`;
  const source = kind === "dev"
    ? "running on this checkout's own deno"
    : kind === "override"
    ? `${named} via ${SIDECAR_DENO_ENV}`
    : kind === "path"
    ? `${named} on PATH`
    : `${named} provisioned`;
  if (behind) {
    return {
      ...base,
      status: "warn",
      detail: `${source} is older than the tested ${referenceVersion}\n${denoBin}`,
      fix: "upgrade deno (`deno upgrade`, or your package manager)",
      value: { kind, referenceVersion, version, standalone },
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `${source}\n${denoBin}`,
    value: { kind, referenceVersion, version, standalone },
  };
}

/** Not resolved yet reads ok: a checkout falls back to the deno.json baseline, a compiled
 *  install waits for `agent start`. A RECORDED version whose cache has gone missing fails,
 *  because the launch asks for that exact version offline. */
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
  // Scoped to full + proxy, NOT the launchers' fast `runtime` probe (informational; reads the
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
  // checkRuntimePort only proves SOMETHING answers; a foreign service on the port would read
  // green there while every agent request misroutes. Warn-only, full+proxy scope. The probe
  // gates on proxyExpected, so a target with no route to the port always arrives with
  // identityConfirmed null.
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
      const stopFix = f.profile === null ? "agent stop" : `agent stop --profile ${f.profile}`;
      // An unproven identity scan means "not the tracked daemon" was never established: the
      // responder may well BE it. Warn with the honest detail instead of the orphan claim.
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
      // Identity confirmed copilot-api, or indeterminate (probe failed): never over-claim.
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
    const fix = `agent profile --add ${name} --direct|--proxy (or agent profile --del ${name})`;
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
      : "store slot (proxy) and daemon home agree; no port recorded on this host yet, " +
        `so the daemon was not probed (agent start --profile ${name} records one)`
    : homeExists
    ? "store slot (direct); the leftover daemon home is unused"
    : "store slot (direct); no daemon home needed";
  return { ...base, status: "ok", detail };
}

/** The account note for a gh-cli slot's verdict lines, on the failing and unproven lines too (no
 *  hidden information): the pinned login, or the account an auto slot follows right now (bare
 *  AUTO when the list was unreadable). */
function ghAccountClause(pin: string | null, followed: string | null): string {
  return pin !== null
    ? `account '${pin}'`
    : followed !== null
    ? `AUTO - currently account ${followed}`
    : "AUTO - follows gh's active account";
}

/**
 * A narrowed run's credential line, mirroring checkAuth's provider-driven verdict. `slot` null
 * means the store carries no slot at all (a half-created, home-only profile). Named profiles
 * never fall back to the default credential, so a missing or unresolvable one is a warn here
 * even when the default `setup.auth` is green.
 */
export function checkProfileAuth(
  name: ProfileName,
  slot: ProfileAuthFacts | null,
  resolution: {
    storedToken: boolean;
    ghAuthenticated: boolean;
    ghUser?: string | null;
    ghActiveLogin?: string | null;
    ghAuthUnproven?: true;
  },
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
  // A slot with no recorded mode (or none at all) needs an explicit mode flag on the re-add;
  // with a mode recorded the bare re-add keeps it (sticky).
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
  // Always name the account (no hidden information), on the failing and unproven lines too.
  const pin = resolution.ghUser ?? null;
  const followed = resolution.ghActiveLogin ?? null;
  const accountClause = ghAccountClause(pin, followed);
  if (!resolves) {
    // An unproven gh probe keeps this warn arm (the credential still is not shown to work) but
    // must not claim gh IS unauthenticated: gh was never asked.
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
            ? "could not check gh authentication " +
              `(\`gh auth token\` did not run to completion; ${accountClause})`
            : pin === null
            ? `\`gh\` is unauthenticated (${accountClause}) - run \`gh auth login\`, or re-provision the profile`
            : `\`gh\` is not authenticated as account '${pin}' - run \`gh auth login\` for that account, or re-provision the profile`
          : `the slot's stored token is missing - run \`agent auth --profile ${name}\` to re-provision`,
      ].join("\n"),
      fix: `agent auth --profile ${name}`,
    };
  }
  const how = slot.provider === "gh-cli"
    ? pin !== null
      ? `gh CLI (\`gh auth token --user ${pin}\`)`
      : followed !== null
      ? `gh CLI (\`gh auth token\`, AUTO - currently account ${followed})`
      : "gh CLI (`gh auth token`, AUTO - follows gh's active account)"
    : "stored GitHub token";
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

/** The 3.5.6 fix-up stages the flat root's daemon files under `profiles/` and flips with one
 *  rename, so a kill inside that window leaves the staging dir. Home resolution keeps answering
 *  the flat root until the flip, so this is an unfinished migration (warn), never a breakage. */
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
    // The one check family whose id is minted outside the descriptor table: the CLI list is
    // runtime data (see CHECK_DESCRIPTORS).
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
  // Named profiles surface as a detail line only: their hard-fail resolution is a per-profile
  // concern, and the default credential drives this check's status.
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
  // A pin overrides the per-credential identity probe: the knob a fine-grained PAT needs
  // (copilot-developer-cli) when auto-detection is off.
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
  // Provider classification is storedCredentialKind()'s (env_state.ts); a chosen-but-unresolved
  // provider is a warn, not OK.
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
  // Always name the account (no hidden information); see checkProfileAuth's twin.
  const pin = f.ghUser ?? null;
  const followed = f.ghActiveLogin ?? null;
  if (resolves) {
    const how = f.provider === "gh-cli"
      ? pin !== null
        ? `gh CLI (\`gh auth token --user ${pin}\`)`
        : followed !== null
        ? `gh CLI (\`gh auth token\`, AUTO - currently account ${followed})`
        : "gh CLI (`gh auth token`, AUTO - follows gh's active account)"
      : "stored GitHub token";
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
  // An unproven gh probe keeps this warn arm (nothing was shown to resolve) but must not claim
  // gh IS unauthenticated: `gh auth token` never ran to completion, so the `gh auth login`
  // advice would be handed out unearned.
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
          ? "could not check gh authentication " +
            `(\`gh auth token\` did not run to completion; ${ghAccountClause(pin, followed)})`
          : pin === null
          ? `\`gh\` is unauthenticated (${
            ghAccountClause(pin, followed)
          }) - run \`gh auth login\`, or \`agent auth\` to switch provider`
          : `\`gh\` is not authenticated as account '${pin}' - run \`gh auth login\` for that account, or \`agent auth\` to switch`
        : "the stored token is missing - run `agent auth` to re-provision",
      ...profilesLine,
      ...identityLine,
    ].join("\n"),
    fix: "agent auth",
  };
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
  // The full status whether or not autoupdate is on, matching `agent update --auto-status`. One
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
  // One runtime block per target, in gather order. Per-daemon rows render exactly for the
  // targets whose daemon was interrogated (the probe's `probed` arm), so a row can never
  // describe a probe that did not happen.
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
  // The single source of the scope rule, shared with the --json path and the unit tests.
  return filterByScope(out, scope);
}
