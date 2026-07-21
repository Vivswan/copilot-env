// install.sh / install.ps1 smoke driver, one sub-step per CI workflow step:
// run-install (optionally in download mode from a temp copy), the
// no-optional-CLIs assertion, and the final outcome verification (CLIs, shell
// wiring, launcher wiring).
// Run by installer-sh.yml / installer-ps1.yml:
//   bun .github/scripts/installer-smoke.ts run-install|assert-no-optional-clis|verify-outcome
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const step = process.argv[2];
const isWindows = process.platform === "win32";
const optionalClis = ["claude", "copilot", "codex"];
const posixNvmSource =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${NVM_DIR:-...} is a SHELL expansion inside the sh -c snippet, not a JS template.
  '[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true';
const releaseApi = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY ?? "Vivswan/copilot-env"}/releases/latest`;
const legacyDownloadSkipMarker = join(
  process.env.RUNNER_TEMP ?? tmpdir(),
  "copilot-env-installer-smoke-legacy-download.skip",
);

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

function hasInstallDirArg(args: string[]): boolean {
  return isWindows
    ? args.some((arg) => arg.toLowerCase() === "-installdir")
    : args.some((arg) => arg === "--dir" || arg.startsWith("--dir="));
}

function tagMajor(tag: string): number | null {
  const match = /^v?(\d+)\.\d+\.\d+$/.exec(tag.trim());
  const major = match?.[1];
  return major !== undefined ? Number.parseInt(major, 10) : null;
}

async function latestReleaseTag(): Promise<string | null> {
  const ref = process.env.COPILOT_ENV_INSTALL_REF;
  if (ref && ref !== "latest") {
    return ref;
  }
  try {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = { "User-Agent": "copilot-env" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(releaseApi, { headers });
    if (!response.ok) {
      console.warn(
        `::warning::could not check latest release for download smoke (HTTP ${response.status})`,
      );
      return null;
    }
    const release = (await response.json()) as { tag_name?: unknown };
    return typeof release.tag_name === "string" ? release.tag_name : null;
  } catch (error) {
    console.warn(
      `::warning::could not check latest release for download smoke: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function shouldSkipLegacyDownloadSmoke(): Promise<boolean> {
  if (!envBool("DOWNLOAD_INSTALL")) {
    return false;
  }
  const tag = await latestReleaseTag();
  const major = tag ? tagMajor(tag) : null;
  if (tag === null || major === null) {
    console.log(
      "Skipping download-mode installer smoke because the latest release could not be confirmed as v3.0.0 or newer.",
    );
    writeFileSync(legacyDownloadSkipMarker, `${tag ?? "unknown"}\n`);
    return true;
  }
  if (major < 3) {
    console.log(
      `Skipping download-mode installer smoke for ${tag}; supported bundled TS installer release starts in v3.0.0.`,
    );
    writeFileSync(legacyDownloadSkipMarker, `${tag}\n`);
    return true;
  }
  return false;
}

function legacyDownloadSmokeSkipped(): boolean {
  return existsSync(legacyDownloadSkipMarker);
}

interface InstallerTarget {
  script: string;
  args: string[];
}

function installerTarget(args: string[]): InstallerTarget {
  const scriptName = isWindows ? "install.ps1" : "install.sh";
  if (!envBool("DOWNLOAD_INSTALL")) {
    return { script: isWindows ? `./${scriptName}` : scriptName, args };
  }

  const tmp = mkdtempSync(join(tmpdir(), "copilot-env-installer-smoke-"));
  const script = join(tmp, scriptName);
  copyFileSync(resolve(scriptName), script);
  if (!isWindows) chmodSync(script, 0o755);

  const installDir = join(tmp, "copilot-env");
  const nextArgs = hasInstallDirArg(args)
    ? args
    : [...args, isWindows ? "-InstallDir" : "--dir", installDir];
  console.log(`download-mode installer smoke using ${script} -> ${installDir}`);
  return { script, args: nextArgs };
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

async function runInstall(): Promise<void> {
  rmSync(legacyDownloadSkipMarker, { force: true });
  if (await shouldSkipLegacyDownloadSmoke()) {
    return;
  }
  const target = installerTarget(installerArgs());
  if (isWindows) {
    run("pwsh", ["-NoProfile", "-File", target.script, ...target.args]);
  } else {
    run("bash", [target.script, ...target.args]);
  }

  if (envBool("RERUN")) {
    console.log("--- repeat install run (must still succeed) ---");
    if (isWindows) {
      run("pwsh", ["-NoProfile", "-File", target.script, ...target.args]);
    } else {
      run("bash", [target.script, ...target.args]);
    }
  }
}

function assertNoOptionalClis(): void {
  if (legacyDownloadSmokeSkipped()) {
    console.log("Skipping optional CLI assertion because legacy download-mode smoke was skipped.");
    return;
  }
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
      console.error(`::error::${cli} was not installed by agent setup-clis`);
      process.exit(1);
    }
    if (!expectClis && found) {
      console.error(`::error::${cli} must NOT have been installed without agent setup-clis`);
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
      `::error::expected NO shell wiring (${process.env.INSTALLER_ARGS ?? ""}), but a profile was wired`,
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

function verifyOutcome(): void {
  if (legacyDownloadSmokeSkipped()) {
    console.log("Skipping outcome verification because legacy download-mode smoke was skipped.");
    return;
  }
  verifyOptionalClis();
  verifyShellWiring();
  verifyLauncherWiring();
  console.log(
    `${isWindows ? "install.ps1" : "install.sh"} ${process.env.INSTALLER_ARGS ?? ""} verified on ${process.env.RUNNER_OS ?? process.platform}`,
  );
}

async function main(): Promise<void> {
  switch (step) {
    case "run-install":
      await runInstall();
      break;
    case "assert-no-optional-clis":
      assertNoOptionalClis();
      break;
    case "verify-outcome":
      verifyOutcome();
      break;
    default:
      console.error("usage: installer-smoke.ts run-install|assert-no-optional-clis|verify-outcome");
      process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
