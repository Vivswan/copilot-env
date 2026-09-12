// `deno task compile`: the release binaries and dist/checksums.txt. The --include list is NOT
// here: deno.json's `compile.include` owns it (test/installer_pinning.test.ts pins it to
// installer.ts's asset lists), and a CLI --include MERGES with the config's list rather than
// replacing it, so a second copy would silently union.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fileSha256 } from "../src/install/checksums.ts";
import { RELEASE_TARGETS, releaseAssetName, type ReleaseTarget } from "../src/install/targets.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = "dist";
// deno.json's compile.permissions holds the set; -P must still be passed as an
// explicit acknowledgement or `deno compile` refuses to use it.
const PERMISSION_SET = "cli";
const ENTRY = "src/cli.ts";
const APP_NAME = "copilot-env";

const KNOWN_TRIPLES = RELEASE_TARGETS.map((target) => target.triple);

function usage(): string {
  return `Usage: deno task compile [--target TRIPLE]...

Compiles ${ENTRY} for every release target into ${OUT_DIR}/ and writes
${OUT_DIR}/checksums.txt. --target (repeatable) restricts the build to the
given triple(s), e.g. for a quick local host build:

  deno task compile --target aarch64-apple-darwin

Targets: ${KNOWN_TRIPLES.join(" ")}`;
}

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  Deno.exit(2);
}

function knownTarget(triple: string): ReleaseTarget {
  const target = RELEASE_TARGETS.find((candidate) => candidate.triple === triple);
  if (target === undefined) {
    die(`unknown target '${triple}' (known: ${KNOWN_TRIPLES.join(" ")}).`);
  }
  return target;
}

const selected: ReleaseTarget[] = [];
const args = [...Deno.args];
for (let arg = args.shift(); arg !== undefined; arg = args.shift()) {
  if (arg === "-h" || arg === "--help") {
    console.log(usage());
    Deno.exit(0);
  } else if (arg === "--target") {
    const triple = args.shift();
    if (triple === undefined) die("--target needs a target triple argument.");
    selected.push(knownTarget(triple));
  } else if (arg.startsWith("--target=")) {
    selected.push(knownTarget(arg.slice("--target=".length)));
  } else {
    die(`unknown argument '${arg}' (try --help)`);
  }
}
const targets = selected.length > 0 ? selected : [...RELEASE_TARGETS];

Deno.mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
for (const target of targets) {
  const out = `${OUT_DIR}/${releaseAssetName(target)}`;
  console.error(`==> deno compile --target ${target.triple} -> ${out}`);
  // --node-modules-dir=none resolves npm through the global cache; --exclude-unused-npm is
  // silently a no-op while a local node_modules exists. Without it the checkout's node_modules
  // (the proxy's own tree, which this binary never imports) embeds whole: ~78MB per target.
  const { code } = new Deno.Command("deno", {
    args: [
      "compile",
      "--target",
      target.triple,
      "--node-modules-dir=none",
      "--exclude-unused-npm",
      `-P=${PERMISSION_SET}`,
      "--app-name",
      APP_NAME,
      "-o",
      out,
      ENTRY,
    ],
    cwd: ROOT,
    env: { "DENO_NO_UPDATE_CHECK": "1" },
    stdout: "inherit",
    stderr: "inherit",
  }).outputSync();
  if (code !== 0) Deno.exit(code);
}

// checksums.txt covers every release binary currently in dist/ (so a filtered
// build still emits verifiable lines), in `shasum -a 256 -c` compatible form.
const assetNames = new Set(RELEASE_TARGETS.map(releaseAssetName));
const binaries = [...Deno.readDirSync(join(ROOT, OUT_DIR))]
  .filter((entry) => entry.isFile && assetNames.has(entry.name))
  .map((entry) => entry.name)
  .sort();
const lines = await Promise.all(
  binaries.map(async (name) => `${await fileSha256(join(ROOT, OUT_DIR, name))}  ${name}\n`),
);
Deno.writeTextFileSync(join(ROOT, OUT_DIR, "checksums.txt"), lines.join(""));
console.error(`==> wrote ${OUT_DIR}/checksums.txt`);
