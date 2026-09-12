import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  CHILD_VALUES,
  childValuesEnv,
  denoRunArgs,
  importSpecifier,
  ROOT,
  runSync,
  spawnChild,
} from "./helpers/run.ts";
import { expect, removeDir, tempDir, test } from "./helpers/testing.ts";

// tempDir is the suite's one way to a temp directory, and removing the isolate root is what
// covers every fixture. The guarantees that make that hold are pinned here, not assumed.

/** Proven absence: lstat says ENOENT (a lookup that fails otherwise is an error, not a no). */
function gone(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

const TESTING_MODULE = importSpecifier(join(ROOT, "test", "helpers", "testing.ts"));

test("tempDir: every directory lands directly under one root, and a prefix cannot escape it", () => {
  const a = tempDir("copilot-temp-a-");
  const b = tempDir("copilot-temp-b-");
  expect(dirname(a)).toBe(dirname(b));
  expect(gone(a)).toBe(false);
  // An empty or dotted prefix would name the root itself and land the directory beside it; a
  // climbing one would leave it. All are refused before anything is created.
  for (const prefix of ["", ".", "..", "../escape-", "nested/dir-"]) {
    expect(() => tempDir(prefix), JSON.stringify(prefix)).toThrow(/direct child of the root/);
  }
});

test("removeDir: only the path's absence counts as removed", () => {
  const dir = tempDir("copilot-temp-rm-");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "file"), "x");
  expect(removeDir(dir)).toBe("");
  expect(gone(dir)).toBe(true);
  // Already gone is success too (force semantics), and "" is the documented no-op.
  expect(removeDir(dir)).toBe("");
  expect(removeDir("")).toBe("");
});

test(
  "a failing test module's fixtures go with its root, nested inside the spawning isolate's",
  () => {
    // The child module FAILS on purpose: a failing module is the case the guarantee exists for.
    const scratch = tempDir("copilot-temp-runner-");
    const module = join(scratch, "leaky.test.ts");
    const record = join(scratch, "made.txt");
    writeFileSync(
      module,
      [
        `import { tempDir, test } from ${TESTING_MODULE};`,
        'test("leaves a fixture behind and fails", () => {',
        `  Deno.writeTextFileSync(${CHILD_VALUES}.record, tempDir("copilot-temp-leaked-"));`,
        '  throw new Error("boom");',
        "});",
        "",
      ].join("\n"),
    );
    const res = runSync(
      Deno.execPath(),
      ["test", "--config", join(ROOT, "deno.json"), "-P=test", module],
      { env: { ...process.env, ...childValuesEnv({ record }) } },
    );
    expect(res.exitCode, res.stderr).toBe(1);
    const made = readFileSync(record, "utf8");
    expect(made).toContain("copilot-temp-leaked-");
    // Gone with the child's own root at its unload; nothing waited on this process for it.
    expect(gone(made)).toBe(true);
    expect(gone(dirname(made))).toBe(true);
    // And that root was a child of THIS isolate's root, so a child killed before its unload
    // would have gone with ours instead.
    expect(dirname(dirname(made))).toBe(dirname(scratch));
  },
  60_000,
);

test(
  "a child killed before its unload left its root inside ours, where our removal reaches it",
  async () => {
    const scratch = tempDir("copilot-temp-killed-");
    const script = join(scratch, "linger.ts");
    const record = join(scratch, "made.txt");
    writeFileSync(
      script,
      [
        `import { tempDir } from ${TESTING_MODULE};`,
        `Deno.writeTextFileSync(${CHILD_VALUES}.record, tempDir("copilot-temp-lingering-"));`,
        "setInterval(() => {}, 60_000);",
        "",
      ].join("\n"),
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
      env: childValuesEnv({ record }),
      stdout: "null",
      stderr: "null",
    });
    try {
      const deadline = Date.now() + 30_000;
      while (gone(record) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const made = readFileSync(record, "utf8");
      expect(made).toContain("copilot-temp-lingering-");
      expect(gone(made)).toBe(false);
      expect(dirname(dirname(made))).toBe(dirname(scratch));
    } finally {
      child.kill("SIGKILL");
      await child.status;
    }
  },
  60_000,
);

test("a child under a fixture HOME reads the pinned module cache, never one derived from the HOME", () => {
  const home = tempDir("copilot-temp-home-");
  const res = runSync(Deno.execPath(), ["eval", 'console.log(Deno.env.get("DENO_DIR"))'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const pinned = process.env.DENO_DIR ?? "";
  expect(isAbsolute(pinned)).toBe(true);
  expect(res.stdout.trim()).toBe(pinned);
  expect(pinned.startsWith(home)).toBe(false);
});
