const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const isWindows = process.platform === "win32";

function usage() {
  console.error("usage: release-installer-smoke.cjs <vX.Y.Z> <owner/repo>");
  process.exit(2);
}

async function download(url, path) {
  const headers = { "User-Agent": "copilot-env" };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`failed to download ${url} (HTTP ${res.status})`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
}

function readChecksum(path) {
  const match = readFileSync(path, "utf8").match(/\b[0-9a-f]{64}\b/i);
  if (!match) throw new Error(`${path}: missing SHA256 checksum`);
  return match[0].toLowerCase();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyChecksum(file, checksumFile) {
  const expected = readChecksum(checksumFile);
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(`${file}: SHA256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

async function downloadReleaseAssets(tag, repository, dir, scriptName) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    runCommand("gh", [
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--dir",
      dir,
      "--clobber",
      "--pattern",
      scriptName,
      "--pattern",
      `${scriptName}.sha256`,
    ]);
    return;
  }

  const installer = join(dir, scriptName);
  const checksum = join(dir, `${scriptName}.sha256`);
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  await download(`${base}/${scriptName}`, installer);
  await download(`${base}/${scriptName}.sha256`, checksum);
}

async function main(tag, repository) {
  const tmp = mkdtempSync(join(tmpdir(), "copilot-env-release-smoke-"));
  const scriptName = isWindows ? "install.ps1" : "install.sh";
  const installer = join(tmp, scriptName);
  const checksum = join(tmp, `${scriptName}.sha256`);

  await downloadReleaseAssets(tag, repository, tmp, scriptName);
  verifyChecksum(installer, checksum);

  const installDir = join(tmp, "copilot-env");
  if (isWindows) {
    runCommand("pwsh", [
      "-NoProfile",
      "-File",
      installer,
      "-InstallDir",
      installDir,
      "-NoShellIntegration",
    ]);
  } else {
    runCommand("bash", [installer, "--dir", installDir, "--no-shell-integration"]);
  }

  const agent = join(installDir, "bin", isWindows ? "agent.ps1" : "agent");
  if (!readFileSync(agent, "utf8").includes("copilot-env")) {
    throw new Error(`installed agent launcher was not found at ${agent}`);
  }
}

async function runMain() {
  const [tag, repository] = process.argv.slice(2);
  if (!tag || !repository) usage();
  await main(tag, repository);
}

try {
  runMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
