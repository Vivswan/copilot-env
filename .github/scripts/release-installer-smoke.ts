// Download a published release's installer asset, verify its GitHub-reported
// SHA256 digest, run it against a temp install dir, and confirm the installed
// launcher. The post-release counterpart of release-pr-smoke.ts.
// Run by release-please.yml: bun .github/scripts/release-installer-smoke.ts <vX.Y.Z> <owner/repo>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";

interface ReleaseAsset {
  name?: string;
  url?: string;
  browser_download_url?: string;
  digest?: string;
}

interface Release {
  tag_name?: string;
  draft?: boolean;
  assets?: ReleaseAsset[];
}

function usage(): never {
  console.error("usage: release-installer-smoke.ts <vX.Y.Z> <owner/repo>");
  process.exit(2);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "copilot-env" };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return { ...headers, ...extra };
}

async function download(
  url: string,
  path: string,
  headers: Record<string, string> = authHeaders(),
): Promise<void> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`failed to download ${url} (HTTP ${res.status})`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeDigest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^sha256:([0-9a-f]{64})$/i);
  const digest = match?.[1];
  return digest !== undefined ? digest.toLowerCase() : null;
}

function verifyDigest(file: string, expected: string): void {
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(`${file}: SHA256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: authHeaders({
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchRelease(tag: string, repository: string): Promise<Release | null> {
  const byTag = await fetchJson(`https://api.github.com/repos/${repository}/releases/tags/${tag}`);
  if (byTag) return byTag as Release;

  const releases = await fetchJson(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
  );
  if (Array.isArray(releases)) {
    return (releases as Release[]).find((release) => release?.tag_name === tag) ?? null;
  }
  return null;
}

function releaseAsset(release: Release, name: string): ReleaseAsset | null {
  return Array.isArray(release.assets)
    ? (release.assets.find((item) => item?.name === name) ?? null)
    : null;
}

async function fetchReleaseWithDigests(
  tag: string,
  repository: string,
  assetNames: string[],
): Promise<Release> {
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

async function downloadReleaseAsset(
  tag: string,
  repository: string,
  dir: string,
  scriptName: string,
): Promise<string> {
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
    assetUrl === asset.url ? authHeaders({ "Accept": "application/octet-stream" }) : authHeaders();
  await download(assetUrl, installer, headers);
  return digest;
}

async function main(tag: string, repository: string): Promise<void> {
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

async function runMain(): Promise<void> {
  const [tag, repository] = process.argv.slice(2);
  if (!tag || !repository) usage();
  await main(tag, repository);
}

runMain().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
