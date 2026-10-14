// What CI reads of the launcher is its exit code and its file count: a file whose tests fail must
// fail the run whatever the other files did, a path that names nothing must fail it rather than
// run nothing green, a directory must run as one process PER FILE (handed to `bun test` whole, it
// would run as one), a *.e2e.test.ts file must run in CI and under --e2e only (on a developer
// machine with neither, the run is refused before any test starts, and --unit leaves the file out),
// and a file named outright must match **/*.test.ts, or it reaches `bun test` outside the gate.
// A file that never registers a test (a module-scope await that never settles) is outside bun's
// own --timeout, so the launcher's file budget must end it and fail it, and a file whose process
// ends before bun:test prints its end-of-run summary must fail the run whatever its exit code.
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
    // bun dims the summary's timing under FORCE_COLOR: the launcher still reads the line.
    {
      args: [passing],
      env: { ...OUTSIDE_CI, FORCE_COLOR: "1" },
      exitCode: 0,
      ran: 1,
      failed: none,
      mentions: none,
    },
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

// The exit mechanism is the axis: whatever ends the child before bun:test reports, its exit 0
// says nothing about the tests it never reached, and the failing second test proves they never
// ran. The incident: test/copilot_api/idle_watchdog.test.ts left a process.exit in a microtask
// from the bun move until this guard, and the launcher read its exit 0 as passed.
test("a file whose process exits 0 before bun:test prints its summary fails the run, whichever mechanism ended it", () => {
  const dir = tempDir("run-tests-early-exit-");
  const verdict =
    'exited 0 before bun:test printed its end-of-run summary (no "Ran N tests across 1 file" line), so the tests it never reached were not judged';
  // The timer needs a test still awaiting when it fires: bun runs sync bodies back to back.
  const endings = {
    microtask: 'test("first", () => { Promise.resolve().then(() => process.exit(0)); });',
    timer:
      'test("first", async () => { setTimeout(() => process.exit(0), 0); await Bun.sleep(50); });',
    "module-scope": "process.exit(0);",
  };
  const seen = Object.entries(endings).map(([name, ending]) => {
    const file = join(dir, `${name}.test.ts`);
    writeFileSync(
      file,
      [
        'import { expect, test } from "bun:test";',
        ending,
        'test("never reached", () => { expect(1).toBe(2); });',
        "",
      ].join("\n"),
    );
    const res = runSync(process.execPath, [...bunRunArgs(), LAUNCHER, file], {
      env: { ...process.env, ...OUTSIDE_CI },
      timeoutMs: 60_000,
    });
    return {
      name,
      exitCode: res.exitCode,
      judged: filesRan(res.stdout),
      header: res.stdout.includes(`=== ${file}: failed (exit 1) in `),
      verdict: res.stdout.includes(`${file} ${verdict}`),
      named: res.stdout.includes(`failed: ${file}`),
    };
  });
  expect(seen).toEqual(
    Object.keys(endings).map((name) => ({
      name,
      exitCode: 1,
      judged: 1,
      header: true,
      verdict: true,
      named: true,
    })),
  );
}, 90_000);

// Bun's crash handler labels a panic line by the thread that died: the main thread, a Windows
// thread by id or by name, or a bare "panic: " for a thread on macOS or Linux. The launcher
// joins stdout and stderr chunks in arrival order, so an unterminated stdout line may sit right
// before the panic. A Windows fail-fast prints no line and exits 9 (how
// test/copilot_api/start_port.e2e.test.ts dies on the Windows runner); the same exit off Windows
// is a test's own doing and final.
test("a file whose bun process dies of a runtime crash runs once more, whichever thread the panic line names, or none on a Windows fail-fast; a test failure, a second crash, and an exit 9 off Windows are final", () => {
  const dir = tempDir("run-tests-panic-");
  const retryHeader = (exit: number): string =>
    `died of a Bun runtime crash (exit ${exit}), running it once more`;
  const deaths = {
    main: { line: "panic(main thread): synthetic", exit: 3, rerun: true },
    "thread-id": { line: "panic(thread 7032): synthetic", exit: 3, rerun: true },
    "thread-name": { line: "panic(io thread): synthetic", exit: 3, rerun: true },
    bare: { line: "panic: synthetic", exit: 3, rerun: true },
    "mid-line": { line: "progresspanic: synthetic", exit: 3, rerun: true },
    "fail-fast": { line: "", exit: 9, rerun: process.platform === "win32" },
  };
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  const rows = [
    {
      name: "once",
      crashes: 1,
      expected: 1,
      rerun: { exitCode: 0, runs: 2, retried: 1, header: (): string => "passed" },
    },
    {
      name: "fails",
      crashes: 0,
      expected: 2,
      rerun: { exitCode: 1, runs: 1, retried: 0, header: (): string => "failed (exit 1)" },
    },
    {
      name: "twice",
      crashes: 2,
      expected: 1,
      rerun: {
        exitCode: 1,
        runs: 2,
        retried: 1,
        header: (exit: number): string => `failed (exit ${exit})`,
      },
    },
  ];
  // Every case runs before the one assertion, so a red run names every shape that missed.
  const seen = Object.entries(deaths).flatMap(([shape, death]) =>
    rows.map((row) => {
      const file = join(dir, `${row.name}-${shape}.test.ts`);
      const tally = join(dir, `${row.name}-${shape}.runs`);
      writeFileSync(
        file,
        [
          'import { appendFileSync, readFileSync } from "node:fs";',
          'import { expect, test } from "bun:test";',
          `const values = ${CHILD_VALUES};`,
          'appendFileSync(values.tally, "run\\n");',
          'if (readFileSync(values.tally, "utf8").split("\\n").length - 1 <= values.crashes) {',
          // As data, never source: bun's failure excerpt reprints the source around a failed expect.
          '  if (values.line !== "") console.error(values.line);',
          "  process.exit(values.exit);",
          "}",
          `test(${JSON.stringify(row.name)}, () => { expect(1).toBe(values.expected); });`,
          "",
        ].join("\n"),
      );
      const res = runSync(process.execPath, [...bunRunArgs(), LAUNCHER, file], {
        env: {
          ...process.env,
          ...OUTSIDE_CI,
          ...childValuesEnv({
            tally,
            crashes: row.crashes,
            expected: row.expected,
            line: death.line,
            exit: death.exit,
          }),
        },
        timeoutMs: 60_000,
      });
      const want =
        death.rerun || row.crashes === 0
          ? { ...row.rerun, header: row.rerun.header(death.exit) }
          : { exitCode: 1, runs: 1, retried: 0, header: `failed (exit ${death.exit})` };
      return {
        actual: {
          shape,
          name: row.name,
          exitCode: res.exitCode,
          runs: count(readFileSync(tally, "utf8"), "run\n"),
          retried: count(res.stdout, `${file}: ${retryHeader(death.exit)}`),
          linesPrinted: death.line === "" ? 0 : count(res.stdout, death.line),
          header: res.stdout.includes(`=== ${file}: ${want.header} in `),
          judged: filesRan(res.stdout),
        },
        expected: {
          shape,
          name: row.name,
          exitCode: want.exitCode,
          runs: want.runs,
          retried: want.retried,
          linesPrinted: death.line === "" ? 0 : Math.min(row.crashes, want.runs),
          header: true,
          judged: 1,
        },
      };
    }),
  );
  expect(seen.map((s) => s.actual)).toEqual(seen.map((s) => s.expected));
}, 120_000);

// External fact nothing here enforces: Bun on macOS can drop a child's exit event (oven-sh/bun#41024),
// and the pair the launcher sets routes every child exit through Bun's waiter thread instead. The
// platform is faked in the launcher process alone (a preload), so the on and off rows run on every
// runner; the fixture `bun test` child reports what reached its env.
test("the launcher's macOS children carry Bun's waiter-thread pair, children elsewhere do not, and a value the parent set is kept", () => {
  const dir = tempDir("run-tests-waiter-");
  const file = join(dir, "env.test.ts");
  const out = join(dir, "env.json");
  const platformPreload = join(dir, "platform.ts");
  writeFileSync(
    file,
    [
      'import { writeFileSync } from "node:fs";',
      'import { test } from "bun:test";',
      'test("env", () => {',
      `  writeFileSync(${CHILD_VALUES}.out, JSON.stringify({`,
      "    gc: process.env.BUN_GARBAGE_COLLECTOR_LEVEL ?? null,",
      "    waiter: process.env.BUN_FEATURE_FLAG_FORCE_WAITER_THREAD ?? null,",
      "  }));",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    platformPreload,
    `Object.defineProperty(process, "platform", { value: ${CHILD_VALUES}.platform });\n`,
  );
  const unset = {
    BUN_GARBAGE_COLLECTOR_LEVEL: undefined,
    BUN_FEATURE_FLAG_FORCE_WAITER_THREAD: undefined,
  };
  const rows = [
    { platform: "darwin", parent: unset, child: { gc: "0", waiter: "1" } },
    { platform: "linux", parent: unset, child: { gc: null, waiter: null } },
    {
      platform: "darwin",
      parent: { BUN_GARBAGE_COLLECTOR_LEVEL: "1", BUN_FEATURE_FLAG_FORCE_WAITER_THREAD: "own" },
      child: { gc: "1", waiter: "own" },
    },
  ];
  const seen = rows.map((row) => {
    writeFileSync(out, "");
    const res = runSync(
      process.execPath,
      [...bunRunArgs("--preload", platformPreload), LAUNCHER, file],
      {
        env: {
          ...process.env,
          ...OUTSIDE_CI,
          ...row.parent,
          ...childValuesEnv({ platform: row.platform, out }),
        },
        timeoutMs: 60_000,
      },
    );
    return {
      platform: row.platform,
      exitCode: res.exitCode,
      judged: filesRan(res.stdout),
      child: JSON.parse(readFileSync(out, "utf8") || "null"),
    };
  });
  expect(seen).toEqual(
    rows.map((row) => ({ platform: row.platform, exitCode: 0, judged: 1, child: row.child })),
  );
}, 90_000);
