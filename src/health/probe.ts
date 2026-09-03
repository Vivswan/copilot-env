// I/O fact-gathering for `agent health`. Each scope gathers ONLY the facts it
// needs (the `runtime` scope stays minimal -- no shell/CLI probes -- though the
// tracked-pid check still spawns `ps`/PowerShell exactly as the original health
// command did). Pure sub-evaluators (evalShellFiles, evalCodex) take raw content
// so they unit-test without touching the world.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_CLIS } from "../agents/clis.ts";
import {
  CLAUDE_PROBE,
  CODEX_CATALOG_NOISE_RE,
  CODEX_PROBE,
  PROBE_PROMPT,
  PROBE_TIMEOUT_MS,
} from "../agents/live_probe.ts";
import { defaultSetupNeedsProxy } from "../agents/wiring.ts";
import {
  type AutoupdateData,
  AutoupdateState,
  effectiveUpdateCooldownDays,
} from "../autoupdate/state.ts";
import { BASE_URL_ENV, type ClaudeWiringStatus, inspectClaudeWiring } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { CODEX_ENV_KEY, type CodexWiringStatus, inspectCodexWiring } from "../codex/config.ts";
import { getHostLocalCodexHome } from "../codex/host.ts";
import { codexConfigPath, defaultCodexHome } from "../codex/paths.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  allProfileNames,
  type AuthProvider,
  CopilotEnvState,
  credentialProvider,
  type ProfileMode,
  storedCredentialKind,
} from "../copilot_api/env_state.ts";
import { ghAuthTokenSpawnSpec, ghAuthVerdict } from "../copilot_api/gh_cli.ts";
import {
  CopilotApiPaths,
  DEFAULT_HOME_STAGING_DIR,
  profileHomeExists,
  PROFILES_DIR_NAME,
  resolveRootHome,
} from "../copilot_api/paths.ts";
import {
  copilotApiFallbackPort,
  copilotApiResolvePort,
  proxyLoopbackOrigin,
} from "../copilot_api/port.ts";
import { classifyOwnedDaemonPid, pidAlive } from "../copilot_api/process.ts";
import { type SidecarStatus, sidecarStatus } from "../copilot_api/sidecar.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import {
  installedProxyVersion,
  proxyVersionBoundsStatus,
  type ProxyVersionStatus,
} from "../copilot_api/version.ts";
import {
  proxyFloatSkips,
  readResolvedVersionRecord,
  resolveMinimumReleaseAgeSeconds,
} from "../proxy_float.ts";
import { idleTimeoutMs } from "../scripts/idle_watchdog.ts";
import { persistedInferenceMs } from "../scripts/inference_activity.ts";
import { hasMarker, LAUNCHERS_MARKER, MARKER, shellTargetFiles } from "../shell/integration.ts";
import {
  childEnvWithPath,
  cliSpawn,
  type CommandLook,
  findCommand,
  resolveCommand,
} from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { readTextOrNull, readTextResult, type TextReadResult } from "../utils/fs.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { packageVersion } from "../utils/version.ts";
import type { HealthScope } from "./types.ts";
import {
  AUTH_SCOPES as SCOPE_AUTH,
  BOOTSTRAP_SCOPES as SCOPE_BOOTSTRAP,
  CLAUDE_LIVE_SCOPES as SCOPE_CLAUDE_LIVE,
  CLAUDE_SCOPES as SCOPE_CLAUDE,
  CODEX_LIVE_SCOPES as SCOPE_CODEX_LIVE,
  CODEX_SCOPES as SCOPE_CODEX,
  PROFILE_SWEEP_SCOPES as SCOPE_PROFILE_SWEEP,
  RUNTIME_SCOPES as SCOPE_RUNTIME,
  SETUP_SCOPES as SCOPE_SETUP,
} from "./types.ts";

// --- fact shapes ------------------------------------------------------------

/** The CopilotApiPaths slice a runtime target reports (a projection, never a
 *  second hand-maintained shape). */
export type RuntimePathsView = Pick<
  CopilotApiPaths,
  "home" | "configFile" | "runDir" | "stateFile" | "logFile" | "sqliteDb"
>;

/** THE projection from CopilotApiPaths to the reported slice -- the single
 *  place that picks the fields, so adding one can never drift between the
 *  default and (future) named targets. */
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

/** A named profile's store slot as a runtime target reports it (never tokens).
 *  One profileSlot() call snapshots the WHOLE slot from a single store read, so
 *  consumers pairing its fields (provider + token presence, say) can never see a
 *  torn combination under a concurrent credential write. */
export interface ProfileSlotFacts {
  exists: boolean;
  provider: AuthProvider | null;
  mode: ProfileMode | null;
  /** The slot holds a provisioned token (classifies the Direct credential path). */
  storedToken: boolean;
  /** The probed direct-mode client identity NAME cached on the slot, or null. */
  integrationIdentity: string | null;
}

/**
 * Who holds a probed target's port -- reconciled ONCE here at probe time from
 * the raw reads, so the ownership verdict (runtime.orphan) is a single
 * derivation instead of every consumer re-combining reachable/pidTracked/
 * identity/proxyExpected. A foreign responder is runtime.identity's verdict,
 * so it is its own state (never an "orphan"): the two checks can't double-warn.
 */
export type PortState =
  /** Nothing reachable on the port. */
  | { kind: "down" }
  /** Something answers, but no agent routes to the port (both agents direct) --
   *  its occupant is not ours to judge. */
  | { kind: "unrouted" }
  /** The port is held by the daemon we track. */
  | { kind: "tracked" }
  /** The responder is NOT copilot-api (no x-trace-id): a foreign listener. */
  | { kind: "foreign" }
  /** copilot-api ("confirmed") or an unprobed responder ("unconfirmed") outside
   *  our tracking: started outside `agent start`, or the run-state was cleared. */
  | { kind: "orphan"; identity: "confirmed" | "unconfirmed" };

/** THE port-ownership derivation (see PortState). Exported for its unit tests
 *  and the test fixtures, so a hand-built probe can never carry a torn verdict. */
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
  /** The tracked-pid identity scan FAILED (classifyDaemonPid "unknown"): pidTracked
   *  false is then UNPROVEN -- "failed to look", never "proven not ours" -- so the
   *  renderers say "could not be verified" instead of a confident stale/orphan
   *  verdict. Absent (the common case) means the scan completed and pidTracked is a
   *  real verdict. Optional so hand-built probe fixtures stay valid. */
  pidScanUnproven?: true;
  pidAlive: boolean;
  /** Identity of whatever is reachable on the port: true = copilot-api (x-trace-id present),
   *  false = reachable but NOT copilot-api (likely a foreign listener), null = not probed
   *  (port down, the fast `runtime` scope which skips the extra request, or proxyExpected
   *  false -- no agent routes to the port, so its occupant is not ours to interrogate). */
  identityConfirmed: boolean | null;
  portState: PortState;
}

/** A probed daemon's outcome record (the `probed` arm of DaemonProbe). */
export type DaemonProbed = { kind: "probed" } & DaemonProbeFacts;

/**
 * Whether a target's daemon was actually interrogated -- THE row gate: the
 * evaluator renders per-daemon rows exactly for `probed` targets, so a row can
 * never describe a probe that did not happen, and probe-shaped fields cannot
 * exist without the probe. `why` (internal, never rendered) records which
 * skip rule fired. Mirrors LiveProbeFacts.
 */
export type DaemonProbe = { kind: "skipped"; why: string } | DaemonProbed;

/**
 * The runtime facts for ONE daemon target: the default (profile null) or a
 * named profile's isolated daemon. Gathering is READ-ONLY -- the port comes
 * from the same run-state snapshot as the pid (proxyStatus's rule), with
 * copilotApiFallbackPort's non-reserving, non-re-reading fallback when none is
 * recorded; health never reserves a port or creates a file.
 */
interface RuntimeTargetCommon {
  /** Whether this target's setup routes anything through a local proxy; when
   *  false, a down daemon is not a failure (default target: the inverse of
   *  "both Codex and Claude are wired direct"). */
  proxyExpected: boolean;
  port: number;
  /** The port came from the target's own run-state snapshot (vs the non-reserving
   *  fallback). A NAMED target's daemon is only ever probed -- and only earns
   *  per-daemon report rows -- on a persisted port: an unpersisted candidate is
   *  a guess no daemon or wiring has spoken for, so probing it could only
   *  misattribute whatever answers. */
  portPersisted: boolean;
  paths: RuntimePathsView;
  /** Idle auto-stop watchdog state, observed from outside the daemon. */
  watchdog: WatchdogFacts;
}

/** The default daemon's target: always interrogated (the launchers' fast
 *  readiness probe is a contract of this daemon alone). */
export type DefaultRuntimeTarget = RuntimeTargetCommon & {
  profile: null;
  probe: DaemonProbed;
};

/** A named profile's target: its store slot and on-disk home are always read;
 *  the daemon itself is interrogated only per gatherNamedTarget's policy. */
export type NamedRuntimeTarget = RuntimeTargetCommon & {
  profile: ProfileName;
  /** The credential store slot (one snapshot; see ProfileSlotFacts). */
  slot: ProfileSlotFacts;
  /** The isolated daemon home exists on disk. */
  homeExists: boolean;
  probe: DaemonProbe;
};

export type RuntimeTarget = DefaultRuntimeTarget | NamedRuntimeTarget;

/**
 * Idle-watchdog inputs the proxy exposes externally: the managed-lifecycle gate, the effective
 * idle window, and the two activity signals -- the `lastEnsureAt` heartbeat and
 * `lastRequestMs`, the in-process observer's persisted `.activity.json` mark. Neither moves on
 * liveness `GET /` pings, so health's own probes never perturb what they report. `now` is the
 * snapshot the report computes "remaining" against, captured at probe time so the evaluator
 * stays pure.
 */
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
  /** Shell-target DISCOVERY itself failed to run (resolving the profile paths
   *  shells out to PowerShell on Windows and can throw): `files` is then an
   *  empty, UNPROVEN census, so the check says "could not check" instead of a
   *  confident "not wired". Optional so hand-built fixtures stay valid. */
  targetsUnproven?: true;
  /** The `launchers` config key: the cl/co/cx launchers are `agent env` emissions
   *  gated on it, so the key -- not any rc marker -- is what "wired" means. */
  launchersWired: boolean;
}

export interface CliFacts {
  command: string;
  name: string;
  /** The PATH look, failure arm kept (see CommandLook): the census renders a
   *  "not installed" verdict, so an unproven look must arrive marked. */
  look: CommandLook;
}

export interface ToolFacts {
  node: CommandLook;
  npm: CommandLook;
}

export interface CodexDirectAuthFacts {
  command: string | null;
  authenticated: boolean;
  /** The gh look never RAN to completion (the command probe for gh failed, or
   *  `gh auth token` spawned but errored / was timeout-killed): the two fields
   *  above are then UNPROVEN -- renderers say "could not check", never a
   *  confident "not found"/"not authenticated" (or `gh auth login` advice).
   *  Absent means the probe completed and the verdict is real. Optional so
   *  hand-built fixtures stay valid. */
  unproven?: true;
}

/**
 * Result of a `--live` end-to-end prompt against an agent CLI's CONFIGURED home.
 * Skipped when the CLI isn't installed (not a failure); `lookFailed` marks a
 * skip off a look that never completed (a could-not-check, not a proven
 * absence). A probe that RAN always names the resolved CLI, and a failure
 * always carries the captured reason + a tail of the real CLI output -- a
 * skipped-yet-ok result is unrepresentable.
 */
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
  /** Narrowed named runs only: the profile's mode recorded in the store slot (the
   *  source of truth its wiring is derived from) -- a wiring whose managed mode
   *  disagrees is an interrupted rewire, never green. */
  expectedMode?: ProfileMode | null;
  /**
   * Direct mode only: the managed resolver (`agent auth --get`) needs no `gh` login --
   * the wiring execs it AND the store classifies the credential as a stored token.
   * Distinct from the wiring's own `directUsesToken` (a pure CONFIG fact: the direct
   * table carries the managed auth.command); computed by directAuthFor from the store.
   */
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
  /**
   * Direct mode only: true when a GitHub token is provisioned in the store, so the
   * resolver (`agent auth --get`) needs no `gh` login. Always false outside direct.
   */
  directUsesToken: boolean;
};

export interface CodexHostFacts {
  /** The per-host CODEX_HOME farm needs POSIX symlinks (Linux/macOS, not Windows). */
  supported: boolean;
  /** The per-host CODEX_HOME path (~/.codex/hosts/<hostname>). */
  hostHome: string;
  /** That directory exists on disk. */
  exists: boolean;
  /** state.codexHome currently points at the per-host home (it's the active one). */
  active: boolean;
}

/**
 * The 3.5.6 default-home move's staging state: the fix-up stages the flat
 * root's daemon files into `profiles/` under DEFAULT_HOME_STAGING_DIR and flips
 * with one atomic rename, so a kill inside that window leaves the staging dir
 * behind. `staged` true means exactly that unfinished move (the flat root still
 * answers until the flip, so the system keeps working).
 */
export interface DefaultHomeMigrationFacts {
  /** The staging dir's absolute path under the root's profiles dir. */
  stagingPath: string;
  /** The staging dir exists on disk (an interrupted move). */
  staged: boolean;
}

/**
 * Autoupdate status for health: the persisted state plus the effective cooldown,
 * which is the LIVE `update-cooldown` config (never snapshotted into state) -- so
 * `agent health` matches `agent update --auto-status`.
 */
export type AutoupdateStatus = AutoupdateData & { cooldownDays: number };

export interface HealthFacts {
  /** The profile the run was narrowed to (null/absent = the default/whole
   *  environment) -- the evaluator stamps it onto the codex/claude/live checks. */
  profile?: Profile;
  /** One entry per runtime target: the default first, then (in the full/proxy
   *  scopes) every named profile in sorted order -- or only the narrowed one. */
  runtimes?: RuntimeTarget[];
  bootstrap?: BootstrapFacts;
  proxy?: ProxyFacts;
  shell?: ShellFacts;
  clis?: CliFacts[];
  tools?: ToolFacts;
  auth?: AuthFacts;
  /** A narrowed run's credential line: the addressed profile's slot (null when
   *  the store carries no slot for it -- e.g. a half-created, home-only profile),
   *  plus whether its credential actually RESOLVES (a token in the slot, or a
   *  live gh login for a gh-cli slot) -- mirroring the default checkAuth. */
  profileAuth?: {
    name: ProfileName;
    slot: ProfileAuthFacts | null;
    storedToken: boolean;
    ghAuthenticated: boolean;
    /** The gh probe never ran to completion (see AuthFacts.ghAuthUnproven). */
    ghAuthUnproven?: true;
  };
  codex?: CodexFacts;
  codexHost?: CodexHostFacts;
  claude?: ClaudeFacts;
  codexLive?: LiveProbeFacts;
  claudeLive?: LiveProbeFacts;
  autoupdate?: AutoupdateStatus;
  /** The 3.5.6 default-home move's staging state (root-wide, so never gathered
   *  on a narrowed `--profile` run). */
  defaultHomeMigration?: DefaultHomeMigrationFacts;
}

/** One named profile's facts: recorded provider + mode + baked direct identity
 *  (never tokens). The ProfileName key documents intent (TS erases a branded index
 *  to string); the actual guarantee is the producer, which sweeps the store via
 *  profileNames(), so a hand-edited invalid key never reaches the report. */
export type ProfileAuthFacts = {
  provider: AuthProvider | null;
  mode: ProfileMode | null;
  integrationIdentity: string | null;
};

/**
 * The GitHub credential state, independent of any one agent: a token provisioned
 * in the store (`agent auth`), and/or a usable `gh` login. Direct resolves the
 * credential at fetch time via `agent auth --get`, provider-driven (`gh-cli` ->
 * `gh`, `copilot`/`gh-token` -> the stored token; no provider -> nothing).
 */
export interface AuthFacts {
  storedToken: boolean;
  ghAuthenticated: boolean;
  /** The gh probe never ran to completion (CodexDirectAuthFacts.unproven):
   *  ghAuthenticated false is then UNPROVEN, so the check says "could not
   *  check", never "gh is unauthenticated" + `gh auth login` advice. Optional
   *  so hand-built fixtures stay valid. */
  ghAuthUnproven?: true;
  /** The recorded auth provider (`copilot` | `gh-cli` | `gh-token`), or null. */
  provider: AuthProvider | null;
  /** Named profiles, keyed by validated name. */
  profiles: Record<ProfileName, ProfileAuthFacts>;
  /** The `integration-id` config pin (integration_identity.ts), or null when probing. */
  pinnedIntegrationId: string | null;
}

// --- injectable I/O surface -------------------------------------------------

export interface ProbeDeps {
  root: string;
  /** READ-ONLY port resolution for a target (never reserves a profile port). */
  resolvePort(profile: Profile): string;
  /** The non-reserving port fallback when a state snapshot records none; never
   *  re-reads the addressed profile's recorded port (snapshot rule). */
  fallbackPort(profile: Profile): number;
  reach(url: string, timeoutMs: number): Promise<boolean>;
  /** Whether the responder at `url` carries copilot-api's x-trace-id identity header. */
  proxyIdentity(url: string, timeoutMs: number): Promise<boolean | null>;
  readState(profile: Profile): {
    port?: number;
    pid?: number;
    codexHome?: string;
    lastEnsureAt?: number;
  };
  /** Three-state identity of the tracked pid (classifyDaemonPid): "unknown" means the
   *  scan FAILED and must render as "could not verify", never as a confident "not
   *  tracked" -- the boolean flatten this replaced read a broken scan as an orphan. */
  classifyTrackedPid(pid: number): Promise<"yes" | "no" | "unknown">;
  isPidAlive(pid: number): boolean;
  paths(profile: Profile): RuntimePathsView;
  /** Idle-watchdog inputs (injected for deterministic tests). */
  now(): number;
  idleTimeoutMs(): number;
  autoStartEnabled(): boolean;
  /** Epoch ms of the most recent inference request against `profile`'s daemon -- the
   *  in-process observer's persisted `.activity.json` mark -- or null when there has
   *  been none. NOT moved by liveness `GET /` pings. */
  lastRequestMs(profile: Profile): number | null;
  /** Every named profile the system knows about (store slots + on-disk homes). */
  profileNames(): ProfileName[];
  /** A named profile's store slot view (never tokens). */
  profileSlot(name: ProfileName): ProfileSlotFacts;
  /** True when the named profile has an isolated daemon home on disk. */
  profileHomeExists(name: ProfileName): boolean;
  /** One look for a command, failure arm kept (see CommandLook): the CLI/tool
   *  census rows render "not installed" verdicts, so an unproven look must stay
   *  marked instead of flattening into "absent". */
  commandLook(command: string): CommandLook;
  agentClis(): readonly { command: string; name: string }[];
  shellTargets(): string[];
  readFileSafe(path: string): string | null;
  /** Three-way read for the Claude settings file: its classification must keep
   *  "absent" and "unreadable" apart (the read-error verdict), where
   *  readFileSafe's null deliberately collapses them for don't-care reads. */
  readFileResult(path: string): TextReadResult;
  installedProxyVersion(): string | null;
  /** The float's resolved-version record, or null when it has never resolved here. */
  proxyResolved(): ProxyResolvedFacts | null;
  /** The deno sidecar every proxy spawn runs on. */
  sidecar(): SidecarStatus;
  projectConfig(): ProjectConfig;
  proxyCooldownSeconds(): number;
  codexHome(): string;
  codexTokenInEnviron(): boolean;
  codexDirectAuth(): Promise<CodexDirectAuthFacts>;
  /** True when a GitHub token is provisioned in the store (Direct needs no gh then). */
  storedTokenPresent(): boolean;
  /** The recorded auth provider (`copilot` | `gh-cli` | `gh-token`), or null. */
  authProvider(): AuthProvider | null;
  /** Named profiles: name -> recorded provider + mode + baked direct identity (never tokens). */
  authProfiles(): Record<ProfileName, ProfileAuthFacts>;
  /** The `integration-id` config pin, or null when unset/`auto`. */
  pinnedIntegrationId(): string | null;
  claudeHome(): string;
  hostCodexHome(): string;
  dirExists(path: string): boolean;
  /** The 3.5.6 default-home move's staging state under the root's profiles dir. */
  defaultHomeMigration(): DefaultHomeMigrationFacts;
  readAutoupdate(): AutoupdateStatus;
  nodeModulesPresent(): boolean;
  nodeModulesFresh(): boolean;
  denoVersion(): string | null;
  cliVersion(): string;
  /** `--live` end-to-end prompts against the configured Codex/Claude homes;
   *  `profile` selects a named profile's wiring (never probed in the default sweep). */
  codexLive(home: string, profile: Profile): Promise<LiveProbeFacts>;
  claudeLive(home: string, profile: Profile): Promise<LiveProbeFacts>;
}

/** Probe the URL: any HTTP response (even an error status) means "reachable". */
async function reachUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** copilot-api stamps every response with an `x-trace-id` header. Use it as a cheap,
 *  unauthenticated identity marker: true when present, false when the responder answered
 *  without it (likely a foreign service squatting the port), null when nothing answered. */
async function proxyIdentity(url: string, timeoutMs: number): Promise<boolean | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.headers.has("x-trace-id");
  } catch {
    return null;
  }
}

/** Fold one finished `gh auth token` spawn into the direct-auth facts (exported
 *  for tests): ghAuthVerdict's completed exits prove the verdict; its "unproven"
 *  (a spawn error, the timeout kill -- status null) marks the facts instead of
 *  flattening into a confident authenticated:false. */
export function directAuthFromSpawn(
  command: string,
  result: { status: number | null; error?: unknown },
): CodexDirectAuthFacts {
  const verdict = ghAuthVerdict(result);
  if (verdict === "unproven") return { command, authenticated: false, unproven: true };
  return { command, authenticated: verdict };
}

function codexDirectAuth(): Promise<CodexDirectAuthFacts> {
  // findCommand with the failure arm kept: this fact renders auth VERDICTS
  // ("GitHub CLI not found", "not authenticated"), so a look that never ran must
  // arrive marked instead of reading as a proven absence.
  const look = findCommand("gh");
  if (look.path === null) {
    return Promise.resolve({
      command: null,
      authenticated: false,
      ...(look.launchFailed ? { unproven: true as const } : {}),
    });
  }
  const command = look.path;
  // Async (non-blocking) so it runs concurrently with the other probes under
  // gatherFacts' Promise.all, instead of freezing the event loop for the whole
  // `gh auth token` call. ghAuthTokenSpawnSpec owns the spawn recipe (resolved path,
  // gh's bin dir on PATH, the shared timeout). stdio:"ignore" keeps the printed
  // token out of our process memory. A completed non-zero exit => authenticated:
  // false; a spawn error or the timeout kill (close with a null code) never
  // completed the probe, so directAuthFromSpawn marks it unproven instead.
  return new Promise((resolve) => {
    const s = ghAuthTokenSpawnSpec(command);
    const child = spawn(s.file, s.args, {
      stdio: "ignore",
      timeout: s.timeout,
      windowsHide: true,
      shell: s.shell,
      env: s.env,
    });
    child.on("error", (e) => resolve(directAuthFromSpawn(command, { status: null, error: e })));
    child.on("close", (code) => resolve(directAuthFromSpawn(command, { status: code })));
  });
}

/**
 * Build the `--live` failure detail: the CLI's FULL stdout/stderr, verbatim, so
 * `agent health --live` shows the complete error instead of a one-line summary.
 * codex's giant model-catalog lines are dropped (noise, not error); everything
 * else is kept untruncated. When the child produced no output (e.g. a timeout
 * kill, with code null + signal), fall back to the bare exit/timeout status so
 * the detail is never blank.
 */
function formatLiveFailure(
  code: number | null,
  signal: string | null,
  errorMessage: string | undefined,
  stdout: string,
  stderr: string,
): string {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !CODEX_CATALOG_NOISE_RE.test(l));
  if (lines.length) return lines.join("\n");
  if (errorMessage) return errorMessage;
  if (code === null && signal) {
    return `no response within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s (killed by ${signal})`;
  }
  return `exit ${code ?? "?"}`;
}

/**
 * Run an agent CLI's read-only smoke prompt against a CONFIGURED home (`--live`).
 * Async (overlaps the other probes) with a hard timeout; a timeout or any
 * non-zero exit => ok:false, with `detail` carrying the captured reason + output.
 * Skipped (ran:false) when the CLI isn't installed. Spawns the RESOLVED path so
 * the nvm fallback isn't defeated. Unlike the init probe, the environment is NOT
 * sanitized -- `--live` tests the user's real, fully-resolved setup -- except
 * `omitEnvVars` (upper-case names), the narrow scrub a NAMED profile needs so a
 * shell export of the DEFAULT wiring cannot override the profile's own and
 * misattribute the answer. Exported for the scrub's own test. `find` is a test
 * seam; the real look keeps its failure arm (see CommandLook) because the skip
 * renders a "CLI not installed" verdict.
 */
export function runLiveCli(
  cli: string,
  args: string[],
  home: string,
  homeEnvVar: string,
  omitEnvVars: readonly string[] = [],
  find: (command: string) => CommandLook = findCommand,
): Promise<LiveProbeFacts> {
  const look = find(cli);
  if (look.path === null) {
    return Promise.resolve(
      look.launchFailed ? { kind: "skipped", lookFailed: true } : { kind: "skipped" },
    );
  }
  const resolved = look.path;
  const ghPath = resolveCommand("gh");
  return new Promise((resolve) => {
    const s = cliSpawn(resolved, args);
    // Capture stdout/stderr (not stdio:"ignore") so a failure reports the FULL
    // reason the backend didn't answer. The cap is effectively unbounded (64 MB) --
    // a smoke prompt's real output is tiny, and the catalog noise is filtered out
    // when formatting -- but it guards against a pathologically chatty CLI.
    const child = spawn(s.file, s.args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: s.shell,
      // Put the resolved CLI's and gh's bin dirs on the child PATH so an nvm-only
      // toolchain (node-shim CLI, the config's bare `gh` call) is reachable even
      // when the parent process never sourced nvm.
      env: childEnvWithPath([dirname(resolved), ghPath ? dirname(ghPath) : null], {
        extra: { [homeEnvVar]: home },
        omit: (upper) => omitEnvVars.includes(upper),
      }),
    });
    const CAP = 64 * 1024 * 1024;
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < CAP) out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < CAP) err += d.toString();
    });
    child.on("error", (e: Error) =>
      resolve({
        kind: "failed",
        cli: resolved,
        detail: formatLiveFailure(null, null, e.message, out, err),
      }));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ kind: "ok", cli: resolved });
      } else {
        resolve({
          kind: "failed",
          cli: resolved,
          detail: formatLiveFailure(code, signal, undefined, out, err),
        });
      }
    });
  });
}

/** Env vars scrubbed from a `--live` Claude probe child. A NAMED profile drops a
 *  shell-exported ANTHROPIC_BASE_URL: env beats the profile's settings file, so a
 *  default-proxy export would silently answer for the profile and misattribute
 *  the result -- the same scrub the `cl --profile` launcher performs. The default
 *  probe scrubs nothing (`--live` tests the real, fully-resolved environment). */
export function claudeLiveOmitEnv(profile: Profile): readonly string[] {
  return profile === null ? [] : [BASE_URL_ENV];
}

export function defaultProbeDeps(): ProbeDeps {
  const root = PROJECT_ROOT;
  return {
    root,
    resolvePort: copilotApiResolvePort,
    fallbackPort: copilotApiFallbackPort,
    reach: reachUrl,
    proxyIdentity,
    readState: (profile) => CopilotEnvRunState.forProfile(profile).read(),
    // The owner-gated three-state (not bare classifyDaemonPid): the boolean scan this
    // replaced was owner-filtered, so an elevated Windows health run must not start
    // claiming another user's daemon as our tracked pid.
    classifyTrackedPid: classifyOwnedDaemonPid,
    isPidAlive: pidAlive,
    now: () => Date.now(),
    idleTimeoutMs: () => idleTimeoutMs(),
    autoStartEnabled: () => new CopilotEnvConfig().autoStartEnabled(),
    lastRequestMs: (profile) => {
      const m = persistedInferenceMs(profile);
      return m > 0 ? m : null;
    },
    paths: (profile) => runtimePathsView(new CopilotApiPaths(profile)),
    profileNames: allProfileNames,
    profileSlot: (name) => {
      const { exists, slot } = new CopilotEnvState().profileSlotStatus(name);
      return {
        exists,
        provider: credentialProvider(slot.credential),
        mode: slot.mode,
        storedToken: slot.credential.kind === "stored",
        integrationIdentity: slot.integrationIdentity,
      };
    },
    profileHomeExists,
    commandLook: findCommand,
    agentClis: () => AGENT_CLIS,
    shellTargets: shellTargetFiles,
    readFileSafe: readTextOrNull,
    readFileResult: readTextResult,
    installedProxyVersion: () => installedProxyVersion(root),
    proxyResolved: () => {
      const record = readResolvedVersionRecord(resolveRootHome());
      if (record === null) return null;
      return { ...record, cached: existsSync(record.denoDir) };
    },
    sidecar: () => sidecarStatus(resolveRootHome()),
    projectConfig: () => readProjectConfig(),
    proxyCooldownSeconds: () => resolveMinimumReleaseAgeSeconds(),
    // Effective CODEX_HOME, matching runCodexConfig / env.ts precedence:
    // per-host state override, then the default resolution.
    codexHome: () => new CopilotEnvRunState().read().codexHome ?? defaultCodexHome(),
    codexTokenInEnviron: () => Boolean(process.env[CODEX_ENV_KEY]),
    codexDirectAuth,
    storedTokenPresent: () => new CopilotEnvState().read().githubToken !== null,
    authProvider: () => new CopilotEnvState().read().authProvider,
    authProfiles: () => {
      // Sweep via profileNames() (the store's validated, sorted view), never the raw
      // record: its keys are a trust boundary, and only profileNames() mints the brand.
      const store = new CopilotEnvState();
      const profiles: Record<ProfileName, ProfileAuthFacts> = {};
      for (const name of store.profileNames()) {
        const slot = store.readProfileSlot(name);
        profiles[name] = {
          provider: credentialProvider(slot.credential),
          mode: slot.mode,
          integrationIdentity: slot.integrationIdentity,
        };
      }
      return profiles;
    },
    pinnedIntegrationId: () => new CopilotEnvConfig().pinnedIntegrationId(),
    // Claude's direct mode also authenticates via `gh auth token`, so it reuses
    // the same probe. Effective Claude home matches resolveClaudeHome precedence.
    claudeHome: () => resolveClaudeHome(),
    hostCodexHome: getHostLocalCodexHome,
    dirExists: (path: string) => existsSync(path),
    defaultHomeMigration: () => {
      // The same spelling defaultDaemonHome's precedence rule reads (paths.ts):
      // the staging dir the 3.5.6 fix-up renames into profiles/default.
      const stagingPath = join(resolveRootHome(), PROFILES_DIR_NAME, DEFAULT_HOME_STAGING_DIR);
      return { stagingPath, staged: existsSync(stagingPath) };
    },
    readAutoupdate: () => ({
      ...new AutoupdateState().read(),
      cooldownDays: effectiveUpdateCooldownDays(),
    }),
    nodeModulesPresent: () => existsSync(join(root, "node_modules")),
    nodeModulesFresh: () => {
      // Same predicate as bin/agent's freshness gate: node_modules at least as
      // new as deno.lock.
      try {
        const lock = statSync(join(root, "deno.lock")).mtimeMs;
        const modules = statSync(join(root, "node_modules")).mtimeMs;
        return modules >= lock;
      } catch {
        return false;
      }
    },
    denoVersion: () => Deno.version.deno,
    cliVersion: packageVersion,
    codexLive: (home, profile) =>
      runLiveCli(
        CODEX_PROBE.cli,
        CODEX_PROBE.args(PROBE_PROMPT, home, profile),
        home,
        CODEX_PROBE.homeEnvVar,
      ),
    claudeLive: (home, profile) =>
      runLiveCli(
        CLAUDE_PROBE.cli,
        CLAUDE_PROBE.args(PROBE_PROMPT, home, profile),
        home,
        CLAUDE_PROBE.homeEnvVar,
        claudeLiveOmitEnv(profile),
      ),
  };
}

// --- pure sub-evaluators (no I/O) -------------------------------------------

/** Derive shell-wiring facts from raw rc/profile contents (null = absent file) plus
 *  the stored launcher opt-in. Per-file hasLaunchers reports a leftover LEGACY block;
 *  launchersWired is the `launchers` config key (see ShellFacts). */
export function evalShellFiles(
  contents: { path: string; content: string | null }[],
  launchersEnabled: boolean,
): ShellFacts {
  const files: ShellFileFact[] = contents.map(({ path, content }) => ({
    path,
    hasIntegration: content !== null && hasMarker(content, MARKER),
    hasLaunchers: content !== null && hasMarker(content, LAUNCHERS_MARKER),
  }));
  return {
    files,
    integrationWired: files.some((f) => f.hasIntegration),
    launchersWired: launchersEnabled,
  };
}

/**
 * Codex-wiring facts for the effective CODEX_HOME. Thin wrapper over the codex
 * module's `inspectCodexWiring` (the single source of the wiring contract) that
 * just attaches the home being inspected.
 */
export function evalCodex(
  home: string,
  configToml: TextReadResult | string | null,
  envText: string | null,
  expectedPort: number,
  envKeyInEnviron: boolean,
  directAuth: CodexDirectAuthFacts = { command: null, authenticated: false },
  directNeedsNoGh = false,
  // The caller (gatherFacts) already inspected the wiring to gate the gh probe;
  // accept it to avoid a second parse. Tests call without it and parse internally.
  wiring: CodexWiringStatus = inspectCodexWiring(
    configToml,
    envText,
    expectedPort,
    envKeyInEnviron,
  ),
): CodexFacts {
  return {
    home,
    directAuth,
    directNeedsNoGh,
    ...wiring,
  };
}

export function evalClaude(
  home: string,
  directAuth: CodexDirectAuthFacts,
  directUsesToken: boolean,
  wiring: ClaudeWiringStatus,
  profile: Profile = null,
): ClaudeFacts {
  return {
    home,
    settingsPath: settingsPathFor(home, profile),
    directAuth,
    directUsesToken,
    ...wiring,
  };
}

// --- orchestration ----------------------------------------------------------

/**
 * Read ONE runtime target's shared fields. READ-ONLY: nothing here writes a
 * file or reserves a port. Snapshot semantics: pid and port come from a single
 * run-state read (proxyStatus's documented rule), so a concurrent start/stop
 * can't pair one daemon's pid with another's port; fallbackPort covers the
 * no-recorded-port case without a second read of the same file. The state is
 * returned alongside so the caller can hand the SAME snapshot's pid to
 * interrogateDaemon.
 */
function snapshotTarget(
  profile: Profile,
  deps: ProbeDeps,
  proxyExpectedFor: (port: number) => boolean,
): { state: ReturnType<ProbeDeps["readState"]>; common: RuntimeTargetCommon } {
  const state = deps.readState(profile);
  const portPersisted = state.port !== undefined;
  const port = state.port ?? deps.fallbackPort(profile);
  return {
    state,
    common: {
      proxyExpected: proxyExpectedFor(port),
      port,
      portPersisted,
      paths: deps.paths(profile),
      watchdog: {
        autoStart: deps.autoStartEnabled(),
        idleTimeoutMs: deps.idleTimeoutMs(),
        lastEnsureAt: state.lastEnsureAt ?? null,
        // The observer's persisted mark; our own reach/identity GET / probes are not
        // inference POSTs, so health observing the proxy never moves these numbers.
        lastRequestMs: deps.lastRequestMs(profile),
        now: deps.now(),
      },
    },
  };
}

/** Interrogate one daemon: the reach/pid probes plus (in the full/proxy scopes)
 *  the identity request, reconciled into the target's PortState. */
async function interrogateDaemon(
  scope: HealthScope,
  deps: ProbeDeps,
  port: number,
  trackedPid: number | null,
  proxyExpected: boolean,
): Promise<DaemonProbed> {
  // proxyLoopbackOrigin, matching portListening: a localhost probe reads DOWN on Windows
  // while the proxy is up.
  const probeUrl = `${proxyLoopbackOrigin(port)}/`;
  // The pid identity is a three-state read (deps.classifyTrackedPid): "no tracked pid"
  // is a genuine "no" (nothing to look at), but a FAILED scan is "unknown" -- carried
  // as pidScanUnproven beside the pidTracked flatten, so a broken `ps` renders as
  // "could not verify" instead of a confident orphan/stale verdict.
  const [reachable, pidClass] = await Promise.all([
    deps.reach(probeUrl, 2000),
    trackedPid !== null
      ? deps.classifyTrackedPid(trackedPid)
      : Promise.resolve<"yes" | "no" | "unknown">("no"),
  ]);
  const pidTracked = pidClass === "yes";
  // Identity probe (an extra local request) only in the full/proxy scopes -- never the
  // launchers' fast `runtime` probe. Only meaningful when something is reachable AND this
  // target's setup actually routes through the port: with both agents direct, nothing we
  // manage talks to whatever answers there, so its identity is none of our business (and
  // never grounds for a misroute warning).
  const identityConfirmed = SCOPE_BOOTSTRAP.includes(scope) && reachable && proxyExpected
    ? await deps.proxyIdentity(probeUrl, 2000)
    : null;
  return {
    kind: "probed",
    reachable,
    trackedPid,
    pidTracked,
    ...(pidClass === "unknown" ? { pidScanUnproven: true as const } : {}),
    pidAlive: trackedPid !== null ? deps.isPidAlive(trackedPid) : false,
    identityConfirmed,
    portState: classifyPortState({ proxyExpected, reachable, pidTracked, identityConfirmed }),
  };
}

/** Gather the DEFAULT daemon's target. Always interrogated, with the configured
 *  default port as the fallback -- the historical fast-probe behavior. */
async function gatherDefaultTarget(
  scope: HealthScope,
  deps: ProbeDeps,
): Promise<DefaultRuntimeTarget> {
  // When nothing in the default setup routes to the local daemon (both agents
  // direct AND Claude's base URL not aimed at it), no proxy is required, so a
  // down proxy must not read as a runtime failure.
  const { state, common } = snapshotTarget(null, deps, (targetPort) =>
    defaultSetupNeedsProxy({
      codexHome: deps.codexHome(),
      claudeHome: deps.claudeHome(),
      expectedPort: targetPort,
    }));
  return {
    profile: null,
    ...common,
    probe: await interrogateDaemon(
      scope,
      deps,
      common.port,
      state.pid ?? null,
      common.proxyExpected,
    ),
  };
}

/**
 * Gather a NAMED profile's runtime target: its store slot + on-disk daemon home,
 * with `proxyExpected` derived from the slot's recorded mode -- or, when the slot
 * is missing but a home exists, assumed proxy (a homed daemon may be running,
 * and a running daemon always has its port in run state). The daemon is
 * interrogated only when a proxy is expected, the home exists, AND the port is
 * persisted: a DIRECT profile has no daemon, a homeless proxy slot has no
 * persisted port, and an unpersisted candidate port is never probed.
 */
async function gatherNamedTarget(
  name: ProfileName,
  scope: HealthScope,
  deps: ProbeDeps,
): Promise<NamedRuntimeTarget> {
  const slot = deps.profileSlot(name);
  const homeExists = deps.profileHomeExists(name);
  const proxyExpected = slot.mode === "proxy" || (homeExists && !slot.exists);
  const { state, common } = snapshotTarget(name, deps, () => proxyExpected);
  const skipWhy = !proxyExpected
    ? "no daemon expected (not a proxy-mode target)"
    : !homeExists
    ? "no daemon home on disk"
    : !common.portPersisted
    ? "no persisted port on this host"
    : null;
  return {
    profile: name,
    slot,
    homeExists,
    ...common,
    probe: skipWhy !== null
      ? { kind: "skipped", why: skipWhy }
      : await interrogateDaemon(scope, deps, common.port, state.pid ?? null, proxyExpected),
  };
}

/**
 * Gather exactly the facts `scope` needs, running independent probes concurrently.
 * `opts.profile` narrows the run to ONE named profile: its runtime target, its
 * credential slot, and its per-agent wiring -- the account-wide fact groups
 * (bootstrap, proxy package, shell/CLI/tool setup, autoupdate, codex-host) are
 * not gathered at all, so they cannot leak into a narrowed report.
 */
export async function gatherFacts(
  scope: HealthScope,
  opts: { live?: boolean; profile?: Profile } = {},
  overrides?: Partial<ProbeDeps>,
): Promise<HealthFacts> {
  const deps: ProbeDeps = { ...defaultProbeDeps(), ...overrides };
  const profile = opts.profile ?? null;
  // The wiring expectation for the codex/claude scopes: the addressed target's
  // resolved port (READ-ONLY -- a named profile's reservation is peeked, never
  // made). Lazy + cached: only the scopes that inspect wiring resolve it, so a
  // runtime/auth run never computes a named profile's candidate port at all.
  let wiringPortCache: number | undefined;
  const wiringPort = (): number => (wiringPortCache ??= Number(deps.resolvePort(profile)));
  const facts: HealthFacts = { profile };

  // gh auth backs BOTH Codex and Claude direct mode; probe it at most once per
  // run, and asynchronously, so the single ~5s `gh auth token` call overlaps with
  // the other probes under Promise.all instead of serializing into the health
  // timeout. Both jobs await the same cached promise.
  let directAuthCache: Promise<CodexDirectAuthFacts> | undefined;
  const sharedDirectAuth = (): Promise<
    CodexDirectAuthFacts
  > => (directAuthCache ??= deps.codexDirectAuth());

  // The credential the run's Direct wiring resolves: the default store pair, or
  // the narrowed profile's own slot (named profiles never fall back). `mode` is
  // the named slot's recorded wiring mode (null for the default run, where no
  // single mode is recorded). Cached -- several jobs consult it.
  let credentialCache:
    | { provider: AuthProvider | null; storedToken: boolean; mode: ProfileMode | null }
    | undefined;
  const runCredential = (): {
    provider: AuthProvider | null;
    storedToken: boolean;
    mode: ProfileMode | null;
  } => {
    if (credentialCache === undefined) {
      if (profile === null) {
        credentialCache = {
          provider: deps.authProvider(),
          storedToken: deps.storedTokenPresent(),
          mode: null,
        };
      } else {
        const slot = deps.profileSlot(profile);
        credentialCache = {
          provider: slot.provider,
          storedToken: slot.storedToken,
          mode: slot.mode,
        };
      }
    }
    return credentialCache;
  };

  // Skip the (~5s) gh probe -- and report Direct as "uses token" -- only when the
  // config is `managed` (execs `agent auth --get [--profile <name>]`) AND the
  // addressed credential classifies as a stored token; gh-cli classifies to a live gh
  // probe. Shared by the Codex and Claude scope jobs so the gating stays identical.
  // Classification is owned by storedCredentialKind() (env_state.ts, the same
  // parse the credential union uses) -- a leftover token with no provider is
  // "none": no gh probe (no implicit fallback), and Direct never reads green.
  const directAuthFor = async (
    managed: boolean,
  ): Promise<{ directAuth: CodexDirectAuthFacts; noGhNeeded: boolean }> => {
    const { provider, storedToken } = runCredential();
    const noProbe = { command: null, authenticated: false };
    switch (storedCredentialKind(provider, storedToken)) {
      case "stored":
        return { directAuth: noProbe, noGhNeeded: managed };
      case "gh-cli":
        return { directAuth: await sharedDirectAuth(), noGhNeeded: false };
      case "none":
        return { directAuth: noProbe, noGhNeeded: false };
    }
  };

  const jobs: Promise<void>[] = [];

  if (SCOPE_RUNTIME.includes(scope)) {
    jobs.push(
      (async () => {
        if (profile !== null) {
          // Narrowed: exactly the addressed profile's target.
          facts.runtimes = [await gatherNamedTarget(profile, scope, deps)];
          return;
        }
        // The default target first, then every named profile in sorted order --
        // but only in the diagnostic scopes (see PROFILE_SWEEP_SCOPES): the
        // launchers' fast `runtime` probe stays the default daemon alone.
        const names = SCOPE_PROFILE_SWEEP.includes(scope) ? deps.profileNames() : [];
        facts.runtimes = await Promise.all<RuntimeTarget>([
          gatherDefaultTarget(scope, deps),
          ...names.map((name) => gatherNamedTarget(name, scope, deps)),
        ]);
      })(),
    );
  }

  if (profile === null && SCOPE_BOOTSTRAP.includes(scope)) {
    jobs.push(
      (async () => {
        // An interrupted 3.5.6 default-home move (root-wide, one root per run).
        facts.defaultHomeMigration = deps.defaultHomeMigration();
        const sidecar = deps.sidecar();
        facts.bootstrap = {
          cliVersion: deps.cliVersion(),
          deno: { available: deps.denoVersion() !== null, version: deps.denoVersion() },
          // A compiled binary embeds its dependencies -- no node_modules to judge.
          nodeModules: sidecar.standalone
            ? null
            : { present: deps.nodeModulesPresent(), fresh: deps.nodeModulesFresh() },
        };
        const resolved = deps.proxyResolved();
        // Report the version that would actually RUN, in the daemon entry's own
        // precedence: the float's recorded resolution, else the deno.json baseline
        // in node_modules. Judging bounds on anything else would grade a copy the
        // daemon never loads.
        const version = resolved?.version ?? deps.installedProxyVersion();
        // A bad COPILOT_API_MIN_RELEASE_AGE / cooldown setting shouldn't crash health.
        let cooldownSeconds: number | null = null;
        try {
          cooldownSeconds = deps.proxyCooldownSeconds();
        } catch {
          cooldownSeconds = null;
        }
        // Reading copilot-env.config can throw on a malformed/missing file; turn
        // that into a proxy-check failure rather than crashing the whole report.
        // The exemption uses the float's OWN skip predicate (not the runtime
        // checks' looser both-direct read) so health and the float can never
        // disagree about whether the bounds are enforced.
        const floatSkips = proxyFloatSkips(deps.codexHome(), deps.claudeHome());
        try {
          facts.proxy = {
            version,
            bounds: proxyVersionBoundsStatus(version, deps.projectConfig()),
            configError: null,
            cooldownSeconds,
            floatSkips,
            resolved,
            sidecar,
          };
        } catch (e) {
          facts.proxy = {
            version,
            bounds: null,
            configError: errMessage(e),
            cooldownSeconds,
            floatSkips,
            resolved,
            sidecar,
          };
        }
      })(),
    );
  }

  if (SCOPE_CODEX.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.codexHome();
        // config.toml is read three-way (deps.readFileResult) so an unreadable
        // file classifies other/read-error instead of collapsing into the
        // absent/none verdict readFileSafe's null would produce; the .env read
        // stays don't-care (its absence and unreadability are alike here).
        const configRead = deps.readFileResult(codexConfigPath(home));
        const envText = deps.readFileSafe(join(home, ".env"));
        // A named profile inspects ITS selection ([profiles.<name>] over the
        // suffixed provider table) against ITS resolved port.
        const wiring = inspectCodexWiring(
          configRead,
          envText,
          wiringPort(),
          deps.codexTokenInEnviron(),
          profile,
        );
        const { directAuth, noGhNeeded } = await directAuthFor(wiring.directUsesToken);
        // The wiring's `directUsesToken` stays a pure CONFIG fact; the store-aware
        // "Direct needs no gh" verdict travels on its own field (`directNeedsNoGh`,
        // the meaning checkCodex consumes).
        const codexFacts = evalCodex(
          home,
          configRead,
          envText,
          wiringPort(),
          deps.codexTokenInEnviron(),
          directAuth,
          noGhNeeded,
          wiring,
        );
        facts.codex = {
          ...codexFacts,
          provider: runCredential().provider,
          ...(profile === null ? {} : { expectedMode: runCredential().mode }),
        };
      })(),
    );
  }

  if (SCOPE_CLAUDE.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.claudeHome();
        // A named profile answers from its own settings-<name>.json. The settings
        // file itself is read three-way (deps.readFileResult) so an unreadable
        // file classifies other/read-error instead of collapsing into "none".
        const settingsRead = deps.readFileResult(settingsPathFor(home, profile));
        // deps.readFileSafe backs the classifier's legacy-helper body check, so
        // "direct" here means the apiKeyHelper truly invokes `agent auth --get`
        // addressed at THIS profile -- the inline managed command, or a legacy
        // install's helper file whose body says so (never a stale/foreign/missing/
        // mis-addressed helper); directAuthFor then decides the gh probe.
        const wiring = inspectClaudeWiring(
          settingsRead,
          home,
          wiringPort(),
          profile,
          deps.readFileSafe,
        );
        const { directAuth, noGhNeeded } = await directAuthFor(wiring.providerMode === "direct");
        facts.claude = {
          ...evalClaude(home, directAuth, noGhNeeded, wiring, profile),
          provider: runCredential().provider,
          ...(profile === null ? {} : { expectedMode: runCredential().mode }),
        };
      })(),
    );
  }

  if (SCOPE_AUTH.includes(scope)) {
    if (profile !== null) {
      // Narrowed: the addressed profile's slot line only (never the default
      // credential -- named profiles never fall back to it). Every slot field
      // comes from ONE profileSlot() snapshot, so provider and token presence
      // can never pair across a concurrent credential write; resolution mirrors
      // the default checkAuth (a token slot resolves by presence, a gh-cli slot
      // by the shared (cached) gh probe).
      jobs.push(
        (async () => {
          const slot = deps.profileSlot(profile);
          const gh = storedCredentialKind(slot.provider, slot.storedToken) === "gh-cli"
            ? await sharedDirectAuth()
            : null;
          facts.profileAuth = {
            name: profile,
            slot: slot.exists
              ? {
                provider: slot.provider,
                mode: slot.mode,
                integrationIdentity: slot.integrationIdentity,
              }
              : null,
            storedToken: slot.storedToken,
            ghAuthenticated: gh?.authenticated ?? false,
            ...(gh?.unproven ? { ghAuthUnproven: true as const } : {}),
          };
        })(),
      );
    } else {
      jobs.push(
        (async () => {
          // The credential state, agent-independent. gh is a credential ONLY when
          // storedCredentialKind() says gh-cli (no implicit fallback); reuses the shared
          // (cached) gh probe -- no extra spawn.
          const provider = deps.authProvider();
          const storedToken = deps.storedTokenPresent();
          const gh = storedCredentialKind(provider, storedToken) === "gh-cli"
            ? await sharedDirectAuth()
            : null;
          facts.auth = {
            storedToken,
            ghAuthenticated: gh?.authenticated ?? false,
            ...(gh?.unproven ? { ghAuthUnproven: true as const } : {}),
            provider,
            profiles: deps.authProfiles(),
            pinnedIntegrationId: deps.pinnedIntegrationId(),
          };
        })(),
      );
    }
  }

  // `--live`: run each agent's read-only smoke prompt against its CONFIGURED home
  // (a `--profile` narrowing routes it through that profile's wiring). Only in
  // the agent-focused scopes, and only when explicitly requested (a live model
  // call, slow). Skipped instantly when the CLI isn't installed. The default
  // sweep never runs per-profile live probes -- only a narrowed run does.
  if (opts.live && SCOPE_CODEX_LIVE.includes(scope)) {
    jobs.push(
      (async () => {
        facts.codexLive = await deps.codexLive(deps.codexHome(), profile);
      })(),
    );
  }
  if (opts.live && SCOPE_CLAUDE_LIVE.includes(scope)) {
    jobs.push(
      (async () => {
        facts.claudeLive = await deps.claudeLive(deps.claudeHome(), profile);
      })(),
    );
  }

  if (profile === null && SCOPE_SETUP.includes(scope)) {
    jobs.push(
      (async () => {
        // Resolving shell targets shells out to PowerShell on Windows and can
        // throw; degrade to "no targets" rather than crashing the whole
        // diagnostic -- but MARKED (targetsUnproven), so the empty census
        // renders "could not check", never a confident "not wired".
        let targets: string[] = [];
        let targetsUnproven = false;
        try {
          targets = deps.shellTargets();
        } catch {
          targetsUnproven = true;
        }
        const contents = targets.map((path) => ({ path, content: deps.readFileSafe(path) }));
        facts.shell = {
          ...evalShellFiles(contents, new CopilotEnvConfig().launchersEnabled()),
          ...(targetsUnproven ? { targetsUnproven: true as const } : {}),
        };
        facts.clis = deps.agentClis().map((c) => ({
          command: c.command,
          name: c.name,
          look: deps.commandLook(c.command),
        }));
        facts.tools = { node: deps.commandLook("node"), npm: deps.commandLook("npm") };
        const home = deps.codexHome();
        const hostHome = deps.hostCodexHome();
        facts.codexHost = {
          supported: process.platform !== "win32",
          hostHome,
          exists: deps.dirExists(hostHome),
          active: home === hostHome,
        };
        facts.autoupdate = deps.readAutoupdate();
      })(),
    );
  }

  await Promise.all(jobs);
  return facts;
}
