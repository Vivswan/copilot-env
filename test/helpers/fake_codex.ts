// A `codex` on PATH for the catalog tests, the same fake on every platform: a sh dispatcher and a
// `.cmd` twin hand the argv to test/helpers/fake_codex_cli.mjs under this process's deno, and a
// failing `npm` beside them keeps the User-Agent's version road off the network. The live-lookup
// seam is lifted so the production spawns really run; the process memos (the codex path, its
// version, the probe verdicts by content) are forgotten on every re-script so the new script
// answers.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetCatalogProbeState } from "../../src/codex/catalog.ts";
import { CI_NO_LIVE_LOOKUPS_ENV, resetCodexVersionMemo } from "../../src/codex/user_agent.ts";

/** What `codex debug models` answers when the throwaway home references a candidate.
 *    accept         -> parses a catalog-shaped candidate (dumps it back), fails garbage
 *    reject         -> fails every candidate; dumps without one (the control)
 *    dump-other     -> exit 0 with a dump the candidate did not produce
 *    echo-any       -> dumps the candidate's bytes whatever they are (garbage too)
 *    fail-always    -> exit 1 with and without a candidate
 *    blank-control  -> exit 1 on a candidate; exit 0 with no dump without one
 *    no-dump        -> exit 0 without a catalog dump
 *    kill-candidate -> dies by signal on a candidate; dumps without one */
export type FakeCodexProbe =
  | "accept"
  | "reject"
  | "dump-other"
  | "echo-any"
  | "fail-always"
  | "blank-control"
  | "no-dump"
  | "kill-candidate";

export interface FakeCodexSpec {
  /** `codex --version` prints `codex-cli <version>`; null exits 1 (no resolvable version). */
  version: string | null;
  /** `codex debug models --bundled` stdout; null exits 1. */
  bundled: string | null;
  probe: FakeCodexProbe;
}

/** `cwd` and `home` are real paths, taken while the throwaway home still exists. */
export interface FakeCodexRun {
  args: string[];
  cwd: string;
  home: string;
}

export interface FakeCodex {
  /** Re-script the fake and forget the process memos, so the next spawn answers as scripted. */
  script(spec: Partial<FakeCodexSpec>): void;
  /** Every `debug models` spawn so far, in order. */
  runs(): FakeCodexRun[];
  /** The last candidate's bytes the probe was asked to parse, or null when none was. */
  seen(): string | null;
}

const CLI = fileURLToPath(new URL("./fake_codex_cli.mjs", import.meta.url));

/** Installs the fake under `dir` (the test's scratch dir) at the front of PATH. The caller's env
 *  snapshot restores PATH and the live-lookup seam. */
export function fakeCodexOnPath(dir: string, spec: Partial<FakeCodexSpec> = {}): FakeCodex {
  const bin = join(dir, "fake-codex");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "fake_codex_cli.mjs");
  writeFileSync(cli, readFileSync(CLI));
  const deno = Deno.execPath();
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${deno}" run -A "${cli}" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(join(bin, "codex.cmd"), `@"${deno}" run -A "${cli}" %*\r\n`);
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(join(bin, "npm.cmd"), "@echo off\r\nexit 1\r\n");
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  delete process.env[CI_NO_LIVE_LOOKUPS_ENV];
  const runsFile = join(bin, "runs.jsonl");
  const seenFile = join(bin, "seen.json");
  let current: FakeCodexSpec = { version: "1.2.3", bundled: null, probe: "dump-other" };
  const fake: FakeCodex = {
    script(next) {
      current = { ...current, ...next };
      writeFileSync(join(bin, "spec.json"), JSON.stringify(current));
      rmSync(seenFile, { force: true });
      resetCatalogProbeState();
      resetCodexVersionMemo();
    },
    runs() {
      if (!existsSync(runsFile)) return [];
      return readFileSync(runsFile, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCodexRun);
    },
    seen() {
      return existsSync(seenFile) ? readFileSync(seenFile, "utf8") : null;
    },
  };
  fake.script(spec);
  return fake;
}
