// Prepare/validate/package the per-release installer assets: copies of
// install.sh/install.ps1 pinned to the release tag, plus the source archive
// downloaded from GitHub's tarball endpoint.
// Run by the release workflow: bun .github/scripts/release-assets.ts <command> <tag> [repo]
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.env.RELEASE_ASSETS_DIR ?? "release-assets";

function usage(): never {
  console.error("usage: release-assets.ts prepare|validate|create-archive <vX.Y.Z> [owner/repo]");
  process.exit(2);
}

function archiveName(tag: string): string {
  return `copilot-env-${tag}.tar.gz`;
}

function pin(path: string, needle: string, replacement: string): void {
  const before = readFileSync(path, "utf8");
  if (!before.includes(needle)) {
    throw new Error(`${path}: placeholder not found: ${needle}`);
  }
  writeFileSync(path, before.replace(needle, replacement));
}

function assertIncludes(path: string, text: string): void {
  if (!readFileSync(path, "utf8").includes(text)) {
    throw new Error(`${path}: expected to contain ${text}`);
  }
  console.log(`${path}: contains ${text}`);
}

function prepare(tag: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync("install.sh", join(OUT_DIR, "install.sh"));
  copyFileSync("install.ps1", join(OUT_DIR, "install.ps1"));

  const shPath = join(OUT_DIR, "install.sh");
  pin(
    shPath,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${...} is install.sh's own shell placeholder being pinned, not a JS template.
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

  const psPath = join(OUT_DIR, "install.ps1");
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

function validate(tag: string): void {
  const shPath = join(OUT_DIR, "install.sh");
  const psPath = join(OUT_DIR, "install.ps1");
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

async function download(url: string, path: string): Promise<void> {
  const headers: Record<string, string> = { "User-Agent": "copilot-env" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`failed to download ${url} (HTTP ${res.status})`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
}

async function createArchive(tag: string, repository: string | undefined): Promise<void> {
  if (!repository) usage();
  mkdirSync(OUT_DIR, { recursive: true });
  const archive = archiveName(tag);
  const archivePath = join(OUT_DIR, archive);
  rmSync(archivePath, { force: true });
  await download(`https://api.github.com/repos/${repository}/tarball/${tag}`, archivePath);
  console.log(`${archivePath}: created`);
}

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
