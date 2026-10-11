// `bun run build`: the release binaries and dist/checksums.txt. What the binary embeds is the
// three fate lists in src/install/installer.ts and nothing else; they are staged into one
// directory at their repository paths first, because `bun build --asset` keeps a directory's
// inner tree but files each argument under its basename (`--asset=src/utils/ansi.ts` would
// surface as `<root>/ansi.ts`). At run time the stage is the binary's asset root: `import.meta.dir`
// of the bundled entry (`/$bunfs/root` on POSIX, `B:\~BUN\root` on Windows), which
// src/utils/root.ts exposes as ASSET_ROOT.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fileSha256 } from "../src/install/checksums.ts";
import {
  BUNDLED_ONLY_ASSETS,
  MATERIALIZED_ASSET_DIRS,
  MATERIALIZED_ASSET_FILES,
} from "../src/install/installer.ts";
import {
  currentReleaseTarget,
  RELEASE_TARGETS,
  type ReleaseTarget,
  releaseAssetName,
} from "../src/install/targets.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = "dist";
const ENTRY = "src/cli.ts";

const KNOWN_TRIPLES = RELEASE_TARGETS.map((target) => target.triple);

function usage(): string {
  return `Usage: bun run build [--target TRIPLE|host]...

Compiles ${ENTRY} for every release target into ${OUT_DIR}/ and writes
${OUT_DIR}/checksums.txt. --target (repeatable) restricts the build to the
given triple(s); \`host\` is this machine's, e.g. for a quick local build:

  bun run build --target host

Targets: ${KNOWN_TRIPLES.join(" ")}`;
}

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

/** `host` is this machine's target: the installer workflows build only that one. */
function knownTarget(triple: string): ReleaseTarget {
  if (triple === "host") {
    const host = currentReleaseTarget();
    if (host === null) {
      die(`no release target for this platform (${process.platform}/${process.arch}).`);
    }
    return host;
  }
  const target = RELEASE_TARGETS.find((candidate) => candidate.triple === triple);
  if (target === undefined) {
    die(`unknown target '${triple}' (known: host ${KNOWN_TRIPLES.join(" ")}).`);
  }
  return target;
}

function parseCli(): { help: boolean; targets: ReleaseTarget[] } {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: "boolean", short: "h" },
        target: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    });
    return { help: values.help === true, targets: (values.target ?? []).map(knownTarget) };
  } catch (error) {
    die(`${error instanceof Error ? error.message : String(error)} (try --help)`);
  }
}

const cli = parseCli();
if (cli.help) {
  console.log(usage());
  process.exit(0);
}
const targets = cli.targets.length > 0 ? cli.targets : [...RELEASE_TARGETS];

/** The embedded tree, copied out at its repository paths under `stage`. */
function stageAssets(stage: string): void {
  for (const dir of MATERIALIZED_ASSET_DIRS) {
    cpSync(join(ROOT, dir), join(stage, dir), { recursive: true });
  }
  for (const file of [...MATERIALIZED_ASSET_FILES, ...BUNDLED_ONLY_ASSETS]) {
    mkdirSync(dirname(join(stage, file)), { recursive: true });
    cpSync(join(ROOT, file), join(stage, file));
  }
}

/** The build's exit status. */
function build(target: ReleaseTarget, assetFlags: readonly string[]): number {
  const out = `${OUT_DIR}/${releaseAssetName(target)}`;
  console.error(`==> bun build --compile --target ${target.bunTarget} -> ${out}`);
  // The deno binary autoloaded nothing from the cwd; a `.env` or bunfig.toml there must not
  // reach the CLI's environment either.
  const result = spawnSync(
    process.execPath,
    [
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      ...assetFlags,
      `--outfile=${out}`,
      ENTRY,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
// One `--asset` per top-level entry of the stage; the stage goes whatever the builds did.
const stage = mkdtempSync(join(tmpdir(), "copilot-env-assets-"));
let status = 0;
try {
  stageAssets(stage);
  const assetFlags = readdirSync(stage)
    .sort()
    .map((entry) => `--asset=${join(stage, entry)}`);
  for (const target of targets) {
    status = build(target, assetFlags);
    if (status !== 0) break;
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
if (status !== 0) process.exit(status);

// checksums.txt covers every release binary currently in dist/ (so a filtered
// build still emits verifiable lines), in `shasum -a 256 -c` compatible form.
const assetNames = new Set(RELEASE_TARGETS.map(releaseAssetName));
const binaries = readdirSync(join(ROOT, OUT_DIR), { withFileTypes: true })
  .filter((entry) => entry.isFile() && assetNames.has(entry.name))
  .map((entry) => entry.name)
  .sort();
const lines = await Promise.all(
  binaries.map(async (name) => `${await fileSha256(join(ROOT, OUT_DIR, name))}  ${name}\n`),
);
writeFileSync(join(ROOT, OUT_DIR, "checksums.txt"), lines.join(""));
console.error(`==> wrote ${OUT_DIR}/checksums.txt`);
