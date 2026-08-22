// Staged-file autofix for .githooks/pre-commit (`deno task lint:staged`): the
// deno-native replacement for lint-staged, so the hook needs no node. Runs
// `deno lint --fix` then `deno fmt` on the staged TypeScript under the source
// trees (fmt alone for deno.json) and re-stages the results; anything the
// fixers cannot resolve exits nonzero and blocks the commit.
//
// Whole files are re-staged, not patches, so a partially staged target is
// REFUSED up front (stage it fully or stash the rest): silently widening a
// `git add -p` commit is the failure mode, and the stash dance lint-staged
// performs to support partial staging IS most of lint-staged.

const TS_TREES = ["src/", "test/", "scripts/", ".github/scripts/"];

function run(cmd: string, args: string[]): number {
  return new Deno.Command(cmd, { args, stdout: "inherit", stderr: "inherit" }).outputSync().code;
}

/** NUL-separated `git <args>` stdout as a list, exiting on git failure. */
function gitList(args: string[]): string[] {
  const out = new Deno.Command("git", { args: [...args, "-z"], stderr: "inherit" }).outputSync();
  if (out.code !== 0) Deno.exit(out.code);
  return new TextDecoder().decode(out.stdout).split("\0").filter((name) => name !== "");
}

const files = gitList(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
const tsFiles = files.filter((f) => f.endsWith(".ts") && TS_TREES.some((t) => f.startsWith(t)));
const targets = [...tsFiles, ...(files.includes("deno.json") ? ["deno.json"] : [])];
if (targets.length === 0) Deno.exit(0);

// The partial-staging refusal. Checked BEFORE the fixers run: they edit the
// working tree, so afterwards every fixed file would look partially staged.
const partiallyStaged = gitList(["diff", "--name-only", "--", ...targets]);
if (partiallyStaged.length > 0) {
  console.error(
    "lint:staged: refusing to run -- these staged files also have unstaged changes, and the " +
      "whole-file re-stage would silently commit them. Stage them fully or stash the rest:\n" +
      partiallyStaged.map((name) => `  ${name}`).join("\n"),
  );
  Deno.exit(1);
}

if (tsFiles.length > 0) {
  const lint = run("deno", ["lint", "--fix", ...tsFiles]);
  if (lint !== 0) Deno.exit(lint);
}
const fmt = run("deno", ["fmt", ...targets]);
if (fmt !== 0) Deno.exit(fmt);
Deno.exit(run("git", ["add", "--", ...targets]));
