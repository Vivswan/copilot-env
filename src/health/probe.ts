// I/O fact-gathering for `agent health`. Each scope gathers ONLY the facts it
// needs (the `runtime` scope stays minimal -- no shell/CLI probes -- though the
// tracked-pid check still spawns `ps`/PowerShell exactly as the original health
// command did). Pure sub-evaluators (evalShellFiles, evalCodex) take raw content
// so they unit-test without touching the world.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
import {
  type ClaudeWiringStatus,
  directHelperResolvesViaAgent,
  inspectClaudeWiring,
} from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { CODEX_ENV_KEY, type CodexWiringStatus, inspectCodexWiring } from "../codex/config.ts";
import { getHostLocalCodexHome } from "../codex/host.ts";
import { codexConfigPath, defaultCodexHome } from "../codex/paths.ts";
import { credentialSource } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  type AuthProvider,
  allProfileNames,
  CopilotEnvState,
  type ProfileMode,
} from "../copilot_api/env_state.ts";
import { ghAuthTokenSpawnSpec } from "../copilot_api/gh_cli.ts";
import { CopilotApiPaths, profileHomeExists } from "../copilot_api/paths.ts";
import {
  copilotApiFallbackPort,
  copilotApiResolvePort,
  proxyLoopbackOrigin,
} from "../copilot_api/port.ts";
import { isCopilotApiPid, pidAlive } from "../copilot_api/process.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import {
  installedProxyVersion,
  type ProxyVersionStatus,
  proxyVersionBoundsStatus,
} from "../copilot_api/version.ts";
import {
  nodeModulesFresh,
  proxyFloatSkips,
  resolveMinimumReleaseAgeSeconds,
} from "../proxy_float.ts";
import { idleTimeoutMs } from "../scripts/idle_watchdog.ts";
import { persistedInferenceMs } from "../scripts/inference_activity.ts";
import { hasMarker, LAUNCHERS_MARKER, MARKER, shellTargetFiles } from "../shell/integration.ts";
import { childEnvWithPath, cliSpawn, resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { readTextOrNull } from "../utils/fs.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { packageVersion } from "../utils/version.ts";
import type { HealthScope } from "./types.ts";
import {
  AUTH_SCOPES as SCOPE_AUTH,
  BOOTSTRAP_SCOPES as SCOPE_BOOTSTRAP,
  CLAUDE_SCOPES as SCOPE_CLAUDE,
  CLAUDE_LIVE_SCOPES as SCOPE_CLAUDE_LIVE,
  CODEX_SCOPES as SCOPE_CODEX,
  CODEX_LIVE_SCOPES as SCOPE_CODEX_LIVE,
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

/** A named profile's store slot as a runtime target reports it (never tokens). */
export interface ProfileSlotFacts {
  exists: boolean;
  provider: AuthProvider | null;
  mode: ProfileMode | null;
}

/**
 * The runtime facts for ONE daemon target: the default (profile null) or a
 * named profile's isolated daemon. Gathering is READ-ONLY -- the port comes
 * from the same run-state snapshot as the pid (proxyStatus's rule), with
 * copilotApiFallbackPort's non-reserving, non-re-reading fallback when none is
 * recorded; health never reserves a port or creates a file.
 */
export interface RuntimeTarget {
  /** The profile this target describes (null = the default daemon). */
  profile: Profile;
  /** Named targets only: the credential store slot (null for the default). */
  slot: ProfileSlotFacts | null;
  /** Named targets only: the isolated daemon home exists (null for the default). */
  homeExists: boolean | null;
  /** Whether this target's setup routes anything through a local proxy; when
   *  false, a down daemon is not a failure (default target: the inverse of
   *  "both Codex and Claude are wired direct"). */
  proxyExpected: boolean;
  port: number;
  reachable: boolean;
  trackedPid: number | null;
  pidTracked: boolean;
  pidAlive: boolean;
  /** Identity of whatever is reachable on the port: true = copilot-api (x-trace-id present),
   *  false = reachable but NOT copilot-api (likely a foreign listener), null = not probed
   *  (port down, the fast `runtime` scope which skips the extra request, or proxyExpected
   *  false -- no agent routes to the port, so its occupant is not ours to interrogate). */
  identityConfirmed: boolean | null;
  paths: RuntimePathsView;
  /** Idle auto-stop watchdog state, observed from outside the daemon. */
  watchdog: WatchdogFacts;
}

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
  bun: { available: boolean; version: string | null };
  nodeModules: { present: boolean; fresh: boolean };
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
}

export interface ShellFileFact {
  path: string;
  hasIntegration: boolean;
  hasLaunchers: boolean;
}

export interface ShellFacts {
  files: ShellFileFact[];
  integrationWired: boolean;
  launchersWired: boolean;
}

export interface CliFacts {
  command: string;
  name: string;
  resolved: string | null;
}

export interface ToolFacts {
  node: string | null;
  npm: string | null;
}

export interface CodexDirectAuthFacts {
  command: string | null;
  authenticated: boolean;
}

/**
 * Result of a `--live` end-to-end prompt against an agent CLI's CONFIGURED home.
 * Skipped when the CLI isn't installed (not a failure); a probe that RAN always
 * names the resolved CLI, and a failure always carries the captured reason + a
 * tail of the real CLI output -- a skipped-yet-ok result is unrepresentable.
 */
export type LiveProbeFacts =
  | { kind: "skipped" }
  | { kind: "ok"; cli: string }
  | { kind: "failed"; cli: string; detail: string };

/** Codex wiring facts: the home being inspected plus the wiring contract status. */
export type CodexFacts = CodexWiringStatus & {
  home: string;
  directAuth: CodexDirectAuthFacts;
  /** Recorded auth provider -- lets the check frame a non-gh-cli credential miss. */
  provider?: AuthProvider | null;
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
 * Autoupdate status for health: the persisted state plus the effective cooldown,
 * which is the LIVE `update-cooldown` config (never snapshotted into state) -- so
 * `agent health` matches `agent update --auto-status`.
 */
export type AutoupdateStatus = AutoupdateData & { cooldownDays: number };

export interface HealthFacts {
  /** One entry per runtime target; this commit always exactly the default. */
  runtimes?: RuntimeTarget[];
  bootstrap?: BootstrapFacts;
  proxy?: ProxyFacts;
  shell?: ShellFacts;
  clis?: CliFacts[];
  tools?: ToolFacts;
  auth?: AuthFacts;
  codex?: CodexFacts;
  codexHost?: CodexHostFacts;
  claude?: ClaudeFacts;
  codexLive?: LiveProbeFacts;
  claudeLive?: LiveProbeFacts;
  autoupdate?: AutoupdateStatus;
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
  isTrackedPid(pid: number): Promise<boolean>;
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
  commandResolved(command: string): string | null;
  agentClis(): readonly { command: string; name: string }[];
  shellTargets(): string[];
  readFileSafe(path: string): string | null;
  installedProxyVersion(): string | null;
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
  readAutoupdate(): AutoupdateStatus;
  nodeModulesPresent(): boolean;
  nodeModulesFresh(): boolean;
  bunVersion(): string | null;
  cliVersion(): string;
  /** `--live` end-to-end prompts against the configured Codex/Claude homes. */
  codexLive(home: string): Promise<LiveProbeFacts>;
  claudeLive(home: string): Promise<LiveProbeFacts>;
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

function codexDirectAuth(): Promise<CodexDirectAuthFacts> {
  const command = resolveCommand("gh");
  if (command === null) return Promise.resolve({ command: null, authenticated: false });
  // Async (non-blocking) so it runs concurrently with the other probes under
  // gatherFacts' Promise.all, instead of freezing the event loop for the whole
  // `gh auth token` call. ghAuthTokenSpawnSpec owns the spawn recipe (resolved path,
  // gh's bin dir on PATH, the shared timeout). stdio:"ignore" keeps the printed
  // token out of our process memory. A timeout (SIGTERM) or any non-zero exit =>
  // authenticated:false.
  return new Promise((resolve) => {
    const s = ghAuthTokenSpawnSpec(command);
    const child = spawn(s.file, s.args, {
      stdio: "ignore",
      timeout: s.timeout,
      windowsHide: true,
      shell: s.shell,
      env: s.env,
    });
    child.on("error", () => resolve({ command, authenticated: false }));
    child.on("close", (code) => resolve({ command, authenticated: code === 0 }));
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
 * sanitized -- `--live` tests the user's real, fully-resolved setup.
 */
function runLiveCli(
  cli: string,
  args: string[],
  home: string,
  homeEnvVar: string,
): Promise<LiveProbeFacts> {
  const resolved = resolveCommand(cli);
  if (resolved === null) return Promise.resolve({ kind: "skipped" });
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
      }),
    );
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

export function defaultProbeDeps(): ProbeDeps {
  const root = PROJECT_ROOT;
  return {
    root,
    resolvePort: copilotApiResolvePort,
    fallbackPort: copilotApiFallbackPort,
    reach: reachUrl,
    proxyIdentity,
    readState: (profile) => CopilotEnvRunState.forProfile(profile).read(),
    isTrackedPid: isCopilotApiPid,
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
      return { exists, provider: slot.authProvider, mode: slot.mode };
    },
    profileHomeExists,
    commandResolved: resolveCommand,
    agentClis: () => AGENT_CLIS,
    shellTargets: shellTargetFiles,
    readFileSafe: readTextOrNull,
    installedProxyVersion: () => installedProxyVersion(root),
    projectConfig: () => readProjectConfig(root),
    proxyCooldownSeconds: () => resolveMinimumReleaseAgeSeconds(root),
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
          provider: slot.authProvider,
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
    readAutoupdate: () => ({
      ...new AutoupdateState().read(),
      cooldownDays: effectiveUpdateCooldownDays(),
    }),
    nodeModulesPresent: () => existsSync(join(root, "node_modules")),
    nodeModulesFresh: () => {
      try {
        return nodeModulesFresh(root);
      } catch {
        return false;
      }
    },
    bunVersion: () => process.versions.bun ?? null,
    cliVersion: packageVersion,
    codexLive: (home) =>
      runLiveCli(
        CODEX_PROBE.cli,
        CODEX_PROBE.args(PROBE_PROMPT, home),
        home,
        CODEX_PROBE.homeEnvVar,
      ),
    claudeLive: (home) =>
      runLiveCli(
        CLAUDE_PROBE.cli,
        CLAUDE_PROBE.args(PROBE_PROMPT, home),
        home,
        CLAUDE_PROBE.homeEnvVar,
      ),
  };
}

// --- pure sub-evaluators (no I/O) -------------------------------------------

/** Derive shell-wiring facts from raw rc/profile contents (null = absent file). */
export function evalShellFiles(contents: { path: string; content: string | null }[]): ShellFacts {
  const files: ShellFileFact[] = contents.map(({ path, content }) => ({
    path,
    hasIntegration: content !== null && hasMarker(content, MARKER),
    hasLaunchers: content !== null && hasMarker(content, LAUNCHERS_MARKER),
  }));
  return {
    files,
    integrationWired: files.some((f) => f.hasIntegration),
    launchersWired: files.some((f) => f.hasLaunchers),
  };
}

/**
 * Codex-wiring facts for the effective CODEX_HOME. Thin wrapper over the codex
 * module's `inspectCodexWiring` (the single source of the wiring contract) that
 * just attaches the home being inspected.
 */
export function evalCodex(
  home: string,
  configToml: string | null,
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
  settingsText: string | null,
  directAuth: CodexDirectAuthFacts = { command: null, authenticated: false },
  directUsesToken = false,
  wiring: ClaudeWiringStatus = inspectClaudeWiring(settingsText, home, 0),
): ClaudeFacts {
  return {
    home,
    settingsPath: settingsPathFor(home),
    directAuth,
    directUsesToken,
    ...wiring,
  };
}

// --- orchestration ----------------------------------------------------------

/**
 * Gather ONE runtime target's facts. READ-ONLY: nothing here writes a file or
 * reserves a port. Snapshot semantics: pid and port come from a single
 * run-state read (proxyStatus's documented rule), so a concurrent start/stop
 * can't pair one daemon's pid with another's port; fallbackPort covers the
 * no-recorded-port case without a second read of the same file.
 */
async function gatherRuntimeTarget(
  profile: Profile,
  scope: HealthScope,
  deps: ProbeDeps,
  target: {
    slot: ProfileSlotFacts | null;
    homeExists: boolean | null;
    proxyExpected: (port: number) => boolean;
  },
): Promise<RuntimeTarget> {
  const state = deps.readState(profile);
  const port = state.port ?? deps.fallbackPort(profile);
  const trackedPid = state.pid ?? null;
  // proxyLoopbackOrigin, matching portListening: a localhost probe reads DOWN on Windows
  // while the proxy is up.
  const probeUrl = `${proxyLoopbackOrigin(port)}/`;
  const [reachable, pidTracked] = await Promise.all([
    deps.reach(probeUrl, 2000),
    trackedPid !== null ? deps.isTrackedPid(trackedPid) : Promise.resolve(false),
  ]);
  const proxyExpected = target.proxyExpected(port);
  // Identity probe (an extra local request) only in the full/proxy scopes -- never the
  // launchers' fast `runtime` probe. Only meaningful when something is reachable AND this
  // target's setup actually routes through the port: with both agents direct, nothing we
  // manage talks to whatever answers there, so its identity is none of our business (and
  // never grounds for a misroute warning).
  const identityConfirmed =
    SCOPE_BOOTSTRAP.includes(scope) && reachable && proxyExpected
      ? await deps.proxyIdentity(probeUrl, 2000)
      : null;
  return {
    profile,
    slot: target.slot,
    homeExists: target.homeExists,
    proxyExpected,
    port,
    reachable,
    trackedPid,
    pidTracked,
    pidAlive: trackedPid !== null ? deps.isPidAlive(trackedPid) : false,
    identityConfirmed,
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
  };
}

/** Gather exactly the facts `scope` needs, running independent probes concurrently. */
export async function gatherFacts(
  scope: HealthScope,
  opts: { live?: boolean } = {},
  overrides?: Partial<ProbeDeps>,
): Promise<HealthFacts> {
  const deps: ProbeDeps = { ...defaultProbeDeps(), ...overrides };
  const port = Number(deps.resolvePort(null));
  const facts: HealthFacts = {};

  // gh auth backs BOTH Codex and Claude direct mode; probe it at most once per
  // run, and asynchronously, so the single ~5s `gh auth token` call overlaps with
  // the other probes under Promise.all instead of serializing into the health
  // timeout. Both jobs await the same cached promise.
  let directAuthCache: Promise<CodexDirectAuthFacts> | undefined;
  const sharedDirectAuth = (): Promise<CodexDirectAuthFacts> =>
    (directAuthCache ??= deps.codexDirectAuth());

  // Skip the (~5s) gh probe -- and report Direct as "uses token" -- only when the
  // config is `managed` (execs `agent auth --get`) AND the credential classifies as
  // stored-token; gh-cli classifies to a live gh probe. Shared by the Codex and
  // Claude scope jobs so the gating stays identical. Classification is owned by
  // credentialSource() (credential.ts) -- a leftover token with no provider is
  // "none": no gh probe (no implicit fallback), and Direct never reads green.
  const directAuthFor = async (
    managed: boolean,
  ): Promise<{ directAuth: CodexDirectAuthFacts; noGhNeeded: boolean }> => {
    const source = credentialSource(deps.authProvider(), deps.storedTokenPresent());
    const noGhNeeded = managed && source === "stored-token";
    const directAuth =
      source === "gh-cli" ? await sharedDirectAuth() : { command: null, authenticated: false };
    return { directAuth, noGhNeeded };
  };

  const jobs: Promise<void>[] = [];

  if (SCOPE_RUNTIME.includes(scope)) {
    jobs.push(
      (async () => {
        // Exactly one target today: the default daemon. Named-profile targets
        // (deps.profileNames()) join this list in a follow-up.
        facts.runtimes = [
          await gatherRuntimeTarget(null, scope, deps, {
            slot: null,
            homeExists: null,
            // When both agents are configured direct, no proxy is required, so a
            // down proxy must not read as a runtime failure.
            proxyExpected: (targetPort) =>
              defaultSetupNeedsProxy({
                codexHome: deps.codexHome(),
                claudeHome: deps.claudeHome(),
                expectedPort: targetPort,
              }),
          }),
        ];
      })(),
    );
  }

  if (SCOPE_BOOTSTRAP.includes(scope)) {
    jobs.push(
      (async () => {
        facts.bootstrap = {
          cliVersion: deps.cliVersion(),
          bun: { available: deps.bunVersion() !== null, version: deps.bunVersion() },
          nodeModules: { present: deps.nodeModulesPresent(), fresh: deps.nodeModulesFresh() },
        };
        const version = deps.installedProxyVersion();
        // A bad COPILOT_API_MIN_RELEASE_AGE / bunfig value shouldn't crash health.
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
          };
        } catch (e) {
          facts.proxy = {
            version,
            bounds: null,
            configError: errMessage(e),
            cooldownSeconds,
            floatSkips,
          };
        }
      })(),
    );
  }

  if (SCOPE_CODEX.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.codexHome();
        const configToml = deps.readFileSafe(codexConfigPath(home));
        const envText = deps.readFileSafe(join(home, ".env"));
        const wiring = inspectCodexWiring(configToml, envText, port, deps.codexTokenInEnviron());
        const { directAuth, noGhNeeded } = await directAuthFor(wiring.directUsesToken);
        // The wiring's `directUsesToken` stays a pure CONFIG fact; the store-aware
        // "Direct needs no gh" verdict travels on its own field (`directNeedsNoGh`,
        // the meaning checkCodex consumes).
        const codexFacts = evalCodex(
          home,
          configToml,
          envText,
          port,
          deps.codexTokenInEnviron(),
          directAuth,
          noGhNeeded,
          wiring,
        );
        facts.codex = { ...codexFacts, provider: deps.authProvider() };
      })(),
    );
  }

  if (SCOPE_CLAUDE.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.claudeHome();
        const settingsText = deps.readFileSafe(settingsPathFor(home));
        const wiring = inspectClaudeWiring(settingsText, home, port);
        // Managed iff the apiKeyHelper truly execs `agent auth --get` (not a stale/
        // foreign/missing helper); directAuthFor then decides the gh probe.
        const usesManagedResolver =
          wiring.providerMode === "direct" &&
          wiring.helperPath !== null &&
          directHelperResolvesViaAgent(deps.readFileSafe(wiring.helperPath));
        const { directAuth, noGhNeeded } = await directAuthFor(usesManagedResolver);
        facts.claude = {
          ...evalClaude(home, settingsText, directAuth, noGhNeeded, wiring),
          provider: deps.authProvider(),
        };
      })(),
    );
  }

  if (SCOPE_AUTH.includes(scope)) {
    jobs.push(
      (async () => {
        // The credential state, agent-independent. gh is a credential ONLY when
        // credentialSource() says gh-cli (no implicit fallback); reuses the shared
        // (cached) gh probe -- no extra spawn.
        const provider = deps.authProvider();
        const storedToken = deps.storedTokenPresent();
        const ghAuthenticated =
          credentialSource(provider, storedToken) === "gh-cli"
            ? (await sharedDirectAuth()).authenticated
            : false;
        facts.auth = {
          storedToken,
          ghAuthenticated,
          provider,
          profiles: deps.authProfiles(),
          pinnedIntegrationId: deps.pinnedIntegrationId(),
        };
      })(),
    );
  }

  // `--live`: run each agent's read-only smoke prompt against its CONFIGURED home.
  // Only in the agent-focused scopes, and only when explicitly requested (a live
  // model call, slow). Skipped instantly when the CLI isn't installed.
  if (opts.live && SCOPE_CODEX_LIVE.includes(scope)) {
    jobs.push(
      (async () => {
        facts.codexLive = await deps.codexLive(deps.codexHome());
      })(),
    );
  }
  if (opts.live && SCOPE_CLAUDE_LIVE.includes(scope)) {
    jobs.push(
      (async () => {
        facts.claudeLive = await deps.claudeLive(deps.claudeHome());
      })(),
    );
  }

  if (SCOPE_SETUP.includes(scope)) {
    jobs.push(
      (async () => {
        // Resolving shell targets shells out to PowerShell on Windows and can
        // throw; degrade to "no targets" (-> shell reads as not-wired) rather
        // than crashing the whole diagnostic.
        let targets: string[] = [];
        try {
          targets = deps.shellTargets();
        } catch {
          targets = [];
        }
        const contents = targets.map((path) => ({ path, content: deps.readFileSafe(path) }));
        facts.shell = evalShellFiles(contents);
        facts.clis = deps.agentClis().map((c) => ({
          command: c.command,
          name: c.name,
          resolved: deps.commandResolved(c.command),
        }));
        facts.tools = { node: deps.commandResolved("node"), npm: deps.commandResolved("npm") };
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
