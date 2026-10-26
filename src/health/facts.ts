// The fact shapes of `agent health`: the vocabulary between the I/O gatherer (probe.ts) and the
// pure evaluators (checks.ts). Data only; the two functions here are pure projections, so a
// hand-built fixture is as valid as a gathered one.
import type { AutoupdateData } from "../autoupdate/state.ts";
import type { ClaudeWiringStatus } from "../claude/config.ts";
import type { ClaudeDesktopStatus } from "../claude/desktop_status.ts";
import type { CodexWiringStatus } from "../codex/inspect.ts";
import type { AuthProvider, ProfileMode } from "../copilot_api/env_state.ts";
import type { CopilotApiPaths } from "../copilot_api/paths.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import type { ProxyVersionStatus } from "../copilot_api/version.ts";
import type { CommandLook } from "../utils/command.ts";

/** A projection, never a second hand-maintained shape. */
type RuntimePathsView = Pick<
  CopilotApiPaths,
  "home" | "configFile" | "runDir" | "stateFile" | "logFile" | "sqliteDb"
>;

/** THE single place that picks the fields, so adding one cannot drift between the default and
 *  named targets. */
export function runtimePathsView(p: CopilotApiPaths): RuntimePathsView {
  return {
    home: p.home,
    configFile: p.configFile,
    runDir: p.runDir,
    stateFile: p.stateFile,
    logFile: p.logFile,
    sqliteDb: p.sqliteDb,
  };
}

/** Never tokens. One profileSlot() call snapshots the WHOLE slot from a single store read, so
 *  consumers pairing its fields (provider + token presence, say) can never see a torn
 *  combination under a concurrent credential write. */
export interface ProfileSlotFacts {
  /** The store holds a slot for the name; false is a half-created, home-only profile. */
  exists: boolean;

  /** credentialProvider() over the slot's credential; null when no provider is recorded. */
  provider: AuthProvider | null;

  /** The recorded mode the wiring derives from; `proxy` is what makes a daemon expected. */
  mode: ProfileMode | null;

  /** The slot holds a provisioned token (classifies the Direct credential path). */
  storedToken: boolean;

  /** gh-cli only: the slot's pinned gh account, or null = follow gh's active account. */
  ghUser: string | null;
}

/** Reconciled ONCE at probe time, so runtime.orphan's verdict is a single derivation instead of
 *  every consumer re-combining the raw reads. A foreign responder is runtime.identity's verdict,
 *  so it is its own state, never an "orphan": the two checks cannot double-warn. */
export type PortState =
  | { kind: "down" }
  /** Something answers, but no agent routes to the port (both agents direct); its occupant is
   *  not ours to judge. */
  | { kind: "unrouted" }
  | { kind: "tracked" }
  /** The responder is NOT copilot-api (no x-trace-id): a foreign listener. */
  | { kind: "foreign" }
  /** copilot-api ("confirmed") or an unprobed responder ("unconfirmed") outside our tracking:
   *  started outside `agent start`, or the run-state was cleared. */
  | { kind: "orphan"; identity: "confirmed" | "unconfirmed" };

/** Exported for its unit tests and the test fixtures, so a hand-built probe can never carry a
 *  torn verdict. */
export function classifyPortState(f: {
  proxyExpected: boolean;
  reachable: boolean;
  pidTracked: boolean;
  identityConfirmed: boolean | null;
}): PortState {
  if (f.identityConfirmed === false) return { kind: "foreign" };
  if (!f.proxyExpected) return f.reachable ? { kind: "unrouted" } : { kind: "down" };
  if (!f.reachable) return { kind: "down" };
  if (f.pidTracked) return { kind: "tracked" };
  return { kind: "orphan", identity: f.identityConfirmed === true ? "confirmed" : "unconfirmed" };
}

/** The raw reads of one interrogated daemon, plus the reconciled PortState. Two reads carry a
 *  "failed to look" or "did not look" state of their own, so a renderer never turns a missing read
 *  into a confident stale, orphan, or foreign verdict:
 *    pidScanUnproven set     -> the tracked-pid identity scan FAILED (classifyDaemonPid "unknown"):
 *                               pidTracked false is UNPROVEN and renders "could not be verified"
 *    identityConfirmed null  -> not probed: port down, the fast `runtime` scope, or proxyExpected
 *                               false (no agent routes to the port, so its occupant is not ours
 *                               to interrogate)
 *  pidScanUnproven is optional so hand-built probe fixtures stay valid. */
export interface DaemonProbeFacts {
  /** `GET /` on the loopback origin answered within the timeout, whoever the responder is. */
  reachable: boolean;

  /** The pid the same run-state snapshot as the port records; null when none is tracked. */
  trackedPid: number | null;

  /** The tracked pid is a live daemon of ours (classifyTrackedPid "yes"); none tracked is "no". */
  pidTracked: boolean;

  /** The tracked-pid scan FAILED: pidTracked false is then UNPROVEN, never "proven not ours". */
  pidScanUnproven?: true;

  /** The tracked pid is not provably dead (pidLiveness), whoever holds it now; false if none. */
  pidAlive: boolean;

  /** true = copilot-api (x-trace-id present), false = a foreign listener, null = not probed. */
  identityConfirmed: boolean | null;

  /** classifyPortState over the reads above, reconciled ONCE so no consumer re-combines them. */
  portState: PortState;
}

export type DaemonProbed = { kind: "probed" } & DaemonProbeFacts;

/** THE row gate: per-daemon rows render exactly for `probed` targets, so a row can never
 *  describe a probe that did not happen, and probe-shaped fields cannot exist without the probe.
 *  `why` (never rendered) records which skip rule fired. Mirrors LiveProbeFacts. */
type DaemonProbe = { kind: "skipped"; why: string } | DaemonProbed;

/** One daemon target: the default (profile null) or a named profile's isolated daemon.
 *  Gathering is READ-ONLY: the port comes from the same run-state snapshot as the pid
 *  (proxyStatus's rule), with copilotApiFallbackPort's non-reserving fallback when none is
 *  recorded. Health never reserves a port or creates a file.
 *
 *  The default target's `proxyExpected` is defaultSetupNeedsProxy: false only when both agents
 *  are wired direct AND Claude's base URL is not the local proxy. A NAMED target's daemon is
 *  probed, and earns rows, only on a persisted port: an unpersisted candidate is a guess no daemon
 *  or wiring has spoken for, so probing it could only misattribute whatever answers. */
export interface RuntimeTargetCommon {
  /** When false, a down daemon is not a failure (the default target: defaultSetupNeedsProxy). */
  proxyExpected: boolean;

  /** The snapshot's recorded port, else copilotApiFallbackPort's non-reserving candidate. */
  port: number;

  /** The port is the snapshot's own, not the fallback; a NAMED daemon is probed only then. */
  portPersisted: boolean;

  /** The target's runtime files (home, config, run dir, state, log, sqlite), for the Paths row. */
  paths: RuntimePathsView;

  /** Idle auto-stop watchdog state, observed from outside the daemon. */
  watchdog: WatchdogFacts;
}

/** Always interrogated: the fast `runtime` probe scope is a contract of this daemon alone. */
export type DefaultRuntimeTarget = RuntimeTargetCommon & {
  profile: null;
  probe: DaemonProbed;
};

/** The store slot and on-disk home are always read; the daemon itself is interrogated only per
 *  gatherNamedTarget's policy. */
export type NamedRuntimeTarget = RuntimeTargetCommon & {
  /** The report heads this target's Runtime section by it, with the slot's recorded mode beside. */
  profile: ProfileName;

  /** The credential store slot (one snapshot; see ProfileSlotFacts). */
  slot: ProfileSlotFacts;

  /** The daemon home is on disk; with no slot, a home alone still makes a daemon expected. */
  homeExists: boolean;

  /** Skipped (with `why`) unless a proxy is expected, the home exists, AND the port persisted. */
  probe: DaemonProbe;
};

export type RuntimeTarget = DefaultRuntimeTarget | NamedRuntimeTarget;

/** The two activity signals are the `lastEnsureAt` heartbeat and `lastRequestMs`, the in-process
 *  observer's persisted `.activity.json` mark; neither moves on liveness `GET /` pings, so
 *  health's own probes never perturb what they report. `now` is captured at probe time so the
 *  evaluator stays pure. */
export interface WatchdogFacts {
  autoStart: boolean;
  idleTimeoutMs: number;
  lastEnsureAt: number | null;
  lastRequestMs: number | null;
  now: number;
}

export interface BootstrapFacts {
  /** packageVersion(): package.json's version, "0.0.0" when it carries none. */
  cliVersion: string;

  /** The bun this process runs on; the daemon's too, spawned from runtimePath as a bun CLI. */
  runtimeVersion: string;

  /** process.execPath, this very executable, which the proxy daemon is spawned from. */
  runtimePath: string;

  /** null as a compiled binary: dependencies are embedded, so there is no node_modules to judge. */
  nodeModules: { present: boolean; fresh: boolean } | null;
}

/** The proxy float's resolution as health reads it. */
interface ProxyResolvedFacts {
  /** The install tree's, when one is complete (the version that runs); else the record's. */
  version: string;

  /** The record's; 0 when a complete tree stands with no record (a record write the swap outran). */
  resolvedAtMs: number;

  /** True when the proxy home's install tree is complete for `version`. */
  installed: boolean;
}

/** The proxy package and float as health reads them. `floatSkips` is the float's own skip
 *  predicate (proxyFloatSkips, delegating to proxyUnusedEverywhere in src/agents/wiring.ts);
 *  `resolved` is null while nothing has installed the proxy into the proxy home yet. */
export interface ProxyFacts {
  /** The version that would RUN: the float's install tree, else the node_modules copy. */
  version: string | null;

  /** null when the project config could not be read (see configError). */
  bounds: ProxyVersionStatus | null;

  /** Why the project config (copilot-env.config) could not be read; null when it could. */
  configError: string | null;

  /** The proxy float's cooldown window in seconds (null if it couldn't be read). */
  cooldownSeconds: number | null;

  /** When the float skips, the version bounds are unenforceable and must not read as a failure. */
  floatSkips: boolean;

  /** null until the float first resolves here: a fresh checkout, or a Direct-only install. */
  resolved: ProxyResolvedFacts | null;

  /** Compiled binary: no node_modules holds a proxy version, so the proxy runs only floated. */
  standalone: boolean;
}

export interface ShellFileFact {
  path: string;
  hasIntegration: boolean;
}

/** The shell integration as health reads it. `targetsUnproven` is set when shell-target DISCOVERY
 *  itself failed to run (resolving the profile paths shells out to PowerShell on Windows and can
 *  throw): `files` is then an empty, UNPROVEN census, so the check says "could not check" instead
 *  of a confident "not wired"; optional so hand-built fixtures stay valid.
 *
 *  `launchersWired` is the `shell.launchers` config key: the cl/co/cx launchers are `agent profile
 *  env` emissions gated on it, so the key, not any rc marker, is what "wired" means. */
export interface ShellFacts {
  /** Every rc file the shell targets (deps.shellTargets), with whether it holds the MARKER. */
  files: ShellFileFact[];

  /** At least one targeted file holds the block. */
  integrationWired: boolean;

  /** Target discovery itself threw, so `files` is an empty, UNPROVEN census: "could not check". */
  targetsUnproven?: true;

  /** The `shell.launchers` config key, which gates the cl/co/cx launchers; no rc marker does. */
  launchersWired: boolean;
}

export interface CliFacts {
  command: string;
  name: string;
  look: CommandLook;
}

/** How far a Direct gh probe got before it missed: no resolved gh (absent from PATH, or a command
 *  probe that never ran; `kind` says which), or a found gh whose `gh auth token` call missed, with
 *  `ghDetail` the look's own account of why (the gh call that failed or timed out, quoted, with
 *  what the completed calls before it said). */
type GhProbeMiss = { command: null } | { command: string; ghDetail: string };

/** The gh-cli Direct auth verdict, `kind` in GhTokenLook's vocabulary:
 *    found     -> authenticated; `ghCommand` is the gh call that served the token (the pinned
 *                 `--user` form for a pin, the plain host-scoped call for gh's active account)
 *    absent    -> a proven miss: no gh on PATH, or gh served no token
 *    unproven  -> `gh auth token` spawned but never RAN to completion (it errored or was
 *                 timeout-killed): renderers say "could not check",
 *                 never a confident "not found"/"not authenticated" or `gh auth login` advice
 *  `ghUser` names the account a pinned verdict is about and `ghActiveLogin` the one an auto slot
 *  follows, so the report can name either; both are optional so hand-built fixtures stay valid. */
export type CodexDirectAuthFacts = {
  /** The pinned account asked about (`gh auth token --user`); absent/null = gh's active account. */
  ghUser?: string | null;

  /** AUTO slots only: gh's active github.com login, when readable; naming only, never a verdict. */
  ghActiveLogin?: string | null;
} & (
  | { kind: "found"; command: string; ghCommand: string }
  | ({ kind: "absent" } & GhProbeMiss)
  | { kind: "unproven"; command: string; ghDetail: string }
);

export type LiveProbeFacts =
  | { kind: "skipped"; reason: "not-installed" }
  | { kind: "ok"; cli: string }
  | { kind: "failed"; cli: string; detail: string };

/** Static wiring only: whether the baked value still equals what the wiring would bake now.
 *    fresh      -> equal to the store's token (direct) or the daemon's API key (proxy)
 *    stale      -> differs; the next wiring pass fixes it
 *    unchecked  -> nothing to compare against: a gh-cli slot (resolved live), no store token or
 *                  daemon key, or a store that could not be read */
export type BakedCredentialFreshness = "fresh" | "stale" | "unchecked";

/** Codex's wiring plus the store facts the check frames a credential miss with.
 *    provider         -> omitted for a static wiring: the store is then consulted for
 *                        `bakedCredential` alone, and only best-effort
 *    expectedMode     -> the store slot's recorded mode, the source of truth the wiring derives
 *                        from; a wiring whose managed mode disagrees is an interrupted rewire,
 *                        never green
 *    directNeedsNoGh  -> the wiring execs `agent auth --get` AND the store classifies the
 *                        credential as a stored token, or the wiring is static (the value sits in
 *                        the config, whatever the slot's provider); distinct from the wiring's own
 *                        `directUsesToken`, a pure CONFIG fact */
export type CodexFacts = CodexWiringStatus & {
  /** The CODEX_HOME inspected, from the ProbeDeps seam (deps.codexHome). */
  home: string;

  /** directAuthFor's gh verdict for this wiring; a token or static shape gets the unprobed row. */
  directAuth: CodexDirectAuthFacts;

  /** The slot's provider, framing a non-gh-cli credential miss; omitted for a static wiring. */
  provider?: AuthProvider | null;

  /** Named runs only: the store slot's recorded mode, which the managed mode must match. */
  expectedMode?: ProfileMode | null;

  /** Direct only: no `gh` login needed, per directAuthFor: a stored token, or a static wiring. */
  directNeedsNoGh: boolean;

  /** Present only for a static wiring. */
  bakedCredential?: BakedCredentialFreshness;
};

/** Claude's wiring plus the same store facts as CodexFacts (`provider`, `expectedMode`, and
 *  `bakedCredential` read alike). `directUsesToken` holds because a GitHub token is provisioned in
 *  the store for the resolver (`agent auth --get`) or because the wiring is static. */
export type ClaudeFacts = ClaudeWiringStatus & {
  /** The Claude config dir inspected, from the ProbeDeps seam (deps.claudeHome). */
  home: string;

  /** settingsPathFor(home, profile): settings.json, or a named profile's settings-<name>.json. */
  settingsPath: string;

  /** directAuthFor's gh verdict for this wiring; a token or static shape gets the unprobed row. */
  directAuth: CodexDirectAuthFacts;

  /** The slot's provider, framing a non-gh-cli credential miss; omitted for a static wiring. */
  provider?: AuthProvider | null;

  /** Narrowed named runs only: the profile's recorded mode (see CodexFacts). */
  expectedMode?: ProfileMode | null;

  /** Direct only, else false: no `gh` login needed (a provisioned store token or static wiring). */
  directUsesToken: boolean;

  /** Present only for a static wiring. */
  bakedCredential?: BakedCredentialFreshness;
};

export interface CodexHostFacts {
  /** The per-host CODEX_HOME farm needs POSIX symlinks (Linux/macOS, not Windows). */
  supported: boolean;

  /** The per-host CODEX_HOME path (~/.codex/hosts/<hostname>). */
  hostHome: string;

  /** The farm directory is on disk (codexHostFarm's `present`), whether or not it is wired. */
  exists: boolean;

  /** Its real-path config.toml selects the managed provider (codexHostFarm's predicate). */
  wired: boolean;

  /** A farm probe failed for a reason other than absence (present/wired unproven). */
  probeError: string | null;

  /** Run state records it as the active CODEX_HOME (set only after a successful write). */
  active: boolean;

  /** The `codex.host` key (stored else default; always false on Windows). */
  enabled: boolean;
}

/** The persisted state plus the effective cooldown, which is the LIVE `update.cooldown` config
 *  (never snapshotted into state), so `agent health` matches `agent update --auto-status`. */
export type AutoupdateStatus = AutoupdateData & { enabled: boolean; cooldownDays: number };

/** Every fact a run gathered. A group is absent when its scope did not run or, for an account-wide
 *  group (bootstrap, proxy, shell, clis, codexHost, claudeDesktop, autoupdate), when the run was
 *  narrowed to a profile. `claudeDesktop` is judged against the `claude.desktop` key, which is
 *  root-wide. */
export interface HealthFacts {
  /** The narrowing (null/absent = the whole environment); the codex/claude/live checks carry it. */
  profile?: Profile;

  /** RUNTIME_SCOPES: the run's one daemon target, the default's or the narrowed profile's. */
  runtimes?: RuntimeTarget[];

  /** BOOTSTRAP_SCOPES, whole-environment runs only. */
  bootstrap?: BootstrapFacts;

  /** BOOTSTRAP_SCOPES, whole-environment runs only; the package and float, not the daemon. */
  proxy?: ProxyFacts;

  /** SETUP_SCOPES, whole-environment runs only. */
  shell?: ShellFacts;

  /** SETUP_SCOPES, whole-environment runs only: each AGENT_CLIS entry's PATH look. */
  clis?: CliFacts[];

  /** AUTH_SCOPES: the run's credential line, the default's or the narrowed profile's own slot. */
  auth?: AuthFacts;

  /** CODEX_SCOPES; a narrowed run inspects the profile's own `<name>.config.toml` selection. */
  codex?: CodexFacts;

  /** SETUP_SCOPES, whole-environment runs only; the per-host CODEX_HOME farm. */
  codexHost?: CodexHostFacts;

  /** CLAUDE_SCOPES; a narrowed run inspects the profile's own settings-<name>.json. */
  claude?: ClaudeFacts;

  /** CLAUDE_SCOPES, whole-environment runs only: the Desktop library spans every profile. */
  claudeDesktop?: ClaudeDesktopStatus;

  /** CODEX_LIVE_SCOPES, under `--live` only: a real model call through the configured home. */
  codexLive?: LiveProbeFacts;

  /** CLAUDE_LIVE_SCOPES, under `--live` only: a real model call through the configured home. */
  claudeLive?: LiveProbeFacts;

  /** SETUP_SCOPES, whole-environment runs only; the persisted state plus the live cooldown. */
  autoupdate?: AutoupdateStatus;
}

/** Never tokens. The ProfileName key of AuthFacts.profiles documents intent (TS erases a branded
 *  index to string); the actual guarantee is the producer, which sweeps the store via
 *  profileNames(), so a hand-edited invalid key never reaches the report. */
export type ProfileAuthFacts = {
  provider: AuthProvider | null;
  mode: ProfileMode | null;
};

/** The GitHub credential state of one target: the store's default credential (profile null), or
 *  a named profile's own slot, which never falls back to the default. Direct resolves the
 *  credential at fetch time via `agent auth --get`, provider-driven (`gh-cli` -> `gh`,
 *  `copilot`/`gh-token`/`gh-env` -> the stored token; no provider -> nothing).
 *
 *  `ghUser` names the pinned account a verdict is about, so the check can say which account it
 *  judged; `ghAuthUnproven` means the gh probe never ran to completion, so the check says "could
 *  not check", never "gh is unauthenticated" plus `gh auth login` advice. Both are optional so
 *  hand-built fixtures stay valid. */
export type AuthFacts = {
  /** A provisioned token sits in the store for this target; never the token itself. */
  storedToken: boolean;

  /** `gh auth token` served a token; false under ghAuthUnproven is "could not check", not "no". */
  ghAuthenticated: boolean;

  /** The pinned account asked about (`gh auth token --user`); absent/null = gh's active account. */
  ghUser?: string | null;

  /** An auto slot's followed account (see CodexDirectAuthFacts.ghActiveLogin). */
  ghActiveLogin?: string | null;

  /** The gh call that served the token (see CodexDirectAuthFacts.ghCommand). */
  ghCommand?: string;

  /** Why the look ended without a token, the failed gh call quoted (see CodexDirectAuthFacts). */
  ghDetail?: string;

  /** The gh probe never completed (kind "unproven"), so ghAuthenticated false is UNPROVEN. */
  ghAuthUnproven?: true;
} & (
  | {
      /** The default target: the store's default credential pair, never a slot. */
      profile: null;

      /** The store's recorded default provider; null when none is stored. */
      provider: AuthProvider | null;

      /** Every named slot, swept via profileNames(); a hand-edited invalid key never gets in. */
      profiles: Record<ProfileName, ProfileAuthFacts>;

      /** The `identity` config pin (integration_identity.ts), or null when probing. */
      pinnedIntegrationId: string | null;
    }
  | {
      /** A named profile's own slot alone; it never falls back to the default credential. */
      profile: ProfileName;

      /** The store slot, never tokens; null for a half-created, home-only profile with no slot. */
      slot: ProfileAuthFacts | null;
    }
);
