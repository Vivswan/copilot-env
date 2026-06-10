// I/O fact-gathering for `agent health`. Each scope gathers ONLY the facts it
// needs (the `runtime` scope stays minimal — no shell/CLI probes — though the
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
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { isCopilotApiPid, pidAlive } from "../copilot_api/process.ts";
import { CopilotApiState } from "../copilot_api/state.ts";
import {
  type GatewayVersionStatus,
  gatewayVersionBoundsStatus,
  installedGatewayVersion,
} from "../copilot_api/version.ts";
import { nodeModulesFresh, resolveMinimumReleaseAgeSeconds } from "../gateway_float.ts";
import { childPathPrepending, cliSpawn, resolveCommand } from "../utils/command.ts";
import {
  CLAUDE_PROBE,
  CODEX_PROBE,
  PROBE_PROMPT,
  PROBE_TIMEOUT_MS,
} from "../utils/direct_probe.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { packageVersion } from "../utils/version.ts";
import type { HealthScope } from "./types.ts";

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
  /** Both Codex and Claude are configured direct => the gateway is not required. */
  bothDirect: boolean;
}

export interface BootstrapFacts {
  cliVersion: string;
  bun: { available: boolean; version: string | null };
  nodeModules: { present: boolean; fresh: boolean };
}

export interface GatewayFacts {
  version: string | null;
  // null when the project config could not be read (see configError).
  bounds: GatewayVersionStatus | null;
  configError: string | null;
  // The gateway float's cooldown window in seconds (null if it couldn't be read).
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
}

/** Codex wiring facts: the home being inspected plus the wiring contract status. */
export type CodexFacts = CodexWiringStatus & { home: string; directAuth: CodexDirectAuthFacts };

/** Claude wiring facts: the home + settings.json contract + gh-auth (for direct). */
export type ClaudeFacts = ClaudeWiringStatus & {
  home: string;
  settingsPath: string;
  directAuth: CodexDirectAuthFacts;
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
  gateway?: GatewayFacts;
  shell?: ShellFacts;
  clis?: CliFacts[];
  tools?: ToolFacts;
  codex?: CodexFacts;
  codexHost?: CodexHostFacts;
  claude?: ClaudeFacts;
  codexLive?: LiveProbeFacts;
  claudeLive?: LiveProbeFacts;
  autoupdate?: AutoupdateData;
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
  installedGatewayVersion(): string | null;
  projectConfig(): ProjectConfig;
  gatewayCooldownSeconds(): number;
  codexHome(): string;
  codexTokenInEnviron(): boolean;
  codexDirectAuth(): Promise<CodexDirectAuthFacts>;
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
 * Run an agent CLI's read-only smoke prompt against a CONFIGURED home (`--live`).
 * Async (overlaps the other probes) with a hard timeout; a timeout or any
 * non-zero exit => ok:false. Skipped (ran:false) when the CLI isn't installed.
 * Spawns the RESOLVED path so the nvm fallback isn't defeated.
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
    const child = spawn(s.file, s.args, {
      stdio: "ignore",
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
    child.on("error", () => resolve({ ran: true, ok: false, cli: resolved }));
    child.on("close", (code) => resolve({ ran: true, ok: code === 0, cli: resolved }));
  });
}

export function defaultProbeDeps(): ProbeDeps {
  const root = PROJECT_ROOT;
  return {
    root,
    resolvePort: copilotApiResolvePort,
    reach: reachUrl,
    readState: () => new CopilotApiState().read(),
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
    installedGatewayVersion: () => installedGatewayVersion(root),
    projectConfig: () => readProjectConfig(root),
    gatewayCooldownSeconds: () => resolveMinimumReleaseAgeSeconds(root),
    // Effective CODEX_HOME, matching runCodexConfig / env.ts precedence:
    // per-host state override, then $CODEX_HOME, then the default ~/.codex.
    codexHome: () =>
      new CopilotApiState().read().codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    codexTokenInEnviron: () => Boolean(process.env[CODEX_ENV_KEY]),
    codexDirectAuth,
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
      runLiveCli(CODEX_PROBE.cli, CODEX_PROBE.args(PROBE_PROMPT), home, CODEX_PROBE.homeEnvVar),
    claudeLive: (home) =>
      runLiveCli(CLAUDE_PROBE.cli, CLAUDE_PROBE.args(PROBE_PROMPT), home, CLAUDE_PROBE.homeEnvVar),
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
): CodexFacts {
  return {
    home,
    directAuth,
    ...inspectCodexWiring(configToml, envText, expectedPort, envKeyInEnviron),
  };
}

export function evalClaude(
  home: string,
  settingsText: string | null,
  directAuth: CodexDirectAuthFacts = { command: null, authenticated: false },
): ClaudeFacts {
  return {
    home,
    settingsPath: join(home, "settings.json"),
    directAuth,
    ...inspectClaudeWiring(settingsText, home),
  };
}

// --- orchestration ----------------------------------------------------------

const SCOPE_RUNTIME: readonly HealthScope[] = ["full", "gateway", "runtime"];
const SCOPE_BOOTSTRAP: readonly HealthScope[] = ["full", "gateway"];
const SCOPE_SETUP: readonly HealthScope[] = ["full", "setup"];
const SCOPE_CODEX: readonly HealthScope[] = ["full", "setup", "codex"];
const SCOPE_CLAUDE: readonly HealthScope[] = ["full", "setup", "claude"];
// `--live` end-to-end prompts only run in the agent-focused scopes (never setup).
const SCOPE_CODEX_LIVE: readonly HealthScope[] = ["full", "codex"];
const SCOPE_CLAUDE_LIVE: readonly HealthScope[] = ["full", "claude"];

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

  const jobs: Promise<void>[] = [];

  if (SCOPE_RUNTIME.includes(scope)) {
    jobs.push(
      (async () => {
        const state = deps.readState();
        const trackedPid = state.pid ?? null;
        const [reachable, pidTracked] = await Promise.all([
          deps.reach(`http://localhost:${port}/`, 2000),
          trackedPid !== null ? deps.isTrackedPid(trackedPid) : Promise.resolve(false),
        ]);
        facts.runtime = {
          port,
          reachable,
          trackedPid,
          pidTracked,
          pidAlive: trackedPid !== null ? deps.isPidAlive(trackedPid) : false,
          paths: deps.paths(),
          // When both agents are configured direct, no gateway is required, so a
          // down gateway must not read as a runtime failure.
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
        const version = deps.installedGatewayVersion();
        // A bad COPILOT_API_MIN_RELEASE_AGE / bunfig value shouldn't crash health.
        let cooldownSeconds: number | null = null;
        try {
          cooldownSeconds = deps.gatewayCooldownSeconds();
        } catch {
          cooldownSeconds = null;
        }
        // Reading copilot-env.config can throw on a malformed/missing file; turn
        // that into a gateway-check failure rather than crashing the whole report.
        try {
          facts.gateway = {
            version,
            bounds: gatewayVersionBoundsStatus(version, deps.projectConfig()),
            configError: null,
            cooldownSeconds,
          };
        } catch (e) {
          facts.gateway = {
            version,
            bounds: null,
            configError: e instanceof Error ? e.message : String(e),
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
        facts.codex = evalCodex(
          home,
          configToml,
          envText,
          port,
          deps.codexTokenInEnviron(),
          await sharedDirectAuth(),
        );
      })(),
    );
  }

  if (SCOPE_CLAUDE.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.claudeHome();
        const settingsText = deps.readFileSafe(join(home, "settings.json"));
        // Direct mode authenticates via `gh auth token`, same probe as Codex.
        facts.claude = evalClaude(home, settingsText, await sharedDirectAuth());
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
