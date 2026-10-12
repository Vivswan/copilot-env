// What CI reads of the launcher is its exit code and its file count: a file whose tests fail must
// fail the run whatever the other files did, a path that names nothing must fail it rather than
// run nothing green, a directory must run as one process PER FILE (handed to `bun test` whole, it
// would run as one), a *.e2e.test.ts file must run in CI and under --e2e only (on a developer
// machine with neither, the run is refused before any test starts, and --unit leaves the file out),
// and a file named outright must match **/*.test.ts, or it reaches `bun test` outside the gate.
// A file that never registers a test (a module-scope await that never settles) is outside bun's
// own --timeout, so the launcher's file budget must end it and fail it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../../src/utils/pid.ts";
import { bunRunArgs, CHILD_VALUES, childValuesEnv, ROOT, runSync } from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

const LAUNCHER = join(ROOT, "scripts", "run_tests.ts");
const FILE_BUDGET_ENV = "COPILOT_ENV_TEST_FILE_BUDGET_MS";

/** The CI markers the launcher reads, each absent: a run of this file in CI must not open the
 *  gate for the rows that expect it shut. */
const OUTSIDE_CI = { GITHUB_ACTIONS: undefined, CI: undefined };

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

test("the launcher's exit code and file count over files, a directory, a missing path, and the e2e gate", () => {
  const dir = tempDir("run-tests-");
  const passing = testFile(dir, "passing.test.ts", 1);
  const failing = testFile(dir, "failing.test.ts", 2);
  const realistic = testFile(dir, "realistic.e2e.test.ts", 1);
  // A real test body under a name outside **/*.test.ts: discovery never finds it, and a name
  // without the suffix is also outside the e2e gate's reach.
  const spec = testFile(dir, "example.e2e.spec.ts", 1);
  const none: string[] = [];
  const rows = [
    { args: [passing], env: OUTSIDE_CI, exitCode: 0, ran: 1, failed: none, mentions: none },
    {
      args: [passing, failing],
      env: OUTSIDE_CI,
      exitCode: 1,
      ran: 2,
      failed: [failing],
      mentions: none,
    },
    {
      args: [join(dir, "absent.test.ts")],
      env: OUTSIDE_CI,
      exitCode: 2,
      ran: 0,
      failed: none,
      mentions: none,
    },
    // The directory holds an e2e file: shut outside CI, open under either marker or the flag.
    {
      args: [dir],
      env: OUTSIDE_CI,
      exitCode: 2,
      ran: 0,
      failed: none,
      mentions: ["--e2e", "test:unit"],
    },
    {
      args: [dir],
      env: { ...OUTSIDE_CI, CI: "true" },
      exitCode: 1,
      ran: 3,
      failed: [failing],
      mentions: none,
    },
    {
      args: [dir],
      env: { ...OUTSIDE_CI, GITHUB_ACTIONS: "true" },
      exitCode: 1,
      ran: 3,
      failed: [failing],
      mentions: none,
    },
    {
      args: ["--e2e", dir],
      env: OUTSIDE_CI,
      exitCode: 1,
      ran: 3,
      failed: [failing],
      mentions: none,
    },
    // A file named outright is gated the same way.
    { args: [realistic], env: OUTSIDE_CI, exitCode: 2, ran: 0, failed: none, mentions: ["--e2e"] },
    {
      args: ["--e2e", realistic],
      env: OUTSIDE_CI,
      exitCode: 0,
      ran: 1,
      failed: none,
      mentions: none,
    },
    // A file outside the name rule is refused whatever the flags: never handed to `bun test`.
    {
      args: [spec],
      env: OUTSIDE_CI,
      exitCode: 2,
      ran: 0,
      failed: none,
      mentions: ["example.e2e.spec.ts"],
    },
    {
      args: ["--e2e", spec],
      env: OUTSIDE_CI,
      exitCode: 2,
      ran: 0,
      failed: none,
      mentions: ["example.e2e.spec.ts"],
    },
    // --unit: the e2e file is left out of a directory and refused when named.
    {
      args: ["--unit", dir],
      env: OUTSIDE_CI,
      exitCode: 1,
      ran: 2,
      failed: [failing],
      mentions: none,
    },
    {
      args: ["--unit", realistic],
      env: OUTSIDE_CI,
      exitCode: 2,
      ran: 0,
      failed: none,
      mentions: [".e2e.test.ts"],
    },
    {
      args: ["--unit", "--e2e", dir],
      env: OUTSIDE_CI,
      exitCode: 2,
      ran: 0,
      failed: none,
      mentions: none,
    },
    {
      args: ["--help"],
      env: OUTSIDE_CI,
      exitCode: 0,
      ran: 0,
      failed: none,
      mentions: ["--unit", "--e2e"],
    },
  ];
  for (const { args, env, exitCode, ran, failed, mentions } of rows) {
    const res = runSync(process.execPath, [...bunRunArgs(), LAUNCHER, ...args], {
      env: { ...process.env, ...env },
    });
    const named = failed.filter((file) => res.stdout.includes(`failed: ${file}`));
    const text = res.stdout + res.stderr;
    const mentioned = mentions.filter((word) => text.includes(word));
    expect({ args, exitCode: res.exitCode, ran: filesRan(res.stdout), named, mentioned }).toEqual({
      args,
      exitCode,
      ran,
      named: failed,
      mentioned: mentions,
    });
  }
}, 180_000);

// The hanging file first spawns a detached sleeper, the shape of a daemon a test launched and
// never tore down: the budget kill must end the whole tree, not the one bun test pid.
test("a file that hangs before registering a test is killed with its tree at the file budget and fails the run", () => {
  const dir = tempDir("run-tests-hang-");
  const hanging = join(dir, "hanging.test.ts");
  const pidFile = join(dir, "sleeper.pid");
  writeFileSync(
    hanging,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'import "bun:test";',
      'const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {',
      "  detached: true,",
      '  stdio: "ignore",',
      "});",
      "sleeper.unref();",
      `writeFileSync(${CHILD_VALUES}.pidFile, String(sleeper.pid));`,
      "await new Promise(() => {});",
      "",
    ].join("\n"),
  );
  const res = runSync(process.execPath, [...bunRunArgs(), LAUNCHER, hanging], {
    env: {
      ...process.env,
      ...OUTSIDE_CI,
      ...childValuesEnv({ pidFile }),
      [FILE_BUDGET_ENV]: "2000",
    },
    timeoutMs: 60_000,
  });
  const sleeper = Number(readFileSync(pidFile, "utf8"));
  expect({
    exitCode: res.exitCode,
    ran: filesRan(res.stdout),
    named: res.stdout.includes(`failed: ${hanging}`),
    budgetNamed: res.stdout.includes("ran past the launcher's file budget"),
    sleeperAlive: pidAlive(sleeper),
  }).toEqual({ exitCode: 1, ran: 1, named: true, budgetNamed: true, sleeperAlive: false });
}, 90_000);

// Bun 1.4.2 segfaults on the Windows runner ("panic(main thread): Segmentation fault", exit 3)
// under a file that is otherwise green, about one run in three. The two controls keep a flaky
// TEST from hiding behind the retry: a plain failure runs once, a second panic is final.
test("a file whose bun process dies of a runtime panic runs once more; a test failure and a second panic are final", () => {
  const dir = tempDir("run-tests-panic-");
  const retryHeader = "died of a Bun runtime panic (exit 3), running it once more";
  const panicLine = "panic(main thread): synthetic";
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  const rows = [
    { name: "once", panics: 1, expected: 1, exitCode: 0, runs: 2, retried: 1, header: "passed" },
    {
      name: "fails",
      panics: 0,
      expected: 2,
      exitCode: 1,
      runs: 1,
      retried: 0,
      header: "failed (exit 1)",
    },
    {
      name: "twice",
      panics: 2,
      expected: 1,
      exitCode: 1,
      runs: 2,
      retried: 1,
      header: "failed (exit 3)",
    },
  ];
  for (const row of rows) {
    const file = join(dir, `${row.name}.test.ts`);
    const tally = join(dir, `${row.name}.runs`);
    writeFileSync(
      file,
      [
        'import { appendFileSync, readFileSync } from "node:fs";',
        'import { expect, test } from "bun:test";',
        `const values = ${CHILD_VALUES};`,
        'appendFileSync(values.tally, "run\\n");',
        'if (readFileSync(values.tally, "utf8").split("\\n").length - 1 <= values.panics) {',
        // Spliced from two halves: bun's failure excerpt reprints the source around a failed
        // expect, and the marker must appear in the output only when the fixture printed it.
        `  console.error(${JSON.stringify(panicLine.slice(0, 9))} + ${JSON.stringify(panicLine.slice(9))});`,
        "  process.exit(3);",
        "}",
        `test(${JSON.stringify(row.name)}, () => { expect(1).toBe(values.expected); });`,
        "",
      ].join("\n"),
    );
    const res = runSync(process.execPath, [...bunRunArgs(), LAUNCHER, file], {
      env: {
        ...process.env,
        ...OUTSIDE_CI,
        ...childValuesEnv({ tally, panics: row.panics, expected: row.expected }),
      },
      timeoutMs: 60_000,
    });
    expect({
      name: row.name,
      exitCode: res.exitCode,
      runs: count(readFileSync(tally, "utf8"), "run\n"),
      retried: count(res.stdout, `${file}: ${retryHeader}`),
      panicsPrinted: count(res.stdout, panicLine),
      header: res.stdout.includes(`=== ${file}: ${row.header} in `),
      judged: filesRan(res.stdout),
    }).toEqual({
      name: row.name,
      exitCode: row.exitCode,
      runs: row.runs,
      retried: row.retried,
      panicsPrinted: row.panics,
      header: true,
      judged: 1,
    });
  }
}, 120_000);
