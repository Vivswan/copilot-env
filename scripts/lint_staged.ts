// Staged-file autofix for .githooks/pre-commit (`deno task lint:staged`): the
// deno-native replacement for lint-staged, so the hook needs no node. Runs
// `deno lint --fix` then `deno fmt` on the staged TypeScript under the source
// trees (fmt alone for deno.json) and re-stages the results; anything the
// fixers cannot resolve exits nonzero and blocks the commit.
//
// Whole files are re-staged, not patches: a partially staged file picks up its
// unstaged hunks here. The stash dance lint-staged performs to avoid that IS
// most of lint-staged, and this repo's flow does not stage partial hunks.

const TS_TREES = ["src/", "test/", "scripts/", ".github/scripts/"];

function run(cmd: string, args: string[]): number {
  return new Deno.Command(cmd, { args, stdout: "inherit", stderr: "inherit" }).outputSync().code;
}

const staged = new Deno.Command("git", {
  args: ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  stderr: "inherit",
}).outputSync();
if (staged.code !== 0) Deno.exit(staged.code);

const files = new TextDecoder().decode(staged.stdout).split("\0").filter((name) => name !== "");
const tsFiles = files.filter((f) => f.endsWith(".ts") && TS_TREES.some((t) => f.startsWith(t)));
const targets = [...tsFiles, ...(files.includes("deno.json") ? ["deno.json"] : [])];
if (targets.length === 0) Deno.exit(0);

if (tsFiles.length > 0) {
  const lint = run("deno", ["lint", "--fix", ...tsFiles]);
  if (lint !== 0) Deno.exit(lint);
}
const fmt = run("deno", ["fmt", ...targets]);
if (fmt !== 0) Deno.exit(fmt);
Deno.exit(run("git", ["add", "--", ...targets]));
