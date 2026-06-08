const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const step = process.argv[2];
const isWindows = process.platform === "win32";
const optionalClis = ["claude", "copilot", "codex"];
const posixNvmSource = '[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true';
const releaseApi = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY ?? "Vivswan/copilot-env"}/releases/latest`;
const legacyDownloadSkipMarker = join(
  process.env.RUNNER_TEMP ?? tmpdir(),
  "copilot-env-installer-smoke-legacy-download.skip",
);

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true";
}

function installerArgs() {
  const args = process.env.INSTALLER_ARGS ?? "";
  return args.trim() === "" ? [] : args.trim().split(/\s+/);
}

function hasInstallDirArg(args) {
  return isWindows
    ? args.some((arg) => arg.toLowerCase() === "-installdir")
    : args.some((arg) => arg === "--dir" || arg.startsWith("--dir="));
}

function tagMajor(tag) {
  const match = /^v?(\d+)\.\d+\.\d+$/.exec(tag.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

async function latestReleaseTag() {
  const ref = process.env.COPILOT_ENV_INSTALL_REF;
  if (ref && ref !== "latest") {
    return ref;
  }
  try {
    const response = await fetch(releaseApi, { headers: { "User-Agent": "copilot-env" } });
    if (!response.ok) {
      console.warn(`::warning::could not check latest release for download smoke (HTTP ${response.status})`);
      return null;
    }
    const release = await response.json();
    return typeof release.tag_name === "string" ? release.tag_name : null;
  } catch (error) {
    console.warn(
      `::warning::could not check latest release for download smoke: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function shouldSkipLegacyDownloadSmoke() {
  if (!envBool("DOWNLOAD_INSTALL")) {
    return false;
  }
  const tag = await latestReleaseTag();
  const major = tag ? tagMajor(tag) : null;
  if (tag && major !== null && major < 2) {
    console.log(`Skipping download-mode installer smoke for ${tag}; bundled TS installer starts in v2.0.0.`);
    writeFileSync(legacyDownloadSkipMarker, `${tag}\n`);
    return true;
  }
  return false;
}

function legacyDownloadSmokeSkipped() {
  return existsSync(legacyDownloadSkipMarker);
}

function installerTarget(args) {
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

function run(command, args, options = {}) {
  const proc = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (proc.error) {
    throw proc.error;
  }
  if (proc.status !== 0) {
    process.exit(proc.status ?? 1);
  }
}

function output(command, args) {
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

function commandPath(command) {
  return isWindows
    ? output("where.exe", [command])
    : output("sh", ["-c", `${posixNvmSource}; command -v "$1"`, "sh", command]);
}

function commandOutput(command, args) {
  return isWindows
    ? output(command, args)
    : output("sh", ["-c", `${posixNvmSource}; "$@"`, "sh", command, ...args]);
}

function npmGlobalBin() {
  if (!commandPath(isWindows ? "npm.cmd" : "npm")) {
    return null;
  }
  const prefix = commandOutput(isWindows ? "npm.cmd" : "npm", ["prefix", "-g"]);
  if (!prefix) {
    return null;
  }
  return isWindows ? prefix : join(prefix, "bin");
}

function cliExists(command) {
  if (commandPath(command)) {
    return true;
  }
  const bin = npmGlobalBin();
  if (!bin) {
    return false;
  }
  return existsSync(join(bin, `${command}.cmd`)) || existsSync(join(bin, command));
}

async function runInstall() {
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

function assertNoOptionalClis() {
  if (legacyDownloadSmokeSkipped()) {
    console.log("Skipping optional CLI assertion because legacy download-mode smoke was skipped.");
    return;
  }
  for (const cli of optionalClis) {
    if (cliExists(cli)) {
      console.error(`::error::${cli} must NOT be installed by installer ${process.env.INSTALLER_ARGS ?? ""}`);
      process.exit(1);
    }
    console.log(`${cli} correctly absent after installer`);
  }
}

function verifyOptionalClis() {
  const expectClis = envBool("EXPECT_CLIS");
  for (const cli of optionalClis) {
    const found = cliExists(cli);
    if (expectClis && !found) {
      console.error(`::error::${cli} was not installed by agent setup clis`);
      process.exit(1);
    }
    if (!expectClis && found) {
      console.error(`::error::${cli} must NOT have been installed without agent setup clis`);
      process.exit(1);
    }
    console.log(expectClis ? `found ${cli}` : `${cli} correctly absent`);
  }
}

function profilePaths() {
  if (isWindows) {
    const docs = join(process.env.USERPROFILE ?? "", "Documents");
    return [
      join(docs, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
      join(docs, "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    ];
  }
  return [join(process.env.HOME ?? "", ".bashrc"), join(process.env.HOME ?? "", ".zshrc")];
}

function fileContains(path, marker) {
  return existsSync(path) && readFileSync(path, "utf8").includes(marker);
}

function verifyShellWiring() {
  const marker = isWindows ? "agents.ps1" : "copilot-env shell integration";
  const wired = profilePaths().some((path) => fileContains(path, marker));
  if (envBool("EXPECT_WIRING", true) && !wired) {
    console.error("::error::expected shell wiring, but none found");
    process.exit(1);
  }
  if (!envBool("EXPECT_WIRING", true) && wired) {
    console.error(`::error::expected NO shell wiring (${process.env.INSTALLER_ARGS ?? ""}), but a profile was wired`);
    process.exit(1);
  }
}

function verifyLauncherWiring() {
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

function verifyOutcome() {
  if (legacyDownloadSmokeSkipped()) {
    console.log("Skipping outcome verification because legacy download-mode smoke was skipped.");
    return;
  }
  verifyOptionalClis();
  verifyShellWiring();
  verifyLauncherWiring();
  console.log(`${isWindows ? "install.ps1" : "install.sh"} ${process.env.INSTALLER_ARGS ?? ""} verified on ${process.env.RUNNER_OS ?? process.platform}`);
}

async function main() {
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
      console.error("usage: installer-smoke.cjs run-install|assert-no-optional-clis|verify-outcome");
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
