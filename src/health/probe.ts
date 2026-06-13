// I/O fact-gathering for `agent health`. Each scope gathers ONLY the facts it
// needs (the `runtime` scope stays minimal -- no shell/CLI probes -- though the
// tracked-pid check still spawns `ps`/PowerShell exactly as the original health
// command did). Pure sub-evaluators (evalShellFiles, evalCodex) take raw content
// so they unit-test without touching the world.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AutoupdateData, AutoupdateState } from "../autoupdate/state.ts";
import {
  type ClaudeWiringStatus,
  directHelperResolvesViaAgent,
  inspectClaudeWiring,
  resolveClaudeHome,
} from "../claude/config.ts";
import { CODEX_ENV_KEY, type CodexWiringStatus, inspectCodexWiring } from "../codex/config.ts";
import { getHostLocalCodexHome } from "../codex/host.ts";
import { AGENT_CLIS } from "../commands/setup.ts";
import {
  hasMarker,
  LAUNCHERS_MARKER,
  MARKER,
  shellTargetFiles,
} from "../commands/shell_integration.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { isCopilotApiPid, pidAlive } from "../copilot_api/process.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import {
  installedProxyVersion,
  type ProxyVersionStatus,
  proxyVersionBoundsStatus,
} from "../copilot_api/version.ts";
import { nodeModulesFresh, resolveMinimumReleaseAgeSeconds } from "../proxy_float.ts";
import { childPathPrepending, cliSpawn, resolveCommand } from "../utils/command.ts";
import {
  CLAUDE_PROBE,
  CODEX_PROBE,
  PROBE_PROMPT,
  PROBE_TIMEOUT_MS,
} from "../utils/direct_probe.ts";
import { errMessage } from "../utils/error.ts";
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

export interface RuntimePaths {
  home: string;
  configFile: string;
  runDir: string;
  stateFile: string;
  logFile: string;
  sqliteDb: string;
}

export interface RuntimeFacts {
  port: number;
  reachable: boolean;
  trackedPid: number | null;
  pidTracked: boolean;
  pidAlive: boolean;
  paths: RuntimePaths;
  /** Both Codex and Claude are configured direct => the proxy is not required. */
  bothDirect: boolean;
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
 * `ran` is false when the CLI isn't installed (the check is skipped, not failed).
 */
export interface LiveProbeFacts {
  ran: boolean;
  ok: boolean;
  cli: string | null;
  /** On failure (`ok: false`): the captured reason + a tail of the real CLI output. */
  detail?: string;
}

/** Codex wiring facts: the home being inspected plus the wiring contract status. */
export type CodexFacts = CodexWiringStatus & {
  home: string;
  directAuth: CodexDirectAuthFacts;
  /** Recorded auth provider -- lets the check frame a non-gh-cli credential miss. */
  provider?: string | null;
};

/** Claude wiring facts: the home + settings.json contract + gh-auth (for direct). */
export type ClaudeFacts = ClaudeWiringStatus & {
  home: string;
  settingsPath: string;
  directAuth: CodexDirectAuthFacts;
  /** Recorded auth provider -- lets the check frame a non-gh-cli credential miss. */
  provider?: string | null;
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

export interface HealthFacts {
  runtime?: RuntimeFacts;
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
  autoupdate?: AutoupdateData;
}

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
  provider: string | null;
}

// --- injectable I/O surface -------------------------------------------------

export interface ProbeDeps {
  root: string;
  resolvePort(): string;
  reach(url: string, timeoutMs: number): Promise<boolean>;
  readState(): { port?: number; pid?: number; codexHome?: string };
  isTrackedPid(pid: number): Promise<boolean>;
  isPidAlive(pid: number): boolean;
  paths(): RuntimePaths;
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
  authProvider(): string | null;
  claudeHome(): string;
  hostCodexHome(): string;
  dirExists(path: string): boolean;
  readAutoupdate(): AutoupdateData;
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

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function codexDirectAuth(): Promise<CodexDirectAuthFacts> {
  const command = resolveCommand("gh");
  if (command === null) return Promise.resolve({ command: null, authenticated: false });
  // Async (non-blocking) so it runs concurrently with the other probes under
  // gatherFacts' Promise.all, instead of freezing the event loop for the whole
  // `gh auth token` call. Spawn gh's RESOLVED path (not the bare name) so an
  // nvm-only gh resolveCommand found via the nvm fallback is runnable here.
  // stdio:"ignore" keeps the printed token out of our process memory. A timeout
  // (SIGTERM) or any non-zero exit => authenticated:false.
  return new Promise((resolve) => {
    const s = cliSpawn(command, ["auth", "token"]);
    const child = spawn(s.file, s.args, {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
      shell: s.shell,
      env: { ...process.env, PATH: childPathPrepending([dirname(command)]) },
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
    .filter((l) => l.trim() && !/"capabilities"|"object":\s*"model"|model_picker/.test(l));
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
  if (resolved === null) return Promise.resolve({ ran: false, ok: false, cli: null });
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
      env: {
        ...process.env,
        [homeEnvVar]: home,
        PATH: childPathPrepending([dirname(resolved), ghPath ? dirname(ghPath) : null]),
      },
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
        ran: true,
        ok: false,
        cli: resolved,
        detail: formatLiveFailure(null, null, e.message, out, err),
      }),
    );
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ ran: true, ok: true, cli: resolved });
      } else {
        resolve({
          ran: true,
          ok: false,
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
    reach: reachUrl,
    readState: () => new CopilotEnvRunState().read(),
    isTrackedPid: isCopilotApiPid,
    isPidAlive: pidAlive,
    paths: () => {
      const p = new CopilotApiPaths();
      return {
        home: p.home,
        configFile: p.configFile,
        runDir: p.runDir,
        stateFile: p.stateFile,
        logFile: p.logFile,
        sqliteDb: p.sqliteDb,
      };
    },
    commandResolved: resolveCommand,
    agentClis: () => AGENT_CLIS,
    shellTargets: shellTargetFiles,
    readFileSafe,
    installedProxyVersion: () => installedProxyVersion(root),
    projectConfig: () => readProjectConfig(root),
    proxyCooldownSeconds: () => resolveMinimumReleaseAgeSeconds(root),
    // Effective CODEX_HOME, matching runCodexConfig / env.ts precedence:
    // per-host state override, then $CODEX_HOME, then the default ~/.codex.
    codexHome: () =>
      new CopilotEnvRunState().read().codexHome ??
      process.env.CODEX_HOME ??
      join(homedir(), ".codex"),
    codexTokenInEnviron: () => Boolean(process.env[CODEX_ENV_KEY]),
    codexDirectAuth,
    storedTokenPresent: () => new CopilotEnvState().read().githubToken !== null,
    authProvider: () => new CopilotEnvState().read().authProvider,
    // Claude's direct mode also authenticates via `gh auth token`, so it reuses
    // the same probe. Effective Claude home matches resolveClaudeHome precedence.
    claudeHome: () => resolveClaudeHome(),
    hostCodexHome: getHostLocalCodexHome,
    dirExists: (path: string) => existsSync(path),
    readAutoupdate: () => new AutoupdateState().read(),
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
    ...wiring,
  };
}

export function evalClaude(
  home: string,
  settingsText: string | null,
  directAuth: CodexDirectAuthFacts = { command: null, authenticated: false },
  directUsesToken = false,
  wiring: ClaudeWiringStatus = inspectClaudeWiring(settingsText, home),
): ClaudeFacts {
  return {
    home,
    settingsPath: join(home, "settings.json"),
    directAuth,
    directUsesToken,
    ...wiring,
  };
}

// --- orchestration ----------------------------------------------------------

/** Read the configured Codex/Claude provider modes (cheap, no live probe). */
function readProviderModes(deps: ProbeDeps, port: number): { bothDirect: boolean } {
  const codexHome = deps.codexHome();
  const codexMode = inspectCodexWiring(
    deps.readFileSafe(join(codexHome, "config.toml")),
    null,
    port,
    false,
  ).providerMode;
  const claudeHome = deps.claudeHome();
  const claudeMode = inspectClaudeWiring(
    deps.readFileSafe(join(claudeHome, "settings.json")),
    claudeHome,
  ).providerMode;
  return { bothDirect: codexMode === "direct" && claudeMode === "direct" };
}

/** Gather exactly the facts `scope` needs, running independent probes concurrently. */
export async function gatherFacts(
  scope: HealthScope,
  opts: { live?: boolean } = {},
  overrides?: Partial<ProbeDeps>,
): Promise<HealthFacts> {
  const deps: ProbeDeps = { ...defaultProbeDeps(), ...overrides };
  const port = Number(deps.resolvePort());
  const facts: HealthFacts = {};

  // gh auth backs BOTH Codex and Claude direct mode; probe it at most once per
  // run, and asynchronously, so the single ~5s `gh auth token` call overlaps with
  // the other probes under Promise.all instead of serializing into the health
  // timeout. Both jobs await the same cached promise.
  let directAuthCache: Promise<CodexDirectAuthFacts> | undefined;
  const sharedDirectAuth = (): Promise<CodexDirectAuthFacts> =>
    (directAuthCache ??= deps.codexDirectAuth());

  // Skip the (~5s) gh probe -- and report Direct as "uses token" -- only when the
  // config truly resolves via the managed `agent auth --get` (`managed`) AND a
  // token is stored; otherwise probe gh (a stale/foreign config still needs it).
  // Shared by the Codex and Claude scope jobs so the gating stays identical.
  // Decide the Direct gh-auth facts for an agent whose config is `managed` (execs
  // `agent auth --get`), provider-aware to match `Credential.resolve()`:
  //   - copilot/gh-token with a stored token -> resolves via the token, skip gh.
  //   - gh-cli -> resolves via gh, so probe it (a leftover token does NOT count).
  //   - otherwise -> no credential resolves (report unauthenticated, no probe).
  const directAuthFor = async (
    managed: boolean,
  ): Promise<{ directAuth: CodexDirectAuthFacts; noGhNeeded: boolean }> => {
    const provider = deps.authProvider();
    // Mirror `Credential.resolve()` EXACTLY: only copilot/gh-token resolve via the
    // stored token (gh unneeded). A null/unknown provider does NOT resolve even with
    // a leftover token, so it still needs the gh check rather than reading green.
    const noGhNeeded =
      managed && (provider === "copilot" || provider === "gh-token") && deps.storedTokenPresent();
    const probeGh = !noGhNeeded && provider === "gh-cli";
    const directAuth = probeGh ? await sharedDirectAuth() : { command: null, authenticated: false };
    return { directAuth, noGhNeeded };
  };

  const jobs: Promise<void>[] = [];

  if (SCOPE_RUNTIME.includes(scope)) {
    jobs.push(
      (async () => {
        const state = deps.readState();
        const trackedPid = state.pid ?? null;
        const [reachable, pidTracked] = await Promise.all([
          // Probe 127.0.0.1, not `localhost`: the daemon binds 0.0.0.0 (IPv4), but on Windows
          // `localhost` resolves to ::1 first and the runtime's fetch does not fall back to
          // IPv4 -- so a `localhost` probe would report the proxy DOWN while it is up. 127.0.0.1
          // always hits the IPv4 listener (matching admin.ts and start.ts's portListening).
          deps.reach(`http://127.0.0.1:${port}/`, 2000),
          trackedPid !== null ? deps.isTrackedPid(trackedPid) : Promise.resolve(false),
        ]);
        facts.runtime = {
          port,
          reachable,
          trackedPid,
          pidTracked,
          pidAlive: trackedPid !== null ? deps.isPidAlive(trackedPid) : false,
          paths: deps.paths(),
          // When both agents are configured direct, no proxy is required, so a
          // down proxy must not read as a runtime failure.
          bothDirect: readProviderModes(deps, port).bothDirect,
        };
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
        try {
          facts.proxy = {
            version,
            bounds: proxyVersionBoundsStatus(version, deps.projectConfig()),
            configError: null,
            cooldownSeconds,
          };
        } catch (e) {
          facts.proxy = {
            version,
            bounds: null,
            configError: errMessage(e),
            cooldownSeconds,
          };
        }
      })(),
    );
  }

  if (SCOPE_CODEX.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.codexHome();
        const configToml = deps.readFileSafe(join(home, "config.toml"));
        const envText = deps.readFileSafe(join(home, ".env"));
        const wiring = inspectCodexWiring(configToml, envText, port, deps.codexTokenInEnviron());
        const { directAuth, noGhNeeded } = await directAuthFor(wiring.directUsesToken);
        const codexFacts = evalCodex(
          home,
          configToml,
          envText,
          port,
          deps.codexTokenInEnviron(),
          directAuth,
          wiring,
        );
        // Re-scope `directUsesToken` from the wiring's config meaning ("the direct
        // table carries the managed auth.command") to the store-aware "Direct needs
        // no gh" -- the meaning checkCodex consumes.
        facts.codex = { ...codexFacts, directUsesToken: noGhNeeded, provider: deps.authProvider() };
      })(),
    );
  }

  if (SCOPE_CLAUDE.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.claudeHome();
        const settingsText = deps.readFileSafe(join(home, "settings.json"));
        const wiring = inspectClaudeWiring(settingsText, home);
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
        // The credential state, agent-independent. `gh` is a credential ONLY for the
        // `gh-cli` provider (matching `Credential.resolve()` -- no implicit fallback),
        // so only probe it then. Reuses the shared (cached) gh probe -- no extra spawn.
        const provider = deps.authProvider();
        const storedToken = deps.storedTokenPresent();
        const ghAuthenticated =
          provider === "gh-cli" ? (await sharedDirectAuth()).authenticated : false;
        facts.auth = { storedToken, ghAuthenticated, provider };
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
