// The agent CLIs copilot-env installs (`agent shell --clis`) and probes (`agent health`), and
// the npm/nvm/winget installer behind the install: Node.js and npm first, then each CLI to a
// cooled-down or latest version, keeping a newer or non-npm install as it is.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { dirname } from "node:path";
import { consola } from "consola";
import { assertNever } from "../utils/assert.ts";
import { childEnvWithPath, commandExists, findCommand, resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { dryRunActive } from "../utils/fs_facade.ts";
import { pickAgedVersion, versionLessThan } from "../utils/semver.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";

/** Command name, display name, and npm package of each CLI. */
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

const NVM_VERSION = "v0.40.1";

// Windows npm is only spawnable as `npm.cmd` (the bare name is not an executable), and the Node.js
// probe keys off it there too: the winget LTS package ships node and npm together, and npm is what
// the install invokes.
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const NODE_PROBE_COMMAND = process.platform === "win32" ? NPM_COMMAND : "node";

/** A union so the representation cannot carry the --no-sudo/--no-prereqs conflict the parser
 *  rejects. */
export type CliSetup = { mode: "verify-only" } | CliInstall;

type CliInstall = {
  mode: "install";
  /** Days of npm release aging; null = latest. */
  cooldown: number | null;
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
    // A failed look must not hand out "install it yourself" advice: the probe never completed.
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

/** Pure (no spawning) so a test can assert the `default` alias never regresses to a remote
 *  meta-alias like `lts/*`, which would leave it unresolvable offline and break the nvm fallback
 *  every CLI install depends on. */
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
    // The concrete version, NOT the `lts/*` meta-alias: that one needs `nvm ls-remote` data and
    // resolves to N/A offline, and a broken default means sourcing nvm.sh activates no version, so
    // the resolveCommand nvm fallback (and thus the CLI install) silently fails.
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

/** A FAILED winget look reads absent here and only aborts (nothing installs off it); ensureNpm's
 *  npm look just completed through the same probe shell. A dry run refuses here too. */
function assertWingetAvailable(): void {
  if (commandExists("winget")) return;
  throw new Error(
    "Cannot install Node.js because winget is unavailable. Install Node.js LTS and rerun 'agent shell --clis'.",
  );
}

function installNodeWindows(): void {
  assertWingetAvailable();
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

/** `planned`: a dry run, which would install Node.js and npm here and stops at saying so. */
function ensureNpm(options: CliInstall): "present" | "absent" | "planned" {
  const npmLook = findCommand(NPM_COMMAND);
  if (npmLook.path !== null) return "present";
  if (npmLook.launchFailed) {
    // Never install off a failed look: npm may well be there already.
    consola.warn(
      "Could not check for npm (the command probe failed to run); skipping the CLI install.",
    );
    return "absent";
  }

  if (process.platform === "win32" && options.noSudo) {
    consola.warn(
      "Node.js/npm are not installed; --no-sudo will not use winget. Install Node.js yourself, then rerun 'agent shell --clis'.",
    );
    return "absent";
  }

  if (dryRunActive()) {
    if (process.platform === "win32") assertWingetAvailable();
    consola.info(
      `Would install Node.js and npm (${
        process.platform === "win32" ? "winget" : "the Node.js installer"
      }), then install or update the agent CLIs through npm: ${AGENT_CLIS_LINE}.`,
    );
    return "planned";
  }
  if (process.platform === "win32") installNodeWindows();
  else installNodePosix();
  return commandExists(NPM_COMMAND) ? "present" : "absent";
}

const AGENT_CLIS_LINE = AGENT_CLIS.map((cli) => cli.name).join(", ");

function resolveNpm(): string {
  // Every caller runs moments after ensureNpm proved npm through a completed look, and the miss
  // only THROWS (nothing installs off it).
  const resolved = resolveCommand(NPM_COMMAND);
  if (!resolved) throw new Error("npm is required to install agent CLIs.");
  return resolved;
}

function spawnNpm(args: string[], capture: boolean): SpawnSyncReturns<string> {
  const npm = resolveNpm();
  // npm is a `#!/usr/bin/env node` shim, so found via the nvm fallback right after Node was
  // installed it runs on a parent PATH without node's bin dir.
  //   the shim then fails  -> "/usr/bin/env: 'node': No such file or directory"
  //   npm's own dir        -> IS node's bin dir, so prepending it is the fix
  //   Windows              -> a bare name, nothing to prepend: npm is already on PATH
  const npmDir = npm.includes("/") || npm.includes("\\") ? dirname(npm) : null;
  return spawnSync(npm, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: childEnvWithPath([npmDir]),
  });
}

function runNpm(args: string[], capture = false): string {
  const result = spawnNpm(args, capture);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
  return capture ? result.stdout.trim() : "";
}

/** Null when the look FAILED; a package listed without a version (unreadable package.json) maps to
 *  null; an empty tree has no `dependencies` key at all. The exit status is not consulted on
 *  purpose: `npm ls` exits non-zero for an unrelated extraneous or invalid global while still
 *  printing the full tree. */
function npmGlobalVersions(): Record<string, string | null> | null {
  const result = spawnNpm(["ls", "-g", "--depth=0", "--json"], true);
  if (result.error) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const dependencies = (parsed as { dependencies?: unknown }).dependencies;
  if (dependencies === undefined) return "error" in parsed ? null : {};
  if (dependencies === null || typeof dependencies !== "object") return null;
  const versions: Record<string, string | null> = {};
  for (const [name, entry] of Object.entries(dependencies as Record<string, unknown>)) {
    const version = (entry as { version?: unknown } | null)?.version;
    versions[name] = typeof version === "string" ? version : null;
  }
  return versions;
}

/** Platform-parameterized so it is testable on POSIX CI. On win32 the prefix IS the bin dir, and
 *  both `Path` and `PATH` are assigned because Windows is case-insensitive about the name and the
 *  two must stay in lockstep. */
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
  // `npm prefix -g` throws on ANY npm failure, and escaping here would abort the CLI installs and
  // the shell-integration wiring that follows; this PATH sync is a nicety.
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

/** `--json` pins the output shape whatever the user's npmrc says; npm prints the field as a
 *  one-element array or a bare string. */
function resolveLatestVersion(packageName: string): string {
  const raw = runNpm(["view", packageName, "version", "--json"], true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`could not parse the latest version of ${packageName}`);
  }
  const version = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (typeof version !== "string") {
    throw new Error(`the latest version of ${packageName} was not a version string`);
  }
  return version;
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

/** A newer install is kept: a cooled-down target must never downgrade a fresher release. */
export type CliPlan =
  | { action: "install" }
  | { action: "update"; from: string }
  | { action: "keep"; from: string; reason: "current" | "newer" };

export function planCliVersion(installed: string | null, target: string): CliPlan {
  if (installed === null) return { action: "install" };
  if (versionLessThan(installed, target)) return { action: "update", from: installed };
  return {
    action: "keep",
    from: installed,
    reason: versionLessThan(target, installed) ? "newer" : "current",
  };
}

function installCli(
  cli: (typeof AGENT_CLIS)[number],
  options: CliInstall,
  npmGlobals: Record<string, string | null>,
): void {
  const look = findCommand(cli.command);
  if (look.launchFailed) {
    // Never install off a failed look: the CLI may well be there already.
    consola.warn(
      `Could not check whether ${cli.name} is installed (the command probe failed to run); skipping its install.`,
    );
    return;
  }
  if (look.path !== null && !(cli.packageName in npmGlobals)) {
    // Only an npm-managed install is ours to move.
    consola.info(`${cli.name} is installed outside npm; leaving it as it is.`);
    return;
  }
  // npm's version bounds the install whether or not the command is on PATH (its bin dir may not
  // be).
  const installed = npmGlobals[cli.packageName];
  if (installed === null) {
    consola.warn(
      `${cli.name} is installed by npm, but its version could not be read; leaving it as it is.`,
    );
    return;
  }

  const target = options.cooldown !== null
    ? resolveAgedVersion(cli.packageName, options.cooldown)
    : resolveLatestVersion(cli.packageName);
  const spec = `${cli.packageName}@${target}`;
  const cooled = options.cooldown !== null ? `, cooled down >=${options.cooldown}d` : "";
  const plan = planCliVersion(installed ?? null, target);
  switch (plan.action) {
    case "keep":
      if (look.path === null) {
        consola.warn(
          `${cli.name} ${plan.from} is installed by npm, but '${cli.command}' is not on PATH; leaving it as it is. Open a new shell and rerun 'agent shell --clis'.`,
        );
        return;
      }
      consola.info(
        plan.reason === "current"
          ? `${cli.name} is current (${plan.from}).`
          : `${cli.name} ${plan.from} is newer than the target ${target}${cooled}; keeping it.`,
      );
      return;
    case "install":
      consola.info(`Installing ${cli.name} (${spec}${cooled}) ...`);
      break;
    case "update":
      consola.info(`Updating ${cli.name} ${plan.from} -> ${target}${cooled} ...`);
      break;
    default:
      assertNever(plan);
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

/** Best-effort for the agent CLIs: a missing one, or a probe that could not run, warns rather than
 *  throwing, so the surrounding `agent shell` run still wires the integration. A Node/npm install
 *  that is attempted and fails throws out of here instead, and the wiring never runs.
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
      // The npm decision is the real one in a dry run too (a look, and the --no-sudo refusal);
      // only the installs are named, not run. npm's own listing is skipped as well: `npm ls -g`
      // writes npm's cache under the home.
      const npm = ensureNpm(setup);
      if (npm === "planned") return;
      if (npm === "absent") {
        for (const cli of AGENT_CLIS) warnMissing(cli.command, cli.name);
        return;
      }
      if (dryRunActive()) {
        consola.info(`Would install or update the agent CLIs through npm: ${AGENT_CLIS_LINE}.`);
        return;
      }

      syncNpmGlobalBinToPath();
      const npmGlobals = npmGlobalVersions();
      if (npmGlobals === null) {
        // Without npm's view of what is installed, an install could overwrite a newer package whose
        // bin dir is merely off PATH.
        consola.warn(
          "Could not read npm's global package list (npm ls -g failed); skipping the CLI installs.",
        );
        return;
      }
      // One package failing must not skip the remaining CLIs or the shell-integration wiring that
      // follows.
      for (const cli of AGENT_CLIS) {
        try {
          installCli(cli, setup, npmGlobals);
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
