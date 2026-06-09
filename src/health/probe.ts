// I/O fact-gathering for `agent health`. Each scope gathers ONLY the facts it
// needs (the `runtime` scope stays minimal — no shell/CLI probes — though the
// tracked-pid check still spawns `ps`/PowerShell exactly as the original health
// command did). Pure sub-evaluators (evalShellFiles, evalCodex) take raw content
// so they unit-test without touching the world.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_ENV_KEY, type CodexWiringStatus, inspectCodexWiring } from "../codex/config.ts";
import { getHostLocalCodexHome } from "../codex/host.ts";
import { AGENT_CLIS, resolveCommand } from "../commands/setup.ts";
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
import { nodeModulesFresh } from "../gateway_float.ts";
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

/** Codex wiring facts: the home being inspected plus the wiring contract status. */
export type CodexFacts = CodexWiringStatus & { home: string };

export interface CodexHostFacts {
  /** The per-host CODEX_HOME farm is a Linux-only feature. */
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
  codexHome(): string;
  codexTokenInEnviron(): boolean;
  hostCodexHome(): string;
  dirExists(path: string): boolean;
  nodeModulesPresent(): boolean;
  nodeModulesFresh(): boolean;
  bunVersion(): string | null;
  cliVersion(): string;
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
    // Effective CODEX_HOME, matching runCodexConfig / env.ts precedence:
    // per-host state override, then $CODEX_HOME, then the default ~/.codex.
    codexHome: () =>
      new CopilotApiState().read().codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    codexTokenInEnviron: () => Boolean(process.env[CODEX_ENV_KEY]),
    hostCodexHome: getHostLocalCodexHome,
    dirExists: (path: string) => existsSync(path),
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
): CodexFacts {
  return { home, ...inspectCodexWiring(configToml, envText, expectedPort, envKeyInEnviron) };
}

// --- orchestration ----------------------------------------------------------

const SCOPE_RUNTIME: readonly HealthScope[] = ["full", "gateway", "runtime"];
const SCOPE_BOOTSTRAP: readonly HealthScope[] = ["full", "gateway"];
const SCOPE_SETUP: readonly HealthScope[] = ["full", "setup"];

/** Gather exactly the facts `scope` needs, running independent probes concurrently. */
export async function gatherFacts(
  scope: HealthScope,
  overrides?: Partial<ProbeDeps>,
): Promise<HealthFacts> {
  const deps: ProbeDeps = { ...defaultProbeDeps(), ...overrides };
  const port = Number(deps.resolvePort());
  const facts: HealthFacts = {};

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
        // Reading copilot-env.config can throw on a malformed/missing file; turn
        // that into a gateway-check failure rather than crashing the whole report.
        try {
          facts.gateway = {
            version,
            bounds: gatewayVersionBoundsStatus(version, deps.projectConfig()),
            configError: null,
          };
        } catch (e) {
          facts.gateway = {
            version,
            bounds: null,
            configError: e instanceof Error ? e.message : String(e),
          };
        }
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
        const configToml = deps.readFileSafe(join(home, "config.toml"));
        const envText = deps.readFileSafe(join(home, ".env"));
        facts.codex = evalCodex(home, configToml, envText, port, deps.codexTokenInEnviron());
        const hostHome = deps.hostCodexHome();
        facts.codexHost = {
          supported: process.platform === "linux",
          hostHome,
          exists: deps.dirExists(hostHome),
          active: home === hostHome,
        };
      })(),
    );
  }

  await Promise.all(jobs);
  return facts;
}
