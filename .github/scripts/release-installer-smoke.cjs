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

function authHeaders(extra = {}) {
  const headers = { "User-Agent": "copilot-env" };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return { ...headers, ...extra };
}

async function download(url, path, headers = authHeaders()) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`failed to download ${url} (HTTP ${res.status})`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeDigest(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^sha256:([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function verifyDigest(file, expected) {
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(`${file}: SHA256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: authHeaders({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchRelease(tag, repository) {
  const byTag = await fetchJson(`https://api.github.com/repos/${repository}/releases/tags/${tag}`);
  if (byTag) return byTag;

  const releases = await fetchJson(`https://api.github.com/repos/${repository}/releases?per_page=100`);
  if (Array.isArray(releases)) {
    return releases.find((release) => release?.tag_name === tag) ?? null;
  }
  return null;
}

function releaseAsset(release, name) {
  return Array.isArray(release?.assets)
    ? (release.assets.find((item) => item?.name === name) ?? null)
    : null;
}

async function fetchReleaseWithDigests(tag, repository, assetNames) {
  let lastMissing = assetNames;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const release = await fetchRelease(tag, repository);
    if (!release) throw new Error(`release ${tag} was not found`);

    lastMissing = assetNames.filter((name) => {
      const asset = releaseAsset(release, name);
      return !asset || !normalizeDigest(asset.digest);
    });
    if (lastMissing.length === 0) return release;

    if (attempt < 12) {
      console.log(`Waiting for GitHub asset digests: ${lastMissing.join(", ")}`);
      await sleep(attempt * 2500);
    }
  }
  throw new Error(`release ${tag} assets have no SHA256 digest: ${lastMissing.join(", ")}`);
}

async function downloadReleaseAsset(tag, repository, dir, scriptName) {
  const release = await fetchReleaseWithDigests(tag, repository, [
    scriptName,
    `copilot-env-${tag}.tar.gz`,
  ]);
  if (!Array.isArray(release.assets)) throw new Error(`release ${tag} has no assets list`);

  const asset = releaseAsset(release, scriptName);
  if (!asset) throw new Error(`release ${tag} is missing ${scriptName}`);
  const digest = normalizeDigest(asset.digest);
  if (!digest) throw new Error(`release ${tag} asset ${scriptName} has no SHA256 digest`);

  const assetUrl = release.draft ? asset.url : (asset.browser_download_url ?? asset.url);
  if (typeof assetUrl !== "string" || !assetUrl) {
    throw new Error(`release ${tag} asset ${scriptName} has no download URL`);
  }

  const installer = join(dir, scriptName);
  const headers =
    assetUrl === asset.url ? authHeaders({ Accept: "application/octet-stream" }) : authHeaders();
  await download(assetUrl, installer, headers);
  return digest;
}

async function main(tag, repository) {
  const tmp = mkdtempSync(join(tmpdir(), "copilot-env-release-smoke-"));
  const scriptName = isWindows ? "install.ps1" : "install.sh";
  const installer = join(tmp, scriptName);

  const digest = await downloadReleaseAsset(tag, repository, tmp, scriptName);
  verifyDigest(installer, digest);

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
