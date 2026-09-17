import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHILD_VALUES, childValuesEnv, importSpecifier, ROOT, runSync } from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// tempDir is the suite's one way to a temp directory, and removing the isolate root is what
// covers every fixture. The guarantee that makes that hold is pinned here, not assumed.

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
