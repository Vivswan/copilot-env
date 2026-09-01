// install.sh / install.ps1 smoke driver, one sub-step per CI workflow step:
// run-install, the no-optional-CLIs assertion, and the final outcome
// verification (installed launcher, CLIs, shell wiring, launcher wiring).
//
// The installer under test fetches a compiled binary rather than a source
// archive, so the workflow compiles the host target from the tree first and
// points COPILOT_ENV_DOWNLOAD_BASE at dist/. That is what makes this smoke
// meaningful on every PR instead of only once a release exists to download.
//
// Run by installer-sh.yml / installer-ps1.yml:
//   deno run -P=cli .github/scripts/installer-smoke.ts run-install|assert-no-optional-clis|verify-outcome
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/utils/json.ts";

const step = process.argv[2];
const isWindows = process.platform === "win32";
const optionalClis = ["claude", "copilot", "codex"];
const posixNvmSource =
  '[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true';

function envBool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true";
}

function installerArgs(): string[] {
  const args = process.env.INSTALLER_ARGS ?? "";
  return args.trim() === "" ? [] : args.trim().split(/\s+/);
}

function run(command: string, args: string[]): void {
  const proc = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (proc.error) {
    throw proc.error;
  }
  if (proc.status !== 0) {
    process.exit(proc.status ?? 1);
  }
}

function output(command: string, args: string[]): string | null {
  const proc = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  if (proc.status !== 0) {
    return null;
  }
  return proc.stdout.trim();
}

/** stdout of a command whose exit code is NOT the signal: `health` exits 1 on
 *  any environment-dependent failure, but its JSON body is what we assert on. */
function outputAnyExit(command: string, args: string[]): string {
  const proc = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
  });
  if (proc.error) {
    throw proc.error;
  }
  return (proc.stdout ?? "").trim();
}

function commandPath(command: string): string | null {
  return isWindows
    ? output("where.exe", [command])
    : output("sh", ["-c", `${posixNvmSource}; command -v "$1"`, "sh", command]);
}

function commandOutput(command: string, args: string[]): string | null {
  return isWindows
    ? output(command, args)
    : output("sh", ["-c", `${posixNvmSource}; "$@"`, "sh", command, ...args]);
}

function npmGlobalBin(): string | null {
  if (!commandPath(isWindows ? "npm.cmd" : "npm")) {
    return null;
  }
  const prefix = commandOutput(isWindows ? "npm.cmd" : "npm", ["prefix", "-g"]);
  if (!prefix) {
    return null;
  }
  return isWindows ? prefix : join(prefix, "bin");
}

function cliExists(command: string): boolean {
  if (commandPath(command)) {
    return true;
  }
  const bin = npmGlobalBin();
  if (!bin) {
    return false;
  }
  return existsSync(join(bin, `${command}.cmd`)) || existsSync(join(bin, command));
}

function runInstaller(args: string[]): void {
  if (isWindows) {
    run("pwsh", ["-NoProfile", "-File", "./install.ps1", ...args]);
  } else {
    run("bash", ["install.sh", ...args]);
  }
}

function runInstall(): void {
  const args = installerArgs();
  runInstaller(args);

  if (envBool("RERUN")) {
    console.log("--- repeat install run (must still succeed) ---");
    runInstaller(args);
  }
}

function assertNoOptionalClis(): void {
  for (const cli of optionalClis) {
    if (cliExists(cli)) {
      console.error(
        `::error::${cli} must NOT be installed by installer ${process.env.INSTALLER_ARGS ?? ""}`,
      );
      process.exit(1);
    }
    console.log(`${cli} correctly absent after installer`);
  }
}

function verifyOptionalClis(): void {
  const expectClis = envBool("EXPECT_CLIS");
  for (const cli of optionalClis) {
    const found = cliExists(cli);
    if (expectClis && !found) {
      console.error(`::error::${cli} was not installed by agent shell --clis`);
      process.exit(1);
    }
    if (!expectClis && found) {
      console.error(`::error::${cli} must NOT have been installed without agent shell --clis`);
      process.exit(1);
    }
    console.log(expectClis ? `found ${cli}` : `${cli} correctly absent`);
  }
}

function profilePaths(): string[] {
  if (isWindows) {
    const docs = join(process.env.USERPROFILE ?? "", "Documents");
    return [
      join(docs, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
      join(docs, "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    ];
  }
  return [join(process.env.HOME ?? "", ".bashrc"), join(process.env.HOME ?? "", ".zshrc")];
}

function fileContains(path: string, marker: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(marker);
}

function verifyShellWiring(): void {
  const marker = isWindows ? "agents.ps1" : "copilot-env shell integration";
  const wired = profilePaths().some((path) => fileContains(path, marker));
  if (envBool("EXPECT_WIRING", true) && !wired) {
    console.error("::error::expected shell wiring, but none found");
    process.exit(1);
  }
  if (!envBool("EXPECT_WIRING", true) && wired) {
    console.error(
      `::error::expected NO shell wiring (${
        process.env.INSTALLER_ARGS ?? ""
      }), but a profile was wired`,
    );
    process.exit(1);
  }
}

function verifyLauncherWiring(): void {
  if (!envBool("SETUP_LAUNCHERS")) {
    return;
  }
  const marker = isWindows ? "agents.launchers.ps1" : "copilot-env launchers";
  const wired = profilePaths().some((path) => fileContains(path, marker));
  if (!wired) {
    console.error("::error::expected launcher wiring, but none found");
    process.exit(1);
  }
}

/** The root the installer installed into: its default unless the scenario
 *  passed an explicit target. Everything after run-install addresses the
 *  INSTALLED tree, never the checkout it was built from. */
function installRoot(args: string[], home: string): string {
  const flag = isWindows ? "-installdir" : "--dir";
  const index = args.findIndex((arg) => arg.toLowerCase() === flag);
  const paired = index >= 0 ? args[index + 1] : undefined;
  const inline = args.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length);
  return paired ?? inline ?? join(home, ".copilot-env");
}

/** The installed launcher shim -- what a user actually runs after install. */
function verifyInstalledLauncher(): string {
  const home = (isWindows ? process.env.USERPROFILE : process.env.HOME) ?? "";
  const launcher = join(
    installRoot(installerArgs(), home),
    "bin",
    isWindows ? "agent.ps1" : "agent",
  );
  if (!existsSync(launcher)) {
    console.error(`::error::installed launcher missing at ${launcher}`);
    process.exit(1);
  }
  if (isWindows) {
    run("pwsh", ["-NoProfile", "-File", launcher, "--version"]);
  } else {
    run(launcher, ["--version"]);
  }
  console.log(`installed launcher works: ${launcher}`);
  return launcher;
}

/**
 * Compiled-install health invariants, FAIL-CLOSED: the report is parsed from
 * unknown and every expectation is POSITIVE, so a missing row, a renamed id, a
 * reshaped value, or an unexpected status/kind is a failure -- never a silent
 * pass. The whole-report exit code is environment-dependent (a fresh install
 * legitimately fails the proxy runtime probes), so this asserts only the checks
 * a compiled binary must get right about ITSELF: dependencies read as embedded,
 * the proxy package reads ok (never "not installed"), and the sidecar is
 * provisioned or absent -- never the "dev" deno a compiled binary cannot be.
 * Exported for the unit tests' negative controls; the CI entry point below
 * feeds it the real binary's report.
 */
export function compiledHealthFailures(reportJson: unknown): string[] {
  const checks = isRecord(reportJson) && Array.isArray(reportJson.checks)
    ? reportJson.checks
    : null;
  if (checks === null) {
    return ["health --json did not produce a checks array"];
  }
  const failures: string[] = [];
  const row = (id: string): { status: unknown; value: unknown } | undefined => {
    const found = checks.find((c): c is Record<string, unknown> => isRecord(c) && c.id === id);
    if (found === undefined) {
      failures.push(`health --json has no ${id} check (renamed or removed?)`);
      return undefined;
    }
    return { status: found.status, value: found.value };
  };
  const nodeModules = row("bootstrap.nodeModules");
  if (
    nodeModules !== undefined &&
    (!isRecord(nodeModules.value) || nodeModules.value.embedded !== true)
  ) {
    failures.push("bootstrap.nodeModules must read as embedded on a compiled install");
  }
  const pkg = row("proxy.package");
  if (pkg !== undefined && pkg.status !== "ok") {
    failures.push(
      `proxy.package must be ok on a fresh compiled install (got ${JSON.stringify(pkg.status)})`,
    );
  }
  const sidecar = row("proxy.sidecar");
  if (sidecar !== undefined) {
    const kind = isRecord(sidecar.value) ? sidecar.value.kind : undefined;
    if (kind !== "provisioned" && kind !== "absent") {
      failures.push(
        `proxy.sidecar kind must be provisioned|absent on a compiled binary (got ${
          JSON.stringify(kind)
        })`,
      );
    }
  }
  return failures;
}

function verifyCompiledHealth(launcher: string): void {
  const healthArgs = ["health", "--json", "--scope", "proxy"];
  const raw = isWindows
    ? outputAnyExit("pwsh", ["-NoProfile", "-File", launcher, ...healthArgs])
    : outputAnyExit(launcher, healthArgs);
  const failures = compiledHealthFailures(JSON.parse(raw));
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
  console.log("compiled-install health invariants hold");
}

function verifyOutcome(): void {
  const launcher = verifyInstalledLauncher();
  verifyCompiledHealth(launcher);
  verifyOptionalClis();
  verifyShellWiring();
  verifyLauncherWiring();
  console.log(
    `${isWindows ? "install.ps1" : "install.sh"} ${process.env.INSTALLER_ARGS ?? ""} verified on ${
      process.env.RUNNER_OS ?? process.platform
    }`,
  );
}

// Guarded so the unit tests can import compiledHealthFailures without running a step.
if (import.meta.main) {
  switch (step) {
    case "run-install":
      runInstall();
      break;
    case "assert-no-optional-clis":
      assertNoOptionalClis();
      break;
    case "verify-outcome":
      verifyOutcome();
      break;
    default:
      console.error(
        "usage: installer-smoke.ts run-install|assert-no-optional-clis|verify-outcome",
      );
      process.exit(2);
  }
}
