// install.sh / install.ps1 smoke, one sub-step per workflow step (installer-sh.yml,
// installer-ps1.yml). The workflow compiles the host binary and points
// COPILOT_ENV_DOWNLOAD_BASE at dist/, so the installer's real fetch/verify/handoff path runs
// on every PR instead of only once a release exists.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherFunctionLines } from "../../src/commands/env.ts";
import { resolveRootHome } from "../../src/copilot_api/paths.ts";
import { readDvmrcPin, SIDECAR_DENO_ENV, sidecarBinPath } from "../../src/copilot_api/sidecar.ts";
import { daemonConfigFile } from "../../src/proxy_float.ts";
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

function run(command: string, args: string[], extraEnv: Record<string, string> = {}): void {
  const proc = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  if (proc.error) {
    throw proc.error;
  }
  if (proc.status !== 0) {
    process.exit(proc.status ?? 1);
  }
}

/** Run the INSTALLED launcher shim with `args` (through pwsh for the .ps1 on Windows). */
function runLauncher(
  launcher: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): void {
  if (isWindows) {
    run("pwsh", ["-NoProfile", "-File", launcher, ...args], extraEnv);
  } else {
    run(launcher, args, extraEnv);
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

/** Captured stdout of the installed launcher (through pwsh for the .ps1 on Windows),
 *  or null when it exits nonzero. */
function launcherOutput(launcher: string, args: string[]): string | null {
  return isWindows
    ? output("pwsh", ["-NoProfile", "-File", launcher, ...args])
    : output(launcher, args);
}

function verifyLauncherWiring(launcher: string): void {
  if (!envBool("SETUP_LAUNCHERS")) {
    return;
  }
  // The launchers are `agent env` emissions gated on the `launchers` key, not an rc block,
  // so both halves of that contract are asserted.
  const stored = launcherOutput(launcher, ["config", "--get", "launchers"]);
  if (stored !== "true") {
    console.error(
      `::error::expected the launchers config key to read true after agent config --set launchers true (got ${
        stored ?? "a failing read"
      })`,
    );
    process.exit(1);
  }
  const envArgs = isWindows ? ["env", "--format", "powershell"] : ["env"];
  const emitted = launcherOutput(launcher, envArgs);
  // The same source constant test/env.test.ts pins verbatim, so the smoke can
  // never assert a spelling the emitter no longer produces.
  const expected = launcherFunctionLines(isWindows);
  const missing = expected.filter((line) => emitted === null || !emitted.includes(line));
  if (missing.length > 0) {
    console.error(
      `::error::agent env does not emit the launcher functions with the key on (missing: ${
        missing.join(" | ")
      })`,
    );
    process.exit(1);
  }
  console.log("launcher opt-in verified: config key on, agent env emits the launcher functions");
}

/** Everything after run-install addresses the INSTALLED tree, never the checkout. */
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
  runLauncher(launcher, ["--version"]);
  console.log(`installed launcher works: ${launcher}`);
  return launcher;
}

/**
 * FAIL-CLOSED: every expectation is positive, so a renamed id or reshaped value fails rather
 * than passing silently. Exported for the unit tests' negative controls.
 *
 *   the report's exit code -> environment-dependent (a fresh install fails the proxy runtime
 *                             probes), so never asserted
 *   the rows below         -> only what a compiled binary must get right about ITSELF
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
    // CI runners have setup-deno's deno on PATH, so "path" is a legitimate
    // compiled-install answer; "dev" is the one kind a compiled binary can
    // never truthfully be.
    if (kind !== "path" && kind !== "provisioned" && kind !== "absent") {
      failures.push(
        `proxy.sidecar kind must be path|provisioned|absent on a compiled binary (got ${
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

/**
 * A compiled binary is not a deno CLI, so a daemon spawn that resolves no deno starts nothing.
 * Offline.
 *
 *   provisioned copy planted       -> passes on a runner image with no PATH deno; the
 *                                     PATH-vs-provisioned precedence is test/sidecar.test.ts's
 *   nothing under the daemon home  -> generating the daemon config is part of the proof
 */
function verifySidecarDaemonSpawn(launcher: string): void {
  // A live override would let the start succeed without the resolution under test. The bogus
  // value planted first is the scrub's negative control: dropping the scrub turns this red.
  process.env[SIDECAR_DENO_ENV] = isWindows ? "C:\\bogus\\deno.exe" : "/bogus/deno";
  delete process.env[SIDECAR_DENO_ENV];
  const rootHome = resolveRootHome();
  const sidecar = sidecarBinPath(rootHome, readDvmrcPin());
  mkdirSync(dirname(sidecar), { recursive: true });
  copyFileSync(process.execPath, sidecar);
  if (!isWindows) {
    chmodSync(sidecar, 0o755);
  }
  // The compiled binary must generate the daemon config itself; anything pre-existing
  // here would stub exactly the step under test and hollow out this smoke's proof.
  const daemonConfig = daemonConfigFile(rootHome);
  if (existsSync(daemonConfig)) {
    console.error(
      `::error::daemon config pre-exists at ${daemonConfig}; nothing may write it before the compiled start`,
    );
    process.exit(1);
  }
  const entryEnv = {
    COPILOT_API_ENTRY: fileURLToPath(new URL("../../test/copilot-api-fake.mjs", import.meta.url)),
  };
  runLauncher(launcher, ["start"], entryEnv);
  runLauncher(launcher, ["stop"], entryEnv);
  let generated: unknown;
  try {
    generated = JSON.parse(readFileSync(daemonConfig, "utf8"));
  } catch (e) {
    console.error(
      `::error::the compiled start left no readable daemon config at ${daemonConfig}: ${String(e)}`,
    );
    process.exit(1);
  }
  if (!isRecord(generated) || !isRecord(generated.imports)) {
    console.error(`::error::the generated daemon config at ${daemonConfig} carries no import map`);
    process.exit(1);
  }
  console.log(`compiled daemon spawn resolved a usable deno (planted sidecar at ${sidecar})`);
  console.log(`compiled start generated the daemon config at ${daemonConfig}`);
}

/** Held to the reader's FULL contract (readInstallManifest in src/utils/root.ts), so a writer
 *  regression fails here. Layout first: a missing link and a missing manifest must read as
 *  different failures in CI. */
function verifyInstallManifest(): void {
  const home = (isWindows ? process.env.USERPROFILE : process.env.HOME) ?? "";
  const root = installRoot(installerArgs(), home);
  if (!existsSync(join(root, "versions"))) {
    console.error(`::error::versioned layout missing: no versions/ dir under ${root}`);
    process.exit(1);
  }
  if (!existsSync(join(root, "current"))) {
    console.error(`::error::versioned layout missing: no current link under ${root}`);
    process.exit(1);
  }
  const manifest = join(root, "current", ".copilot-env-install.json");
  if (!existsSync(manifest)) {
    console.error(`::error::install manifest missing at ${manifest}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (e) {
    console.error(`::error::install manifest at ${manifest} is not valid JSON: ${String(e)}`);
    process.exit(1);
  }
  if (!isRecord(parsed) || parsed.kind !== "installed") {
    console.error(`::error::install manifest at ${manifest} must carry kind == "installed"`);
    process.exit(1);
  }
  if (typeof parsed.version !== "string") {
    console.error(`::error::install manifest at ${manifest} must carry a string version`);
    process.exit(1);
  }
  const assets = parsed.assets;
  if (!Array.isArray(assets) || !assets.every((entry) => typeof entry === "string")) {
    console.error(
      `::error::install manifest at ${manifest} must carry a string-array assets inventory`,
    );
    process.exit(1);
  }
  console.log(`install manifest ok: ${manifest}`);
}

function verifyOutcome(): void {
  const launcher = verifyInstalledLauncher();
  verifyInstallManifest();
  verifyCompiledHealth(launcher);
  verifySidecarDaemonSpawn(launcher);
  verifyOptionalClis();
  verifyShellWiring();
  verifyLauncherWiring(launcher);
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
