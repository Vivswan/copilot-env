const { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const outDir = process.env.RELEASE_ASSETS_DIR ?? "release-assets";

function usage() {
  console.error(
    "usage: release-assets.cjs prepare|validate|create-archive <vX.Y.Z> [owner/repo]",
  );
  process.exit(2);
}

function archiveName(tag) {
  return `copilot-env-${tag}.tar.gz`;
}

function pin(path, needle, replacement) {
  const before = readFileSync(path, "utf8");
  if (!before.includes(needle)) {
    throw new Error(`${path}: placeholder not found: ${needle}`);
  }
  writeFileSync(path, before.replace(needle, replacement));
}

function assertIncludes(path, text) {
  if (!readFileSync(path, "utf8").includes(text)) {
    throw new Error(`${path}: expected to contain ${text}`);
  }
  console.log(`${path}: contains ${text}`);
}

function prepare(tag) {
  mkdirSync(outDir, { recursive: true });
  copyFileSync("install.sh", join(outDir, "install.sh"));
  copyFileSync("install.ps1", join(outDir, "install.ps1"));

  const shPath = join(outDir, "install.sh");
  pin(
    shPath,
    'INSTALL_REF="${COPILOT_ENV_INSTALL_REF:-latest}"',
    `INSTALL_REF="\${COPILOT_ENV_INSTALL_REF:-${tag}}"`,
  );
  pin(
    shPath,
    'RESOLVER_URL="https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/resolve-release.ts"',
    `RESOLVER_URL="https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/resolve-release.ts"`,
  );
  pin(
    shPath,
    'VERIFIER_URL="https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/verify-source-archive.ts"',
    `VERIFIER_URL="https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/verify-source-archive.ts"`,
  );

  const psPath = join(outDir, "install.ps1");
  pin(
    psPath,
    "$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { 'latest' }",
    `$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { '${tag}' }`,
  );
  pin(
    psPath,
    "$ResolverUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/resolve-release.ts'",
    `$ResolverUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/resolve-release.ts'`,
  );
  pin(
    psPath,
    "$VerifierUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/verify-source-archive.ts'",
    `$VerifierUrl = 'https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/verify-source-archive.ts'`,
  );
}

function validate(tag) {
  const shPath = join(outDir, "install.sh");
  const psPath = join(outDir, "install.ps1");
  assertIncludes(shPath, `INSTALL_REF="\${COPILOT_ENV_INSTALL_REF:-${tag}}"`);
  assertIncludes(
    shPath,
    `https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/resolve-release.ts`,
  );
  assertIncludes(
    shPath,
    `https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/verify-source-archive.ts`,
  );
  assertIncludes(
    psPath,
    `$InstallRef = if ($env:COPILOT_ENV_INSTALL_REF) { $env:COPILOT_ENV_INSTALL_REF } else { '${tag}' }`,
  );
  assertIncludes(
    psPath,
    `https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/resolve-release.ts`,
  );
  assertIncludes(
    psPath,
    `https://raw.githubusercontent.com/Vivswan/copilot-env/${tag}/src/install/verify-source-archive.ts`,
  );
}

async function download(url, path) {
  const headers = { "User-Agent": "copilot-env" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`failed to download ${url} (HTTP ${res.status})`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
}

async function createArchive(tag, repository) {
  if (!repository) usage();
  mkdirSync(outDir, { recursive: true });
  const archive = archiveName(tag);
  const archivePath = join(outDir, archive);
  rmSync(archivePath, { force: true });
  await download(`https://api.github.com/repos/${repository}/tarball/${tag}`, archivePath);
  console.log(`${archivePath}: created`);
}

async function main() {
  const [command, tag, repository] = process.argv.slice(2);
  if (!command || !tag) usage();
  if (command === "prepare") {
    prepare(tag);
  } else if (command === "validate") {
    validate(tag);
  } else if (command === "create-archive") {
    await createArchive(tag, repository);
  } else {
    usage();
  }
}

try {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
