// The fact shapes of `agent health`: the vocabulary between the I/O gatherer (probe.ts) and the
// pure evaluators (checks.ts). Data only; the two functions here are pure projections, so a
// hand-built fixture is as valid as a gathered one.
import type { AutoupdateData } from "../autoupdate/state.ts";
import type { ClaudeWiringStatus } from "../claude/config.ts";
import type { ClaudeDesktopStatus } from "../claude/desktop_status.ts";
import type { CodexWiringStatus } from "../codex/config.ts";
import type { AuthProvider, ProfileMode } from "../copilot_api/env_state.ts";
import type { CopilotApiPaths } from "../copilot_api/paths.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import type { SidecarStatus } from "../copilot_api/sidecar.ts";
import type { ProxyVersionStatus } from "../copilot_api/version.ts";
import type { CommandLook } from "../utils/command.ts";

/** A projection, never a second hand-maintained shape. */
export type RuntimePathsView = Pick<
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
  exists: boolean;
  provider: AuthProvider | null;
  mode: ProfileMode | null;
  /** The slot holds a provisioned token (classifies the Direct credential path). */
  storedToken: boolean;
  /** gh-cli only: the slot's pinned gh account, or null = follow gh's active account. */
  ghUser: string | null;
  /** The probed direct-mode client identity NAME cached on the slot, or null. */
  integrationIdentity: string | null;
}

/** Reconciled ONCE at probe time, so runtime.orphan's verdict is a single derivation instead of
 *  every consumer re-combining the raw reads. A foreign responder is runtime.identity's verdict,
 *  so it is its own state, never an "orphan": the two checks cannot double-warn. */
export type PortState =
  /** Nothing reachable on the port. */
  | { kind: "down" }
  /** Something answers, but no agent routes to the port (both agents direct); its occupant is
   *  not ours to judge. */
  | { kind: "unrouted" }
  /** The port is held by the daemon we track. */
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

/** The raw reads of one interrogated daemon, plus the reconciled PortState. */
export interface DaemonProbeFacts {
  reachable: boolean;
  trackedPid: number | null;
  pidTracked: boolean;
  /** The tracked-pid identity scan FAILED (classifyDaemonPid "unknown"): pidTracked false is
   *  then UNPROVEN, "failed to look" rather than "proven not ours", so the renderers say "could
   *  not be verified" instead of a confident stale/orphan verdict. Optional so hand-built probe
   *  fixtures stay valid. */
  pidScanUnproven?: true;
  pidAlive: boolean;
  /** true = copilot-api (x-trace-id present), false = reachable but NOT copilot-api (a foreign
   *  listener), null = not probed (port down, the fast `runtime` scope, or proxyExpected false:
   *  no agent routes to the port, so its occupant is not ours to interrogate). */
  identityConfirmed: boolean | null;
  portState: PortState;
}

/** A probed daemon's outcome record (the `probed` arm of DaemonProbe). */
export type DaemonProbed = { kind: "probed" } & DaemonProbeFacts;

/** THE row gate: per-daemon rows render exactly for `probed` targets, so a row can never
 *  describe a probe that did not happen, and probe-shaped fields cannot exist without the probe.
 *  `why` (never rendered) records which skip rule fired. Mirrors LiveProbeFacts. */
export type DaemonProbe = { kind: "skipped"; why: string } | DaemonProbed;

/** One daemon target: the default (profile null) or a named profile's isolated daemon.
 *  Gathering is READ-ONLY: the port comes from the same run-state snapshot as the pid
 *  (proxyStatus's rule), with copilotApiFallbackPort's non-reserving fallback when none is
 *  recorded. Health never reserves a port or creates a file. */
export interface RuntimeTargetCommon {
  /** When false, a down daemon is not a failure. The default target takes it from
   *  defaultSetupNeedsProxy: false only when both agents are wired direct AND Claude's base URL
   *  is not the local proxy. */
  proxyExpected: boolean;
  port: number;
  /** The port came from the target's own run-state snapshot, not the fallback. A NAMED target's
   *  daemon is probed, and earns rows, only on a persisted port: an unpersisted candidate is a
   *  guess no daemon or wiring has spoken for, so probing it could only misattribute whatever
   *  answers. */
  portPersisted: boolean;
  paths: RuntimePathsView;
  /** Idle auto-stop watchdog state, observed from outside the daemon. */
  watchdog: WatchdogFacts;
}

/** Always interrogated: the launchers' fast readiness probe is a contract of this daemon alone. */
export type DefaultRuntimeTarget = RuntimeTargetCommon & {
  profile: null;
  probe: DaemonProbed;
};

/** The store slot and on-disk home are always read; the daemon itself is interrogated only per
 *  gatherNamedTarget's policy. */
export type NamedRuntimeTarget = RuntimeTargetCommon & {
  profile: ProfileName;
  /** The credential store slot (one snapshot; see ProfileSlotFacts). */
  slot: ProfileSlotFacts;
  /** The isolated daemon home exists on disk. */
  homeExists: boolean;
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
  cliVersion: string;
  deno: { available: boolean; version: string | null };
  /** null when running as a compiled binary: dependencies are embedded, so there
   *  is no node_modules to judge. */
  nodeModules: { present: boolean; fresh: boolean } | null;
}

/** The proxy float's resolved-version record, as health reads it back. */
export interface ProxyResolvedFacts {
  version: string;
  resolvedAtMs: number;
  denoDir: string;
  /** True when the recorded cache directory is actually on disk. */
  cached: boolean;
}

export interface ProxyFacts {
  version: string | null;
  // null when the project config could not be read (see configError).
  bounds: ProxyVersionStatus | null;
  configError: string | null;
  // The proxy float's cooldown window in seconds (null if it couldn't be read).
  cooldownSeconds: number | null;
  // The float's own skip predicate (proxyFloatSkips, delegating to
  // proxyUnusedEverywhere in src/agents/wiring.ts). When it skips, the version
  // bounds are unenforceable and must not read as a failure.
  floatSkips: boolean;
  // The float's record, or null when it has never resolved here (a fresh checkout
  // or a Direct-only install, where the deno.json baseline is what would run).
  resolved: ProxyResolvedFacts | null;
  // The deno binary every proxy spawn runs on.
  sidecar: SidecarStatus;
}

export interface ShellFileFact {
  path: string;
  hasIntegration: boolean;
  /** The file carries a LEGACY launchers rc block (retired; `agent shell` strips it). */
  hasLaunchers: boolean;
}

export interface ShellFacts {
  files: ShellFileFact[];
  integrationWired: boolean;
  /** Shell-target DISCOVERY itself failed to run (resolving the profile paths shells out to
   *  PowerShell on Windows and can throw): `files` is then an empty, UNPROVEN census, so the
   *  check says "could not check" instead of a confident "not wired". Optional so hand-built
   *  fixtures stay valid. */
  targetsUnproven?: true;
  /** The `launchers` config key: the cl/co/cx launchers are `agent env` emissions gated on it,
   *  so the key, not any rc marker, is what "wired" means. */
  launchersWired: boolean;
}

export interface CliFacts {
  command: string;
  name: string;
  /** Failure arm kept (see CommandLook): the census renders a "not installed" verdict, so an
   *  unproven look must arrive marked. */
  look: CommandLook;
}

export interface ToolFacts {
  node: CommandLook;
  npm: CommandLook;
}

export interface CodexDirectAuthFacts {
  command: string | null;
  authenticated: boolean;
  /** The pinned gh account the probe asked about (`gh auth token --user`). Absent/null = gh's
   *  active account, so renderers can name the account a pinned verdict is about. Optional so
   *  hand-built fixtures stay valid. */
  ghUser?: string | null;
  /** AUTO slots only: the github.com login gh's active credential belongs to, when the account
   *  list was readable, so the report names the account an auto slot follows. Naming only,
   *  never a verdict. */
  ghActiveLogin?: string | null;
  /** The gh look never RAN to completion (the command probe failed, or `gh auth token` spawned
   *  but errored / was timeout-killed): the two fields above are then UNPROVEN, and renderers
   *  say "could not check", never a confident "not found"/"not authenticated" or `gh auth
   *  login` advice. Optional so hand-built fixtures stay valid. */
  unproven?: true;
}

/** Skipped when the CLI is not installed (not a failure); `lookFailed` marks a skip off a look
 *  that never completed (a could-not-check, not a proven absence). A probe that RAN names the
 *  resolved CLI and a failure carries the captured reason, so a skipped-yet-ok result is
 *  unrepresentable. */
export type LiveProbeFacts =
  | { kind: "skipped"; lookFailed?: true }
  | { kind: "ok"; cli: string }
  | { kind: "failed"; cli: string; detail: string };

/** Codex wiring facts: the home being inspected plus the wiring contract status. */
export type CodexFacts = CodexWiringStatus & {
  home: string;
  directAuth: CodexDirectAuthFacts;
  /** Recorded auth provider -- lets the check frame a non-gh-cli credential miss. */
  provider?: AuthProvider | null;
  /** Narrowed named runs only: the profile's mode recorded in the store slot (the source of
   *  truth its wiring derives from); a wiring whose managed mode disagrees is an interrupted
   *  rewire, never green. */
  expectedMode?: ProfileMode | null;
  /** Direct mode only: the managed resolver (`agent auth --get`) needs no `gh` login because the
   *  wiring execs it AND the store classifies the credential as a stored token. Distinct from
   *  the wiring's own `directUsesToken` (a pure CONFIG fact); computed by directAuthFor. */
  directNeedsNoGh: boolean;
};

/** Claude wiring facts: the home + settings.json contract + gh-auth (for direct). */
export type ClaudeFacts = ClaudeWiringStatus & {
  home: string;
  settingsPath: string;
  directAuth: CodexDirectAuthFacts;
  /** Recorded auth provider -- lets the check frame a non-gh-cli credential miss. */
  provider?: AuthProvider | null;
  /** Narrowed named runs only: the profile's recorded mode (see CodexFacts). */
  expectedMode?: ProfileMode | null;
  /** Direct mode only: a GitHub token is provisioned in the store, so the resolver (`agent auth
   *  --get`) needs no `gh` login. Always false outside direct. */
  directUsesToken: boolean;
};

export interface CodexHostFacts {
  /** The per-host CODEX_HOME farm needs POSIX symlinks (Linux/macOS, not Windows). */
  supported: boolean;
  /** The per-host CODEX_HOME path (~/.codex/hosts/<hostname>). */
  hostHome: string;
  /** That directory exists on disk. */
  exists: boolean;
  /** Its real-path config.toml selects the managed provider (codexHostFarm's predicate). */
  wired: boolean;
  /** A farm probe failed for a reason other than absence (present/wired unproven). */
  probeError: string | null;
  /** Run state records it as the active CODEX_HOME (set only after a successful write). */
  active: boolean;
  /** The `codex-host` key (stored else default; always false on Windows). */
  enabled: boolean;
}

/** The 3.5.6 default-home move stages the flat root's daemon files under DEFAULT_HOME_STAGING_DIR
 *  and flips with one rename, so a kill inside that window leaves the staging dir. `staged`
 *  means exactly that unfinished move; the flat root still answers until the flip. */
export interface DefaultHomeMigrationFacts {
  /** The staging dir's absolute path under the root's profiles dir. */
  stagingPath: string;
  /** The staging dir exists on disk (an interrupted move). */
  staged: boolean;
}

/** The persisted state plus the effective cooldown, which is the LIVE `update-cooldown` config
 *  (never snapshotted into state), so `agent health` matches `agent update --auto-status`. */
export type AutoupdateStatus = AutoupdateData & { enabled: boolean; cooldownDays: number };

export interface HealthFacts {
  /** The profile the run was narrowed to (null/absent = the default/whole environment); the
   *  evaluator stamps it onto the codex/claude/live checks. */
  profile?: Profile;
  /** The default first, then (in the full/proxy scopes) every named profile in sorted order, or
   *  only the narrowed one. */
  runtimes?: RuntimeTarget[];
  bootstrap?: BootstrapFacts;
  proxy?: ProxyFacts;
  shell?: ShellFacts;
  clis?: CliFacts[];
  tools?: ToolFacts;
  auth?: AuthFacts;
  /** A narrowed run's credential line, mirroring the default checkAuth: `slot` is null when the
   *  store carries no slot for the profile (a half-created, home-only profile). */
  profileAuth?: {
    name: ProfileName;
    slot: ProfileAuthFacts | null;
    storedToken: boolean;
    ghAuthenticated: boolean;
    /** The pinned gh account the probe asked about (see AuthFacts.ghUser). */
    ghUser?: string | null;
    /** An auto slot's followed account (see AuthFacts.ghActiveLogin). */
    ghActiveLogin?: string | null;
    /** The gh probe never ran to completion (see AuthFacts.ghAuthUnproven). */
    ghAuthUnproven?: true;
  };
  codex?: CodexFacts;
  codexHost?: CodexHostFacts;
  claude?: ClaudeFacts;
  /** The Claude Desktop library judged against the `claude-desktop` key (root-wide, so never
   *  gathered on a narrowed run). */
  claudeDesktop?: ClaudeDesktopStatus;
  codexLive?: LiveProbeFacts;
  claudeLive?: LiveProbeFacts;
  autoupdate?: AutoupdateStatus;
  /** Root-wide, so never gathered on a narrowed `--profile` run. */
  defaultHomeMigration?: DefaultHomeMigrationFacts;
}

/** Never tokens. The ProfileName key documents intent (TS erases a branded index to string); the
 *  actual guarantee is the producer, which sweeps the store via profileNames(), so a hand-edited
 *  invalid key never reaches the report. */
export type ProfileAuthFacts = {
  provider: AuthProvider | null;
  mode: ProfileMode | null;
  integrationIdentity: string | null;
};

/** The GitHub credential state, independent of any one agent. Direct resolves the credential at
 *  fetch time via `agent auth --get`, provider-driven (`gh-cli` -> `gh`, `copilot`/`gh-token` ->
 *  the stored token; no provider -> nothing). */
export interface AuthFacts {
  storedToken: boolean;
  ghAuthenticated: boolean;
  /** The pinned gh account the probe asked about (`gh auth token --user`). Absent/null = gh's
   *  active account, so the check can name the account a pinned verdict is about. Optional so
   *  fixtures stay valid. */
  ghUser?: string | null;
  /** An auto slot's followed account (see CodexDirectAuthFacts.ghActiveLogin). */
  ghActiveLogin?: string | null;
  /** The gh probe never ran to completion (CodexDirectAuthFacts.unproven): ghAuthenticated false
   *  is then UNPROVEN, so the check says "could not check", never "gh is unauthenticated" plus
   *  `gh auth login` advice. Optional so hand-built fixtures stay valid. */
  ghAuthUnproven?: true;
  /** The recorded auth provider (`copilot` | `gh-cli` | `gh-token`), or null. */
  provider: AuthProvider | null;
  /** Named profiles, keyed by validated name. */
  profiles: Record<ProfileName, ProfileAuthFacts>;
  /** The `integration-id` config pin (integration_identity.ts), or null when probing. */
  pinnedIntegrationId: string | null;
}
