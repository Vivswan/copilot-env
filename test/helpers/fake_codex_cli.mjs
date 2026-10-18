// The fake codex CLI the catalog tests put on PATH (test/helpers/fake_codex.ts writes the sh
// dispatcher that runs it, or compiles it into codex.exe). Scripted by the JSON file beside the
// dispatcher or the executable, re-read on every spawn.
//   codex --version               -> `codex-cli <version>`, or exit 1 when null
//   codex debug models --bundled  -> the bundled dump, or exit 1 when null
//   codex debug models            -> the catalog probe: the answer depends on `probe` and on
//                                    whether CODEX_HOME's config.toml references a candidate
//                                    (`model_catalog_json`), read from that path as codex would
// Every `debug models` spawn is journaled (argv, the real cwd and home, taken while they exist)
// and the last candidate's bytes are kept, so a test can see what a real codex would have been
// asked to parse.
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Compiled, the script's own dir is the executable's embedded root; the fixture sits beside the exe.
const dir = Bun.isStandaloneExecutable ? dirname(process.execPath) : import.meta.dirname;
const spec = JSON.parse(readFileSync(`${dir}/spec.json`, "utf8"));

function out(text) {
  process.stdout.write(`${text}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const DUMP = '{"models":[{"slug":"fake"}]}';
const args = process.argv.slice(2);

if (args[0] === "--version") {
  if (spec.version === null) process.exit(1);
  out(`codex-cli ${spec.version}`);
  process.exit(0);
}

if (args[0] !== "debug" || args[1] !== "models") fail(`fake codex: unexpected ${args.join(" ")}`);

const home = process.env.CODEX_HOME ?? "";
appendFileSync(
  `${dir}/runs.jsonl`,
  `${JSON.stringify({ args, cwd: realpathSync(process.cwd()), home: realpathSync(home) })}\n`,
);

if (args.includes("--bundled")) {
  if (spec.bundled === null) fail("fake codex: no bundled dump");
  out(spec.bundled);
  process.exit(0);
}

let config = "";
try {
  config = readFileSync(`${home}/config.toml`, "utf8");
} catch {
  // no config at all reads as no reference
}
// The reference is a TOML basic string, whose escapes are JSON's.
const reference = /^model_catalog_json = ("(?:[^"\\]|\\.)*")$/m.exec(config);
let candidate = null;
if (reference !== null) {
  try {
    candidate = readFileSync(JSON.parse(reference[1]), "utf8");
  } catch {
    fail("Error: failed to read model_catalog_json");
  }
  writeFileSync(`${dir}/seen.json`, candidate);
}

switch (spec.probe) {
  case "accept":
    if (candidate === null) out(DUMP);
    else if (candidate.includes('"models"')) out(candidate);
    else fail("Error: failed to parse model_catalog_json");
    break;
  case "reject":
    if (candidate !== null) fail("Error: bad catalog");
    out(DUMP);
    break;
  case "dump-other":
    out(DUMP);
    break;
  case "echo-any":
    out(candidate ?? DUMP);
    break;
  case "fail-always":
    fail("Error: config broken");
    break;
  case "blank-control":
    if (candidate !== null) process.exit(1);
    out("");
    break;
  case "no-dump":
    out("nothing");
    break;
  case "kill-candidate":
    if (candidate !== null) process.kill(process.pid, "SIGTERM");
    out(DUMP);
    break;
  default:
    fail(`fake codex: unknown probe ${String(spec.probe)}`);
}
