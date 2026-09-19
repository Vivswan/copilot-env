// The oracle harness the CLI redesign tests share: a scratch HOME the child owns entirely, the
// path normalization that lets a POSIX-captured oracle match on Windows, and the two comparisons
// (a spelling against the oracle; two spellings against each other in twin homes). The oracles are
// what the base's spellings printed (stdout, exit code) in such a home, captured before the move.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getSanitizedHostname } from "../../src/utils/hostname.ts";
import { escapeRegExp } from "../../src/utils/regexp.ts";
import { PROJECT_ROOT } from "../../src/utils/root.ts";
import { runCli } from "./run.ts";
import { expect, tempDir } from "./testing.ts";

export interface Observation {
  exitCode: number | null;
  stdout: string;
}

export type Oracle = Record<string, Observation>;

export interface ScratchHome {
  home: string;
  env: Record<string, string>;
}

/** `test/fixtures/cli_redesign/<name>.json`, parsed; the caller names its shape. */
export function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(PROJECT_ROOT, "test", "fixtures", "cli_redesign", `${name}.json`), "utf8"),
  );
}

/** A fixture of spelling -> what it printed. */
export function loadOracle(name: string): Oracle {
  return loadFixture(name) as Oracle;
}

/** A scratch HOME the child owns entirely: its data home, both agent homes, and a port pin that
 *  keeps a real proxy on 4141 out of the picture. */
export function scratchHome(prefix = "copilot-cli-oracle-"): ScratchHome {
  const home = tempDir(prefix);
  writeFileSync(join(home, "state.json"), JSON.stringify({ global: { "daemon.port": 4199 } }));
  return {
    home,
    env: {
      ...process.env,
      CONSOLA_LEVEL: "5",
      NO_COLOR: "1",
      COPILOT_API_HOME: home,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
    },
  };
}

/** The checkout as a whole path: the container suite mounts it at `/work`, which is also the
 *  fixture profile's name (`<HOME>/profiles/work/`), so the match must start a path (nothing
 *  path-like before it) and end one (a separator, a quote, a space, or the end after it). */
function rootPattern(root: string): RegExp {
  return new RegExp(`(?<![\\w<>/.\\\\-])${escapeRegExp(root)}(?=[\\\\/"' ]|$)`, "gm");
}

/** Windows separators fold to `/`, inside a folded path alone (`<HOME>...`, `<ROOT>...`): a
 *  `\n` escape inside a `--json` report's string is text, not a separator. A JSON-escaped
 *  separator (two backslashes) folds to the one `/`. */
const FOLDED_PATH = /<(?:HOME|ROOT)>[^\s"'`)]*/g;

/** The oracle was captured on POSIX: a Windows run's separators and its PowerShell launcher
 *  spelling fold to the same tokens (the outputs compared here are paths and words), the
 *  machine's hostname (a daemon run-dir segment, `.run/<host>/`) folds to <HOST>, the
 *  heartbeat's clock reading (the run state's lastEnsureAt) folds to <NOW>, and consola's info
 *  marker (the glyph off a TTY, `[info]` under CI's basic reporter) folds to <INFO>. */
export function normalize(home: string, text: string, root: string = PROJECT_ROOT): string {
  return text
    .replaceAll(home, "<HOME>")
    .replace(rootPattern(root), "<ROOT>")
    .replace(FOLDED_PATH, (path) => path.replace(/\\+/g, "/"))
    .replaceAll(`.run/${getSanitizedHostname()}/`, ".run/<HOST>/")
    .replace(/"lastEnsureAt": \d+/g, '"lastEnsureAt": <NOW>')
    .replace(/^(?:\u2139|\[info\]) /gm, "<INFO> ")
    .replace(
      /powershell -NoProfile -ExecutionPolicy Bypass -File "?<ROOT>\/bin\/agent\.ps1"?/g,
      "<ROOT>/bin/agent",
    );
}

/** What the outside sees of one spelling: exit code, stdout with the scratch paths normalized. */
export function observe(
  args: string[],
  scratch: ScratchHome,
): Observation & { stderr: string } {
  const proc = runCli(args, { env: scratch.env });
  return {
    exitCode: proc.exitCode,
    stdout: normalize(scratch.home, proc.stdout),
    stderr: proc.stderr,
  };
}

/** The new spelling prints what the base's old spelling printed. `respell` edits the oracle's
 *  stdout first, for a hint inside it that names a moved spelling. An oracle of exit 1 and an
 *  empty stdout would also match a spelling Commander rejected, so a parser refusal fails here. */
export function expectOracle(
  oracle: Oracle,
  oracleKey: string,
  args: string[],
  scratch: ScratchHome,
  respell: (stdout: string) => string = (stdout) => stdout,
): Observation & { stderr: string } {
  const seen = observe(args, scratch);
  const expected = oracle[oracleKey];
  expect(expected, oracleKey).toBeDefined();
  expect(seen.stderr, args.join(" ")).not.toMatch(/error: unknown (command|option)/);
  expect({ exitCode: seen.exitCode, stdout: seen.stdout }, `${oracleKey}  ->  ${args.join(" ")}`)
    .toEqual({ exitCode: expected?.exitCode, stdout: respell(expected?.stdout ?? "") });
  return seen;
}

/** Every file under `home` by relative path with its content, paths normalized, so two homes
 *  compare equal when the same files were written with the same content. */
export function treeContents(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(home, path), normalize(home, readFileSync(path, "utf8")));
    }
  };
  walk(home);
  return out;
}

/** Two spellings in twin homes: same exit code, same stdout, same stderr, same files. Returns the
 *  first observation so the caller can prove the pair did the thing (identical failures would pass
 *  the equality alone). */
export function expectIdentical(
  a: { args: string[]; scratch: ScratchHome },
  b: { args: string[]; scratch: ScratchHome },
): Observation & { stderr: string } {
  const label = `${a.args.join(" ")}  ==  ${b.args.join(" ")}`;
  const seenA = observe(a.args, a.scratch);
  const seenB = observe(b.args, b.scratch);
  expect(seenB.exitCode, label).toBe(seenA.exitCode);
  expect(seenB.stdout, label).toBe(seenA.stdout);
  expect(normalize(b.scratch.home, seenB.stderr), label).toBe(
    normalize(a.scratch.home, seenA.stderr),
  );
  expect([...treeContents(b.scratch.home).entries()], label).toEqual(
    [...treeContents(a.scratch.home).entries()],
  );
  return seenA;
}
