import { writeFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import {
  childEnv,
  findCommand,
  runCaptured,
  withPowershellChildEnv,
} from "../../src/utils/command.ts";
import { pathLedBy } from "../helpers/env.ts";
import { runSync } from "../helpers/run.ts";
import { afterEach, expect, step, tempDir, test } from "../helpers/testing.ts";

/** Restored after each case: the rows lead or replace it. */
const SAVED_PATH = process.env.PATH;

/** Whether `Path` was its own key before the run, so the restore deletes it rather than leaving an empty one. */
const HAD_PATH_CASE = Object.hasOwn(process.env, "Path");

/** The `Path` spelling's own value, restored only under HAD_PATH_CASE. */
const SAVED_PATH_CASE = process.env.Path;

// On Windows the two spellings are one variable, so both saves and both restores agree there.
const SAVED_PSMODULEPATH = [
  ["PSModulePath", process.env.PSModulePath],
  ["psmodulepath", process.env.psmodulepath],
] as const;

afterEach(() => {
  process.env.PATH = SAVED_PATH;
  if (HAD_PATH_CASE) process.env.Path = SAVED_PATH_CASE;
  else delete process.env.Path;
  for (const [key, saved] of SAVED_PSMODULEPATH) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  delete process.env.COPILOT_TEST_LEAK;
  delete process.env.Copilot_Mixed_Var;
});

// A key mapped to null must be absent from the child env, not merely empty.
const CHILD_ENV_ROWS: {
  /** The row's label in a failed expectation. */
  name: string;

  /** Set on process.env before the call. */
  parent: Record<string, string>;

  /** childEnv's argument; omitted = the bare call. */
  opts?: Parameters<typeof childEnv>[0];

  /** A thunk where the expectation reads the parent just set. */
  keys: Record<string, string | null> | (() => Record<string, string | null>);

  /** The PATH value under whichever casing the child env carries it. */
  pathAnyCase?: string | null;
}[] = [
  {
    // PATH keeps the parent's own casing (`Path` on Windows), so it is read case-insensitively.
    name: "the parent's vars ride along, PATH untouched",
    parent: { COPILOT_TEST_LEAK: "keep-me" },
    keys: { COPILOT_TEST_LEAK: "keep-me" },
    pathAnyCase: process.env.PATH ?? null,
  },
  {
    // On Windows, whose env names are case-insensitive, setting `Path` set PATH too, so the tail
    // is read once the parent is set.
    name: "a lead dir heads PATH, and every inherited PATH casing is dropped for it",
    parent: { Path: "C:\\stale\\only" },
    opts: { leadPath: ["/opt/gh/bin"] },
    keys: () => ({ Path: null, PATH: `/opt/gh/bin${delimiter}${process.env.PATH ?? ""}` }),
  },
  {
    name: "a given path replaces PATH wholesale (the registry-refreshed one after a Windows install)",
    parent: { Path: "C:\\stale\\only" },
    opts: { path: "/only/this" },
    keys: { Path: null, PATH: "/only/this" },
  },
  {
    // The predicate sees the UPPERCASED key, mirroring Windows' case-insensitive env names; the
    // original-cased key is what gets dropped.
    name: "extra is applied and the omit predicate is honored case-insensitively",
    parent: { Copilot_Mixed_Var: "leaked" },
    opts: { extra: { HOME_OVERRIDE: "/tmp/h" }, omit: (upper) => upper === "COPILOT_MIXED_VAR" },
    keys: { HOME_OVERRIDE: "/tmp/h", Copilot_Mixed_Var: null },
  },
];

test("childEnv copies the parent env, leads or replaces PATH when asked, applies extra, and honors omit case-insensitively", () => {
  for (const row of CHILD_ENV_ROWS) {
    for (const [key, value] of Object.entries(row.parent)) process.env[key] = value;
    const env = childEnv(row.opts);
    const expected = typeof row.keys === "function" ? row.keys() : row.keys;
    const keys = Object.fromEntries(
      Object.keys(expected).map((key) => [key, Object.hasOwn(env, key) ? env[key] : null]),
    );
    expect({ name: row.name, keys }).toEqual({ name: row.name, keys: expected });
    if (row.pathAnyCase !== undefined) {
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
      expect(pathKey === undefined ? null : env[pathKey], row.name).toBe(row.pathAnyCase);
    }
  }
});

// On Windows the map carries the variable under the runner's casing (PSMODULEPATH, PsModulePath): match any case.
const psModulePathIn = (env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => /^psmodulepath$/i.test(key)));

test("withPowershellChildEnv: a 5.1 child sees no PSModulePath under any casing, a pwsh child the parent's own, and the parent's env is never touched", () => {
  process.env.PSModulePath = "/pwsh/Modules";
  // One key on Windows, where env names are case-insensitive; a second casing elsewhere.
  if (process.platform !== "win32") process.env.psmodulepath = "/pwsh/modules";
  const parentOwn = psModulePathIn(process.env);
  // The map is what a spawn passes as the child's whole env; the parent's own is left as is.
  const childSees = (env: Record<string, string>) =>
    runSync(process.execPath, ["-e", 'console.log(process.env.PSModulePath ?? "")'], {
      env,
    }).stdout.trim();

  const desktop = withPowershellChildEnv("powershell", (env) => ({
    map: psModulePathIn(env),
    child: childSees(env),
  }));
  expect(desktop).toEqual({ map: {}, child: "" });
  const core = withPowershellChildEnv("pwsh", (env) => ({
    map: psModulePathIn(env),
    child: childSees(env),
  }));
  expect(core).toEqual({ map: parentOwn, child: "/pwsh/Modules" });
  expect(psModulePathIn(process.env)).toEqual(parentOwn);
});

// --- the command look ------------------------------------------------------------

// Bun.which is the look: no spawned probe, so a look cannot fail, and the answer is the path the
// vendors' binaries are proven and spawned at. The PATH argument is what an installer-refreshed
// PATH rides in on.
test("findCommand: a real command answers its full path, a missing one is a proven absence, and the PATH given is the one walked", () => {
  const shell = process.platform === "win32" ? "powershell" : "sh";
  const found = findCommand(shell);
  expect(found.kind).toBe("found");
  if (found.kind === "found") expect(resolve(found.path)).toBe(found.path);
  expect(findCommand("copilot-env-no-such-command-xyz")).toEqual({ kind: "absent" });
  expect(findCommand(shell, "")).toEqual({ kind: "absent" });

  step("a fixture shim is found through the PATH given, not the process's");
  const bin = tempDir("copilot-env-look-");
  const name = process.platform === "win32" ? "copilot-env-shim.cmd" : "copilot-env-shim";
  writeFileSync(join(bin, name), process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", {
    mode: 0o755,
  });
  expect(findCommand("copilot-env-shim")).toEqual({ kind: "absent" });
  expect(findCommand("copilot-env-shim", pathLedBy(bin))).toEqual({
    kind: "found",
    path: join(bin, name),
  });
});

// `PATH=tools:...` is legal and dash-era `command -v` answered it relative; Bun.which joins a
// relative entry with cwd on POSIX, so the answer a child spawned from another cwd gets is still
// the file.
test.skipIf(process.platform === "win32")(
  "findCommand: a relative PATH entry answers an absolute path on POSIX",
  () => {
    const bin = tempDir("copilot-env-relative-look-");
    writeFileSync(join(bin, "copilot-env-rel"), "#!/bin/sh\n", { mode: 0o755 });
    const look = findCommand("copilot-env-rel", relative(process.cwd(), bin));
    expect(look.kind === "found" ? resolve(look.path) : look).toBe(join(bin, "copilot-env-rel"));
  },
);

test("runCaptured: the launch-failure mark rides ONLY the synthesized exit", async () => {
  step("a child that prints ok");
  const ok = await runCaptured(process.execPath, ["-e", "console.log('ok')"], { timeoutMs: 5000 });
  expect(ok.exitCode).toBe(0);
  expect(ok.launchFailed).toBeUndefined();
  expect(ok.stdout.trim()).toBe("ok");

  // The child's OWN nonzero exit is a completed look: pgrep's "ran, found nothing" exit 1 rides exactly here.
  step("a child that exits 1");
  const ranNonzero = await runCaptured(process.execPath, ["-e", "process.exit(1)"], {
    timeoutMs: 5000,
  });
  expect(ranNonzero.exitCode).toBe(1);
  expect(ranNonzero.launchFailed).toBeUndefined();

  // ENOENT coerces to the SAME exit 1; the mark is the only thing separating it from a real exit 1.
  step("an executable that does not exist");
  const missing = await runCaptured(join(tempDir("copilot-env-no-such-tool-"), "missing"), [], {
    timeoutMs: 5000,
  });
  expect(missing.exitCode).toBe(1);
  expect(missing.launchFailed).toBe(true);

  // Nothing in the runtime bounds a child, and a TERM handler would hold off a polite kill: the
  // bound ends the look with the same mark, well inside any caller's own deadline.
  step("a child that never exits and ignores TERM");
  const started = performance.now();
  const hung = await runCaptured(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { timeoutMs: 500 },
  );
  expect({ ...hung, inBound: performance.now() - started < 5000 }).toEqual({
    exitCode: 1,
    stdout: "",
    launchFailed: true,
    inBound: true,
  });
});
