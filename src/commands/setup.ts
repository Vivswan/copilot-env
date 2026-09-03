// Setup domain logic for optional agent CLIs, launchers, and shell wiring helpers.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { consola } from "consola";
import { AGENT_CLIS } from "../agents/clis.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { runShellIntegration } from "../shell/integration.ts";
import { pickAgedVersion } from "../utils/aged_version.ts";
import { assertNever } from "../utils/assert.ts";
import { childEnvWithPath, commandExists, findCommand, resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { assertNonNegativeDays, MILLISECONDS_PER_DAY } from "../utils/time.ts";

const NVM_VERSION = "v0.40.1";

// The toolchain command names, decided ONCE per platform: Windows npm is only
// spawnable/probe-able as `npm.cmd` (the bare name is not an executable), and the
// Node.js presence probe keys off it there too -- the winget Node.js LTS package
// ships node and npm together, and npm is what the install path actually invokes.
// POSIX probes each tool by its own name.
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const NODE_PROBE_COMMAND = process.platform === "win32" ? NPM_COMMAND : "node";

/** Bare `--cooldown` (no value) means this many days of npm release aging. Distinct
 *  from the autoupdate release cooldown, which happens to share the number. */
export const DEFAULT_CLI_COOLDOWN_DAYS = 7;

/**
 * `agent shell`: wire shell integration, optionally the cl/co/cx launchers, and
 * optionally install the agent CLIs -- the merge of the old setup-shell /
 * setup-launchers commands plus the install flags.
 */
export interface ShellArgs {
  /** Unwire instead of wire. With `launchers`, disable ONLY the launchers. */
  remove?: boolean;
  /** Also enable (or, with `remove`, only disable) the opt-in cl/co/cx launchers. */
  launchers?: boolean;
  /** Also install the optional Codex/Claude/Copilot CLIs. */
  clis?: boolean;
  /** With `clis`: install npm releases aged >= N days (null = latest). */
  cooldown?: number | null;
  /** With `clis`: avoid sudo/system package managers. */
  noSudo?: boolean;
  /** With `clis`: verify prerequisites/CLIs only -- install nothing. */
  noPrereqs?: boolean;
  /** Windows only: target the CurrentUserAllHosts profile. */
  allHosts?: boolean;
}

/**
 * Parsed intent for the `agent shell --clis` path: either verify prerequisites/CLIs
 * only, or install with a cooldown and sudo policy. A union so the internal
 * representation cannot carry the --no-sudo/--no-prereqs conflict runShell rejects
 * at the flag boundary.
 */
export type CliSetup = { mode: "verify-only" } | CliInstall;

type CliInstall = {
  mode: "install";
  /** Install npm releases aged >= N days (null = latest). */
  cooldown: number | null;
  /** Avoid sudo/system package managers. */
  noSudo: boolean;
};

function run(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2] = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, { stdio: "inherit", ...options });
}

function warnMissing(command: string, name: string): void {
  const look = findCommand(command);
  if (look.path !== null) return;
  if (look.launchFailed) {
    // A failed look must not hand out "install it yourself" advice: the probe
    // shell never ran, which proves nothing about the CLI.
    consola.warn(`Could not check for ${name} ('${command}'): the command probe failed to run.`);
    return;
  }
  consola.warn(
    `${name} ('${command}') is not installed; skipping. Install it yourself to use it.`,
  );
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

/**
 * The POSIX shell script that installs Node LTS via nvm and pins the `default`
 * alias to the concrete installed version. Kept pure (no spawning) so a test can
 * assert it never regresses to a remote meta-alias like `lts/*` -- which would
 * leave `default` unresolvable offline and break the resolveCommand nvm
 * fallback that every CLI install depends on.
 */
export function buildNodePosixInstallScript(): string {
  return [
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
    // Alias `default` to the concrete version we just installed -- NOT the
    // remote `lts/*` meta-alias, which needs `nvm ls-remote` LTS data and
    // resolves to N/A when that is unavailable (offline / uncached). A broken
    // default means sourcing nvm.sh activates no version, so `node`/`npm` never
    // land on PATH and the resolveCommand nvm fallback (and thus the CLI
    // install) silently fails. `nvm current` is the active version after the
    // install above; fall back to `node` (latest installed) if it is empty.
    'NODE_DEFAULT="$(nvm current)"',
    '[ -n "$NODE_DEFAULT" ] && [ "$NODE_DEFAULT" != "none" ] || NODE_DEFAULT=node',
    'nvm alias default "$NODE_DEFAULT"',
  ].join("\n");
}

function installNodePosix(): void {
  const result = run("bash", ["-c", buildNodePosixInstallScript()]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("nvm failed to install/activate Node LTS.");
}

function installNodeWindows(): void {
  // Accepted flatten: a FAILED winget look reads absent here and only ABORTS
  // (nothing installs off it), and ensureNpm's npm look just completed through
  // the same probe shell, so the failed-look window is negligible.
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

function ensureNpm(options: CliInstall): boolean {
  const npmLook = findCommand(NPM_COMMAND);
  if (npmLook.path !== null) return true;
  if (npmLook.launchFailed) {
    // Never install off a failed look: npm may well be there already.
    consola.warn(
      "Could not check for npm (the command probe failed to run); skipping the CLI install.",
    );
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
  return commandExists(NPM_COMMAND);
}

function resolveNpm(): string {
  // Accepted flatten: every caller runs moments after ensureNpm proved npm
  // through a completed look, so a failed look here is a just-broken probe
  // shell, and the miss only THROWS (nothing installs off it) -- the same
  // direction any npm failure already takes on these call paths (runNpm throws
  // on a nonzero exit too).
  const resolved = resolveCommand(NPM_COMMAND);
  if (!resolved) throw new Error("npm is required to install agent CLIs.");
  return resolved;
}

function runNpm(args: string[], capture = false): string {
  const npm = resolveNpm();
  // npm is a `#!/usr/bin/env node` shim. When resolveNpm finds it via the nvm
  // fallback (the same process that just installed Node), the parent PATH does
  // not yet include node's bin dir, so the shim's `node` lookup fails with
  // "/usr/bin/env: 'node': No such file or directory". Prepend the resolved
  // npm's own dir (== node's bin dir) to the child PATH so the shim resolves
  // node. On Windows resolveNpm returns a bare command name (no separator), so
  // there is nothing to prepend and npm is already on PATH.
  const npmDir = npm.includes("/") || npm.includes("\\") ? dirname(npm) : null;
  const result = spawnSync(npm, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: childEnvWithPath([npmDir]),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
  return capture ? result.stdout.trim() : "";
}

/**
 * Pure computation of how npm's global bin dir folds into PATH for a given
 * platform. Platform-parameterized so it is testable on POSIX CI: on win32 the
 * prefix IS the bin dir and the separator is ';'; elsewhere the bin dir is
 * `${prefix}/bin` and the separator is ':'. Returns the bin dir, the resolved
 * separator, and -- when the bin dir is not already on PATH -- the deliberate
 * `Path`/`PATH` double-key assignments (Windows is case-insensitive about the
 * variable name, so both are written to keep them in lockstep).
 */
export function computePathRefresh(
  platform: NodeJS.Platform,
  prefix: string,
  currentPath: string,
): { bin: string; separator: string; assignments: Record<string, string> } {
  const isWin = platform === "win32";
  const bin = isWin ? prefix : `${prefix}/bin`;
  const separator = isWin ? ";" : ":";
  if (currentPath.split(separator).includes(bin)) {
    return { bin, separator, assignments: {} };
  }
  const next = `${bin}${separator}${currentPath}`;
  return { bin, separator, assignments: { Path: next, PATH: next } };
}

function syncNpmGlobalBinToPath(): void {
  // Best-effort, the same containment as installAgentClis' per-CLI loop: this PATH
  // sync is a nicety, and `npm prefix -g` throws on ANY npm failure (registry,
  // permission, disk) -- escaping here would abort the CLI installs and the
  // shell-integration wiring runShell does after installAgentClis returns.
  let prefix: string;
  try {
    prefix = runNpm(["prefix", "-g"], true);
  } catch (e) {
    consola.warn(`Could not sync npm's global bin dir to PATH (${errMessage(e)}); continuing.`);
    return;
  }
  if (!prefix) return;
  const path = process.env.PATH ?? process.env.Path ?? "";
  const { bin, assignments } = computePathRefresh(process.platform, prefix, path);
  for (const [key, value] of Object.entries(assignments)) {
    process.env[key] = value;
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

function installCli(cli: (typeof AGENT_CLIS)[number], options: CliInstall): void {
  const look = findCommand(cli.command);
  if (look.path !== null) {
    consola.info(`${cli.name} already installed.`);
    return;
  }
  if (look.launchFailed) {
    // Never install off a failed look: the CLI may well be there already.
    consola.warn(
      `Could not check whether ${cli.name} is installed (the command probe failed to run); skipping its install.`,
    );
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
  const verify = findCommand(cli.command);
  if (verify.path === null) {
    if (verify.launchFailed) {
      // The install itself succeeded; only the verifying look failed.
      consola.warn(
        `Could not verify ${cli.name} after install (the command probe failed to run).`,
      );
      return;
    }
    throw new Error(
      `${cli.name} was installed but '${cli.command}' is still unavailable. Open a new shell and rerun 'agent shell --clis'.`,
    );
  }
}

/**
 * Install (or in verify-only mode, just verify) the optional agent CLIs -- the
 * `agent shell --clis` path. Best-effort: a missing/uninstallable toolchain warns
 * rather than throwing, so the surrounding `agent shell` run still wires the
 * integration. Does NOT wire the rc blocks -- `runShell` owns that ordering.
 */
export function installAgentClis(setup: CliSetup): void {
  switch (setup.mode) {
    case "verify-only": {
      warnMissing(NODE_PROBE_COMMAND, "Node.js");
      warnMissing(NPM_COMMAND, "npm");
      for (const cli of AGENT_CLIS) warnMissing(cli.command, cli.name);
      return;
    }
    case "install": {
      if (!ensureNpm(setup)) {
        for (const cli of AGENT_CLIS) warnMissing(cli.command, cli.name);
        return;
      }

      syncNpmGlobalBinToPath();
      // Best-effort per CLI: a single package failing (npm error, unreachable registry, a
      // rejected aged-version lookup) must NOT abort the whole run -- installCli/resolveAgedVersion
      // throw, and an uncaught throw here would skip the remaining CLIs AND the shell-integration
      // wiring runShell does after this. Warn and continue so the surrounding `agent shell` finishes.
      for (const cli of AGENT_CLIS) {
        try {
          installCli(cli, setup);
        } catch (e) {
          consola.warn(`Could not install ${cli.name} (${errMessage(e)}); continuing.`);
        }
      }
      syncNpmGlobalBinToPath();
      return;
    }
    default:
      assertNever(setup);
  }
}

/**
 * What ONE `agent shell` invocation does -- an unwire (whole block or just the
 * launchers) or a wire (optionally with a CLI install) -- parsed ONCE by
 * `parseShellAction` at the CLI boundary. The install knobs live inside the
 * wire arm's CliSetup alone, so a conflicting combination (`--remove --clis`,
 * `--cooldown --no-prereqs`) is rejected here and the handlers never re-check.
 */
export type ShellAction =
  | { kind: "remove"; allHosts: boolean; launchersOnly: boolean }
  | { kind: "wire"; allHosts: boolean; launchers: boolean; clis: CliSetup | null };

/** Parse the raw `agent shell` flags into a ShellAction (the CLI boundary). */
export function parseShellAction(args: ShellArgs): ShellAction {
  const remove = Boolean(args.remove);
  const launchers = Boolean(args.launchers);
  const clis = Boolean(args.clis);
  const cooldown = args.cooldown ?? null;
  const noSudo = Boolean(args.noSudo);
  const noPrereqs = Boolean(args.noPrereqs);
  const allHosts = Boolean(args.allHosts);

  if (!clis && (cooldown !== null || noSudo || noPrereqs)) {
    throw new Error("--cooldown, --no-sudo, and --no-prereqs require --clis");
  }
  if (remove) {
    if (clis) throw new Error("--clis installs CLIs and cannot be combined with --remove");
    // --launchers scopes the removal to just the launchers; otherwise the whole
    // integration is removed (launchers included).
    return { kind: "remove", allHosts, launchersOnly: launchers };
  }
  if (!clis) return { kind: "wire", allHosts, launchers, clis: null };
  if (noSudo && noPrereqs) {
    throw new Error("--no-sudo and --no-prereqs are mutually exclusive");
  }
  // Same conflict as its sibling above: --no-prereqs installs nothing, so a cooldown
  // has nothing to steer -- reject it instead of silently dropping it.
  if (cooldown !== null && noPrereqs) {
    throw new Error("--cooldown and --no-prereqs are mutually exclusive");
  }
  assertNonNegativeDays(cooldown);
  return {
    kind: "wire",
    allHosts,
    launchers,
    clis: noPrereqs ? { mode: "verify-only" } : { mode: "install", cooldown, noSudo },
  };
}

/**
 * `agent shell`: set up the shell environment for the agents. Wires the
 * copilot-env integration block; `--launchers` also enables the cl/co/cx
 * launchers (the `launchers` config key -- `agent env` emits the functions);
 * `--clis` also installs the optional agent CLIs (tuned by --cooldown/--no-sudo/
 * --no-prereqs). `--remove` unwires the integration and disables the launchers;
 * `--remove --launchers` disables ONLY the launchers. `--all-hosts` targets the
 * Windows CurrentUserAllHosts profile.
 */
export function runShell(args: ShellArgs): void {
  const action = parseShellAction(args);
  if (action.kind === "remove") {
    // The launchers ride on the config key now; deleting it is the disable. The
    // rc strip below only clears blocks an older release wrote.
    new CopilotEnvConfig().del("launchers");
    if (action.launchersOnly) {
      consola.success("Launchers disabled (new shells will no longer define cl/co/cx).");
    }
    runShellIntegration({
      kind: "remove",
      allHosts: action.allHosts,
      launchersOnly: action.launchersOnly,
    });
    return;
  }
  // Opt-in CLI install (add path only) happens before the rc block is wired.
  if (action.clis !== null) installAgentClis(action.clis);
  if (action.launchers) {
    new CopilotEnvConfig().set({ launchers: true });
    consola.success(
      "Launchers enabled: cl / co / cx (+ clx / cox / cxx) load via `agent env`.",
    );
  }
  runShellIntegration({ kind: "wire", allHosts: action.allHosts });
}
