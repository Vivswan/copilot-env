// Setup domain logic for optional agent CLIs, launchers, and shell wiring helpers.
import { spawnSync } from "node:child_process";
import { consola } from "consola";
import { pickAgedVersion } from "../utils/aged_version.ts";
import { commandExists, resolveCommand } from "../utils/command.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { assertNonNegativeDays, MILLISECONDS_PER_DAY } from "../utils/time.ts";
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

/**
 * `agent shell`: wire shell integration, optionally the cl/co/cx launchers, and
 * optionally install the agent CLIs — the merge of the old setup-shell /
 * setup-launchers commands plus the install flags.
 */
export interface ShellArgs {
  /** Unwire instead of wire. With `launchers`, unwire ONLY the launchers block. */
  remove?: boolean;
  /** Also wire (or, with `remove`, only target) the opt-in cl/co/cx launchers. */
  launchers?: boolean;
  /** Also install the optional Codex/Claude/Copilot CLIs. */
  clis?: boolean;
  /** With `clis`: install npm releases aged >= N days (null = latest). */
  cooldown?: number | null;
  /** With `clis`: avoid sudo/system package managers. */
  noSudo?: boolean;
  /** With `clis`: verify prerequisites/CLIs only — install nothing. */
  noPrereqs?: boolean;
  /** Windows only: target the CurrentUserAllHosts profile. */
  allHosts?: boolean;
}

/** Options for installing the optional agent CLIs (the `agent shell --clis` path). */
export interface InstallClisOptions {
  cooldown: number | null;
  noSudo: boolean;
  noPrereqs: boolean;
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
      "Cannot install Node.js because winget is unavailable. Install Node.js LTS and rerun 'agent shell --clis'.",
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

function ensureNpm(options: InstallClisOptions): boolean {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  if (commandExists(npmCommand)) return true;

  if (options.noPrereqs) {
    warnMissing(process.platform === "win32" ? "npm.cmd" : "node", "Node.js");
    warnMissing(npmCommand, "npm");
    return false;
  }

  if (process.platform === "win32" && options.noSudo) {
    consola.warn(
      "Node.js/npm are not installed; --no-sudo will not use winget. Install Node.js yourself, then rerun 'agent shell --clis'.",
    );
    return false;
  }

  if (process.platform === "win32") installNodeWindows();
  else installNodePosix();
  return commandExists(npmCommand);
}

function resolveNpm(): string {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const resolved = resolveCommand(npmCommand);
  if (!resolved) throw new Error("npm is required to install agent CLIs.");
  return resolved;
}

function runNpm(args: string[], capture = false): string {
  const result = spawnSync(resolveNpm(), args, {
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

function installCli(cli: (typeof AGENT_CLIS)[number], options: InstallClisOptions): void {
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
      `${cli.name} was installed but '${cli.command}' is still unavailable. Open a new shell and rerun 'agent shell --clis'.`,
    );
  }
}

/**
 * Install (or with `noPrereqs`, just verify) the optional agent CLIs — the
 * `agent shell --clis` path. Best-effort: a missing/uninstallable toolchain warns
 * rather than throwing, so the surrounding `agent shell` run still wires the
 * integration. Does NOT wire the rc blocks — `runShell` owns that ordering.
 */
export function installAgentClis(options: InstallClisOptions): void {
  if (options.noPrereqs) {
    warnMissing(process.platform === "win32" ? "npm.cmd" : "node", "Node.js");
    warnMissing(process.platform === "win32" ? "npm.cmd" : "npm", "npm");
    for (const cli of AGENT_CLIS) warnMissing(cli.command, cli.name);
    return;
  }

  if (!ensureNpm(options)) {
    for (const cli of AGENT_CLIS) warnMissing(cli.command, cli.name);
    return;
  }

  syncNpmGlobalBinToPath();
  for (const cli of AGENT_CLIS) installCli(cli, options);
  syncNpmGlobalBinToPath();
}

/**
 * `agent shell`: set up the shell environment for the agents. Wires the
 * copilot-env integration block; `--launchers` also wires the cl/co/cx launchers;
 * `--clis` also installs the optional agent CLIs (tuned by --cooldown/--no-sudo/
 * --no-prereqs). `--remove` unwires the integration (and launchers); `--remove
 * --launchers` unwires ONLY the launchers block. `--all-hosts` targets the
 * Windows CurrentUserAllHosts profile.
 */
export function runShell(args: ShellArgs): void {
  const remove = Boolean(args.remove);
  const launchers = Boolean(args.launchers);
  const clis = Boolean(args.clis);
  const cooldown = args.cooldown ?? null;
  const noSudo = Boolean(args.noSudo);
  const noPrereqs = Boolean(args.noPrereqs);
  const allHosts = Boolean(args.allHosts);

  // Validate the install flags before touching anything.
  if (!clis && (cooldown !== null || noSudo || noPrereqs)) {
    throw new Error("--cooldown, --no-sudo, and --no-prereqs require --clis");
  }
  if (clis) {
    if (remove) throw new Error("--clis installs CLIs and cannot be combined with --remove");
    if (noSudo && noPrereqs) {
      throw new Error("--no-sudo and --no-prereqs are mutually exclusive");
    }
    assertNonNegativeDays(cooldown);
  }

  // Opt-in CLI install (add path only).
  if (clis) installAgentClis({ cooldown, noSudo, noPrereqs });

  // Wire / unwire the rc block(s).
  if (remove) {
    // --launchers scopes the removal to just the launchers block; otherwise the
    // whole integration block (which also strips launchers) is removed.
    runShellIntegration(
      launchers ? { allHosts, removeLaunchers: true } : { allHosts, remove: true },
    );
    return;
  }
  runShellIntegration({ allHosts, launchers });
}
