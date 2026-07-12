// Simulated release-install smoke for the rolling release-please PR.
//
// The real release smoke (release-installer-smoke.cjs) can only run AFTER
// release-please tags and uploads the assets -- so a packaging bug (broken
// archive, installer/resolver mismatch) is found only once a draft release
// already exists, stranding a burned version number. This script gives the
// release PR the same end-to-end coverage BEFORE merge by simulating the
// pending release from the working tree:
//
//   1. `release-assets.cjs prepare/validate` pins the installers to the
//      pending tag (the exact mechanics the release workflow will run).
//   2. `git archive HEAD` builds the source archive with the same wrapper-dir
//      SHA marker shape as a GitHub tarball.
//   3. A localhost HTTP server plays GitHub: the releases API (one simulated
//      release for the pending tag, with the archive's real SHA256 digest),
//      the raw resolver/verifier downloads, and the archive asset itself.
//   4. The prepared installer runs against that server via the CI-only
//      COPILOT_ENV_CI_RELEASES_API_URL hook in resolve-release.ts, exercising
//      resolve -> download -> verify -> extract -> bundled installer.
//
// Usage: node .github/scripts/release-pr-smoke.cjs

const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const isWindows = process.platform === "win32";
const repoRoot = resolve(__dirname, "..", "..");

function run(command, args, options = {}) {
  const proc = spawnSync(command, args, { stdio: "inherit", cwd: repoRoot, ...options });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${proc.status}`);
  }
}

// The installer talks to the HTTP stand-in served by THIS process, so it must run
// async: spawnSync would block the event loop and deadlock the installer's first
// request against a server that can never respond.
function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, args, { stdio: "inherit", cwd: repoRoot, ...options });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit ${code}`));
    });
  });
}

function pin(path, needle, replacement) {
  const before = readFileSync(path, "utf8");
  if (!before.includes(needle)) {
    throw new Error(`${path}: expected pinned text not found: ${needle}`);
  }
  writeFileSync(path, before.split(needle).join(replacement));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main() {
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  const tag = `v${version}`;
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .toLowerCase();
  const archiveName = `copilot-env-${tag}.tar.gz`;
  const tmp = mkdtempSync(join(tmpdir(), "copilot-env-release-pr-smoke-"));
  const assetsDir = join(tmp, "release-assets");
  const scriptName = isWindows ? "install.ps1" : "install.sh";

  // 1. Pin the installers exactly as the release workflow does, and validate the pins.
  const assetsEnv = { ...process.env, RELEASE_ASSETS_DIR: assetsDir };
  run("node", [".github/scripts/release-assets.cjs", "prepare", tag], { env: assetsEnv });
  run("node", [".github/scripts/release-assets.cjs", "validate", tag], { env: assetsEnv });

  // 2. Build the pending source archive: same wrapper-dir SHA marker shape as a
  // GitHub tarball (verify-source-archive.ts checks the root dir's trailing hex
  // against the release's target commit).
  const archivePath = join(tmp, archiveName);
  run("git", [
    "archive",
    "--format=tar.gz",
    `--prefix=Vivswan-copilot-env-${headSha.slice(0, 7)}/`,
    "-o",
    archivePath,
    "HEAD",
  ]);
  const archiveSha256 = sha256File(archivePath);

  // 3. Localhost GitHub stand-in: releases API + raw resolver/verifier + the asset.
  const rawFiles = new Map(
    ["resolve-release.ts", "verify-source-archive.ts"].map((name) => [
      `/src/install/${name}`,
      join(repoRoot, "src", "install", name),
    ]),
  );
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path.startsWith("/repos/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          {
            tag_name: tag,
            draft: false,
            prerelease: false,
            target_commitish: headSha,
            published_at: new Date().toISOString(),
            assets: [
              {
                name: archiveName,
                browser_download_url: `${baseUrl}/assets/${archiveName}`,
                url: `${baseUrl}/assets/${archiveName}`,
                digest: `sha256:${archiveSha256}`,
              },
            ],
          },
        ]),
      );
      return;
    }
    if (rawFiles.has(path)) {
      res.end(readFileSync(rawFiles.get(path)));
      return;
    }
    if (path === `/assets/${archiveName}`) {
      res.end(readFileSync(archivePath));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`simulating release ${tag} (${headSha.slice(0, 7)}) at ${baseUrl}`);

  // Point the prepared installer's pinned raw downloads at the stand-in server.
  const installer = join(assetsDir, scriptName);
  pin(
    installer,
    `https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/`,
    `${baseUrl}/src/install/`,
  );

  // 4. Run the prepared installer end to end against the simulated release.
  const installDir = join(tmp, "copilot-env");
  const installEnv = {
    ...process.env,
    COPILOT_ENV_CI_RELEASES_API_URL: `${baseUrl}/repos/Vivswan/copilot-env/releases`,
  };
  try {
    if (isWindows) {
      await runAsync(
        "pwsh",
        ["-NoProfile", "-File", installer, "-InstallDir", installDir, "-NoShellIntegration"],
        { env: installEnv },
      );
    } else {
      await runAsync("bash", [installer, "--dir", installDir, "--no-shell-integration"], {
        env: installEnv,
      });
    }
  } finally {
    server.close();
  }

  // The install must be the pending tree, not some previously published release.
  const agent = join(installDir, "bin", isWindows ? "agent.ps1" : "agent");
  if (!existsSync(agent) || !readFileSync(agent, "utf8").includes("copilot-env")) {
    throw new Error(`installed agent launcher was not found at ${agent}`);
  }
  const installedVersion = JSON.parse(
    readFileSync(join(installDir, "package.json"), "utf8"),
  ).version;
  if (installedVersion !== version) {
    throw new Error(
      `installed version ${installedVersion} does not match the pending release ${version}`,
    );
  }
  console.log(`release-PR smoke OK: ${scriptName} installed pending ${tag} end to end`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
