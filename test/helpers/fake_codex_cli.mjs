// The fake codex CLI the catalog tests put on PATH (test/helpers/fake_codex.ts writes the
// dispatchers that run it). Scripted by the JSON file beside it, re-read on every spawn.
//   codex --version               -> `codex-cli <version>`, or exit 1 when null
//   codex debug models --bundled  -> the bundled dump, or exit 1 when null
//   codex debug models            -> the catalog probe: the answer depends on `probe` and on
//                                    whether CODEX_HOME's config.toml references a candidate
//                                    (`model_catalog_json`), read from that path as codex would
// Every `debug models` spawn is journaled (argv, the real cwd and home, taken while they exist)
// and the last candidate's bytes are kept, so a test can see what a real codex would have been
// asked to parse.
const dir = import.meta.dirname;
const spec = JSON.parse(Deno.readTextFileSync(`${dir}/spec.json`));

function out(text) {
  Deno.stdout.writeSync(new TextEncoder().encode(`${text}\n`));
}

function fail(message) {
  Deno.stderr.writeSync(new TextEncoder().encode(`${message}\n`));
  Deno.exit(1);
}

const DUMP = '{"models":[{"slug":"fake"}]}';
const args = Deno.args;

if (args[0] === "--version") {
  if (spec.version === null) Deno.exit(1);
  out(`codex-cli ${spec.version}`);
  Deno.exit(0);
}

if (args[0] !== "debug" || args[1] !== "models") fail(`fake codex: unexpected ${args.join(" ")}`);

const home = Deno.env.get("CODEX_HOME") ?? "";
Deno.writeTextFileSync(
  `${dir}/runs.jsonl`,
  `${
    JSON.stringify({ args, cwd: Deno.realPathSync(Deno.cwd()), home: Deno.realPathSync(home) })
  }\n`,
  { append: true },
);

if (args.includes("--bundled")) {
  if (spec.bundled === null) fail("fake codex: no bundled dump");
  out(spec.bundled);
  Deno.exit(0);
}

let config = "";
try {
  config = Deno.readTextFileSync(`${home}/config.toml`);
} catch {
  // no config at all reads as no reference
}
// The reference is a TOML basic string, whose escapes are JSON's.
const reference = /^model_catalog_json = ("(?:[^"\\]|\\.)*")$/m.exec(config);
let candidate = null;
if (reference !== null) {
  try {
    candidate = Deno.readTextFileSync(JSON.parse(reference[1]));
  } catch {
    fail("Error: failed to read model_catalog_json");
  }
  Deno.writeTextFileSync(`${dir}/seen.json`, candidate);
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
    if (candidate !== null) Deno.exit(1);
    out("");
    break;
  case "no-dump":
    out("nothing");
    break;
  case "kill-candidate":
    if (candidate !== null) Deno.kill(Deno.pid, "SIGTERM");
    out(DUMP);
    break;
  default:
    fail(`fake codex: unknown probe ${String(spec.probe)}`);
}
