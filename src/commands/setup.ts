// Setup domain logic for optional agent CLIs, launchers, and shell wiring helpers.
import { spawnSync } from "node:child_process";
import { consola } from "consola";
import { pickAgedVersion } from "../utils/aged_version.ts";
import { commandExists, resolveCommand } from "../utils/command.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";
import { configureBothAgents } from "./init.ts";
import { runShellIntegration } from "./shell_integration.ts";

const NVM_VERSION = "v0.40.1";

export const AGENT_CLIS = [
  {
    command: "claude",
    name: "Claude Code CLI",
    packageName: "@anthropic-ai/claude-code",
  },
  {
    command: "copilot",
    name: "GitHub Copilot CLI",
    packageName: "@github/copilot",
  },
  {
    command: "codex",
    name: "Codex CLI",
    packageName: "@openai/codex",
  },
] as const;

export interface SetupClisArgs {
  "all-hosts"?: boolean;
  cooldown?: number | null;
  launchers?: boolean;
  noSudo?: boolean;
  noPrereqs?: boolean;
}

export interface SetupShellArgs {
  remove?: boolean;
  "all-hosts"?: boolean;
}

export interface SetupLaunchersArgs {
  "all-hosts"?: boolean;
  remove?: boolean;
}

export interface NormalizedSetupClisOptions {
  cooldown: number | null;
  launchers: boolean;
  noSudo: boolean;
  noPrereqs: boolean;
}

export function normalizeSetupClisOptions(args: SetupClisArgs): NormalizedSetupClisOptions {
  const noSudo = Boolean(args.noSudo);
  const noPrereqs = Boolean(args.noPrereqs);
  if (noSudo && noPrereqs) {
    throw new Error("--no-sudo and --no-prereqs are mutually exclusive.");
  }

  const cooldown = args.cooldown ?? null;
  if (cooldown !== null && (!Number.isInteger(cooldown) || cooldown < 0)) {
    throw new Error(`--cooldown expects a non-negative whole number of days (got '${cooldown}')`);
  }

  return { cooldown, launchers: Boolean(args.launchers), noSudo, noPrereqs };
}

function run(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2] = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, { stdio: "inherit", ...options });
}

function warnMissing(command: string, name: string): void {
  if (!commandExists(command)) {
    consola.warn(
      `${name} ('${command}') is not installed; skipping. Install it yourself to use it.`,
    );
  }
}

function refreshWindowsPath(): void {
  if (process.platform !== "win32") return;
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$machine=[Environment]::GetEnvironmentVariable('Path','Machine');" +
        "$user=[Environment]::GetEnvironmentVariable('Path','User');" +
        "($machine,$user,$env:Path) -join ';'",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    consola.warn("Could not refresh this process PATH after install.");
    return;
  }
  process.env.Path = result.stdout.trim();
  process.env.PATH = result.stdout.trim();
}

function addWindowsUserPath(directory: string): void {
  if (process.platform !== "win32") return;
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$dir=${quotePowerShell(directory)};` +
        "$path=[Environment]::GetEnvironmentVariable('Path','User');" +
        "$entries=@($path -split ';' | Where-Object { $_ });" +
        "if ($entries -notcontains $dir) {" +
        "[Environment]::SetEnvironmentVariable('Path', (($entries + $dir) -join ';'), 'User')" +
        "}",
    ],
    { stdio: "ignore" },
  );
  if (result.status !== 0) consola.warn(`Could not add npm global bin to user PATH: ${directory}`);
  refreshWindowsPath();
}

function installNodePosix(): void {
  const script = [
    "set -e",
    `NVM_VERSION=${quotePosix(NVM_VERSION)}`,
    'NVM_DIR="$' + '{NVM_DIR:-$HOME/.nvm}"',
    'if [ ! -s "$NVM_DIR/nvm.sh" ]; then',
    '  echo "Installing nvm ($NVM_VERSION) ..."',
    '  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash',
    "fi",
    '[ -s "$NVM_DIR/nvm.sh" ]',
    '. "$NVM_DIR/nvm.sh"',
    'echo "Installing/activating Node.js LTS via nvm ..."',
    "nvm install --lts",
    "nvm alias default 'lts/*'",
  ].join("\n");
  const result = run("bash", ["-c", script]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("nvm failed to install/activate Node LTS.");
}

function installNodeWindows(): void {
  if (!commandExists("winget")) {
    throw new Error(
      "Cannot install Node.js because winget is unavailable. Install Node.js LTS and rerun 'agent setup-clis'.",
    );
  }
  consola.info("Installing Node.js LTS and npm ...");
  const result = run("winget", [
    "install",
    "--id",
    "OpenJS.NodeJS.LTS",
    "--exact",
    "--accept-package-agreements",
    "--accept-source-agreements",
  ]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Node.js LTS and npm installation failed.");
  refreshWindowsPath();
}

function ensureNpm(options: NormalizedSetupClisOptions): boolean {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  if (commandExists(npmCommand)) return true;

  if (options.noPrereqs) {
    warnMissing(process.platform === "win32" ? "npm.cmd" : "node", "Node.js");
    warnMissing(npmCommand, "npm");
    return false;
  }

  if (process.platform === "win32" && options.noSudo) {
    consola.warn(
      "Node.js/npm are not installed; --no-sudo will not use winget. Install Node.js yourself, then rerun 'agent setup-clis'.",
    );
    return false;
  }

  if (process.platform === "win32") installNodeWindows();
  else installNodePosix();
  return commandExists(npmCommand);
}

function npmArgs(): { command: string; prefix: string[] } {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const resolved = resolveCommand(npmCommand);
  if (!resolved) throw new Error("npm is required to install agent CLIs.");
  return { command: resolved, prefix: [] };
}

function runNpm(args: string[], capture = false): string {
  const npm = npmArgs();
  const result = spawnSync(npm.command, [...npm.prefix, ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
  return capture ? result.stdout.trim() : "";
}

function syncNpmGlobalBinToPath(): void {
  const prefix = runNpm(["prefix", "-g"], true);
  if (!prefix) return;
  const bin = process.platform === "win32" ? prefix : `${prefix}/bin`;
  const separator = process.platform === "win32" ? ";" : ":";
  const path = process.env.PATH ?? process.env.Path ?? "";
  if (!path.split(separator).includes(bin)) {
    process.env.PATH = `${bin}${separator}${path}`;
    process.env.Path = process.env.PATH;
  }
  addWindowsUserPath(bin);
}

function resolveAgedVersion(packageName: string, days: number): string {
  const raw = runNpm(["view", packageName, "time", "--json"], true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`could not parse npm publish times for ${packageName}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`npm publish times for ${packageName} were not an object`);
  }
  const version = pickAgedVersion(
    parsed as Record<string, string>,
    days * MILLISECONDS_PER_DAY,
    Date.now(),
  );
  if (!version) {
    throw new Error(`no release of ${packageName} is >=${days} days old (or npm is unreachable)`);
  }
  return version;
}

function installCli(cli: (typeof AGENT_CLIS)[number], options: NormalizedSetupClisOptions): void {
  if (commandExists(cli.command)) {
    consola.info(`${cli.name} already installed.`);
    return;
  }

  let spec: string = cli.packageName;
  if (options.cooldown !== null) {
    spec = `${cli.packageName}@${resolveAgedVersion(cli.packageName, options.cooldown)}`;
    consola.info(`Installing ${cli.name} (${spec}, cooled down >=${options.cooldown}d) ...`);
  } else {
    consola.info(`Installing ${cli.name} ...`);
  }
  runNpm(["install", "-g", spec]);
  refreshWindowsPath();
  if (!commandExists(cli.command)) {
    throw new Error(
      `${cli.name} was installed but '${cli.command}' is still unavailable. Open a new shell and rerun 'agent setup-clis'.`,
    );
  }
}

/**
 * After installing the agent CLIs, auto-detect each agent's backend and write its
 * config (Direct when a live probe succeeds, else the proxy), then point the
 * user at `agent init` to review / change it. Best-effort per agent.
 */
function autoConfigureAgents(): void {
  consola.info(
    "Auto-detecting Codex/Claude backend (GitHub Copilot Direct vs. the local proxy) ...",
  );
  const { codex, claude } = configureBothAgents({});
  const describeMode = (mode: string): string =>
    mode === "direct" ? "GitHub Copilot Direct" : mode === "proxy" ? "the proxy" : mode;
  consola.info(`Codex  → ${describeMode(codex)}`);
  consola.info(`Claude → ${describeMode(claude)}`);
  consola.info("Run `agent init` any time to re-detect, or `agent init --direct` / `--proxy`.");
}

export function runSetupClis(args: SetupClisArgs): void {
  const options = normalizeSetupClisOptions(args);
  if (options.noPrereqs) {
    warnMissing(process.platform === "win32" ? "npm.cmd" : "node", "Node.js");
    warnMissing(process.platform === "win32" ? "npm.cmd" : "npm", "npm");
    for (const cli of AGENT_CLIS) warnMissing(cli.command, cli.name);
    if (options.launchers) runSetupLaunchers({ "all-hosts": args["all-hosts"] });
    return;
  }

  if (!ensureNpm(options)) {
    for (const cli of AGENT_CLIS) warnMissing(cli.command, cli.name);
    if (options.launchers) runSetupLaunchers({ "all-hosts": args["all-hosts"] });
    return;
  }

  syncNpmGlobalBinToPath();
  for (const cli of AGENT_CLIS) installCli(cli, options);
  syncNpmGlobalBinToPath();
  autoConfigureAgents();
  if (options.launchers) runSetupLaunchers({ "all-hosts": args["all-hosts"] });
}

export function runSetupShell(args: SetupShellArgs): void {
  runShellIntegration(args);
}

export function runSetupLaunchers(args: SetupLaunchersArgs): void {
  if (args.remove) {
    runShellIntegration({ "all-hosts": args["all-hosts"], removeLaunchers: true });
    return;
  }
  runShellIntegration({ "all-hosts": args["all-hosts"], launchers: true });
}
