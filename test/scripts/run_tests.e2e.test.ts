// What CI reads of the launcher is its exit code and its file count: a file whose tests fail must
// fail the run whatever the other files did, a path that names nothing must fail it rather than
// run nothing green, and a directory must run as one process PER FILE (handed to `bun test`
// whole, it would run as one).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunRunArgs, ROOT, runSync } from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

const LAUNCHER = join(ROOT, "scripts", "run_tests.ts");

function testFile(dir: string, name: string, expected: number): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      'import { expect, test } from "bun:test";',
      `test(${JSON.stringify(name)}, () => { expect(1).toBe(${expected}); });`,
      "",
    ].join("\n"),
  );
  return path;
}

/** The summary line's file count, 0 when the run printed none. */
function filesRan(stdout: string): number {
  return Number(/^(\d+) test files:/m.exec(stdout)?.[1] ?? 0);
}

test("the launcher's exit code and file count over files, a directory, and a missing path", () => {
  const dir = tempDir("run-tests-");
  const passing = testFile(dir, "passing.test.ts", 1);
  const failing = testFile(dir, "failing.test.ts", 2);
  const rows = [
    { paths: [passing], exitCode: 0, ran: 1, failed: [] as string[] },
    { paths: [passing, failing], exitCode: 1, ran: 2, failed: [failing] },
    { paths: [dir], exitCode: 1, ran: 2, failed: [failing] },
    { paths: [join(dir, "absent.test.ts")], exitCode: 2, ran: 0, failed: [] as string[] },
  ];
  for (const { paths, exitCode, ran, failed } of rows) {
    const res = runSync(process.execPath, [...bunRunArgs(), LAUNCHER, ...paths]);
    const named = failed.filter((file) => res.stdout.includes(`failed: ${file}`));
    expect({ paths, exitCode: res.exitCode, ran: filesRan(res.stdout), named }).toEqual({
      paths,
      exitCode,
      ran,
      named: failed,
    });
  }
}, 60_000);
