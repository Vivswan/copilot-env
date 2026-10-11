// The preload guard (test/helpers/home_guard.ts) is a check with no voice of its own: every file
// the launcher runs passes it, so a guard that stopped comparing would pass every run exactly as
// a working one does. This is its negative control, through the path a bare `bun test <file>`
// takes: the test body must never run, and the one-line reason must name the launcher command.
// The matching declaration is the positive control through the same path.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, runSync } from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

const HOME_ENV = process.platform === "win32" ? "USERPROFILE" : "HOME";
const TEST_HOME_ENV = "COPILOT_ENV_TEST_HOME";

/** A test file that leaves a marker when its body runs, so "the body never ran" is a fact on
 *  disk and not an exit code. */
function markingTest(dir: string): { file: string; marker: string } {
  const marker = join(dir, "body-ran");
  const file = join(dir, "marking.test.ts");
  writeFileSync(
    file,
    [
      'import { writeFileSync } from "node:fs";',
      'import { test } from "bun:test";',
      `test("marks", () => { writeFileSync(${JSON.stringify(marker)}, ""); });`,
      "",
    ].join("\n"),
  );
  return { file, marker };
}

test("a bare `bun test` runs only under the HOME that COPILOT_ENV_TEST_HOME names", () => {
  const home = tempDir("home-guard-home-");
  const other = tempDir("home-guard-other-");
  const rows = [
    { name: "undeclared", env: { [HOME_ENV]: home, [TEST_HOME_ENV]: undefined }, runs: false },
    {
      name: "another dir declared",
      env: { [HOME_ENV]: home, [TEST_HOME_ENV]: other },
      runs: false,
    },
    { name: "empty HOME", env: { [HOME_ENV]: "", [TEST_HOME_ENV]: home }, runs: false },
    { name: "declared", env: { [HOME_ENV]: home, [TEST_HOME_ENV]: home }, runs: true },
  ];
  const seen = rows.map(({ name, env, runs }) => {
    const { file, marker } = markingTest(tempDir("home-guard-case-"));
    const res = runSync(process.execPath, ["test", "--no-env-file", file], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    return {
      name,
      runs,
      ran: existsSync(marker),
      passed: res.exitCode === 0,
      named: runs || res.stderr.includes("bun run test:unit"),
    };
  });
  expect(seen).toEqual(
    rows.map(({ name, runs }) => ({ name, runs, ran: runs, passed: runs, named: true })),
  );
}, 60_000);
