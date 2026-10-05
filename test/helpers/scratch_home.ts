// A scratch HOME a CLI child owns entirely, and the twin-home comparison that proves an alias is
// one code path with its verb: two spellings run in two such homes must leave the same exit
// code, output, and files, each home's own path folded to one token.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { agentHomeEnv } from "./env.ts";
import { runCli } from "./run.ts";
import { expect, tempDir } from "./testing.ts";

export interface ScratchHome {
  home: string;
  env: Record<string, string>;
}

export interface Observation {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Its data home, both agent homes, and a port pin that keeps a real proxy on 4141 out of the
 *  picture. */
export function scratchHome(prefix: string): ScratchHome {
  const home = tempDir(prefix);
  writeFileSync(join(home, "state.json"), JSON.stringify({ global: { "daemon.port": 4199 } }));
  return {
    home,
    env: {
      ...process.env,
      CONSOLA_LEVEL: "5",
      NO_COLOR: "1",
      ...agentHomeEnv(home),
    },
  };
}

/** What the outside sees of one spelling. */
export function observe(args: string[], scratch: ScratchHome): Observation {
  return runCli(args, { env: scratch.env });
}

/** A proxy default and a proxy profile `work`, each with a stored token. */
export function seedProxyProfiles(scratch: ScratchHome): void {
  for (
    const args of [
      ["auth", "--set", "ghu_test"],
      ["init", "--proxy"],
      ["profile", "work", "add", "--proxy", "--no-auth"],
      ["profile", "work", "auth", "--set", "ghu_work"],
    ]
  ) {
    expect(observe(args, scratch).exitCode, args.join(" ")).toBe(0);
  }
}

function foldHome(home: string, text: string): string {
  return text.replaceAll(home, "<HOME>");
}

/** Every file under `home` by relative path with its content, the home folded, so two homes
 *  compare equal when the same files were written with the same content. */
export function treeContents(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(home, path), foldHome(home, readFileSync(path, "utf8")));
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
): Observation {
  const label = `${a.args.join(" ")}  ==  ${b.args.join(" ")}`;
  const seenA = observe(a.args, a.scratch);
  const seenB = observe(b.args, b.scratch);
  expect(seenB.exitCode, label).toBe(seenA.exitCode);
  expect(foldHome(b.scratch.home, seenB.stdout), label).toBe(
    foldHome(a.scratch.home, seenA.stdout),
  );
  expect(foldHome(b.scratch.home, seenB.stderr), label).toBe(
    foldHome(a.scratch.home, seenA.stderr),
  );
  expect([...treeContents(b.scratch.home).entries()], label).toEqual(
    [...treeContents(a.scratch.home).entries()],
  );
  return seenA;
}
