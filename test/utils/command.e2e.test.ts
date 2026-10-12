import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  childEnvWithPath,
  childPathPrepending,
  cmdSpawn,
  commandLookFromSpawn,
  findCommand,
  pickVerbatimWindowsSpawn,
  runCaptured,
  verbatimCliSpawn,
  withPowershellChildEnv,
} from "../../src/utils/command.ts";
import { runSync } from "../helpers/run.ts";
import { afterEach, expect, step, tempDir, test } from "../helpers/testing.ts";

const SEP = process.platform === "win32" ? ";" : ":";

const SAVED_PATH = process.env.PATH;
const HAD_PATH_CASE = Object.hasOwn(process.env, "Path");
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

const BASE_PATH = `/usr/bin${SEP}/bin`;

// The parent PATH is pinned per row, so the WHOLE child PATH is asserted, not just its head. A
// key mapped to null must be absent from the child env, not merely empty.
const CHILD_ENV_ROWS: {
  name: string;
  /** Set on process.env before the call; PATH itself is always BASE_PATH, set last. */
  parent: Record<string, string>;
  dirs: (string | null)[];
  opts?: Parameters<typeof childEnvWithPath>[1];
  path: string[];
  keys: Record<string, string | null>;
}[] = [
  {
    name: "dirs go first, ahead of the rest of PATH, and other vars ride along",
    parent: { COPILOT_TEST_LEAK: "keep-me" },
    dirs: ["/opt/cli/bin"],
    path: ["/opt/cli/bin", "/usr/bin", "/bin"],
    keys: { COPILOT_TEST_LEAK: "keep-me" },
  },
  {
    // The Windows shape: process.env carries `Path` while we set canonical PATH; the child gets
    // exactly one, and it is the new one.
    name: "any case-variant PATH key is dropped (the Windows Path/PATH collision)",
    parent: { Path: "C:\\stale\\only" },
    dirs: ["/new/dir"],
    path: ["/new/dir", "/usr/bin", "/bin"],
    keys: { Path: null },
  },
  {
    // The predicate sees the UPPERCASED key, mirroring Windows' case-insensitive env names; the
    // original-cased key is what gets dropped.
    name: "extra is applied and the omit predicate is honored case-insensitively",
    parent: { Copilot_Mixed_Var: "leaked" },
    dirs: [],
    opts: { extra: { HOME_OVERRIDE: "/tmp/h" }, omit: (upper) => upper === "COPILOT_MIXED_VAR" },
    path: ["/usr/bin", "/bin"],
    keys: { HOME_OVERRIDE: "/tmp/h", Copilot_Mixed_Var: null },
  },
];

test("childPathPrepending dedupes the dirs; childEnvWithPath builds the child env on top of it per row", () => {
  process.env.PATH = BASE_PATH;
  const out = childPathPrepending(["/opt/gh/bin", "/opt/gh/bin", null]);
  expect(out.split(SEP)).toEqual(["/opt/gh/bin", "/usr/bin", "/bin"]);

  for (const row of CHILD_ENV_ROWS) {
    for (const [key, value] of Object.entries(row.parent)) process.env[key] = value;
    process.env.PATH = BASE_PATH;
    const env = childEnvWithPath(row.dirs, row.opts);
    const keys = Object.fromEntries(
      Object.keys(row.keys).map((key) => [key, Object.hasOwn(env, key) ? env[key] : null]),
    );
    expect({ name: row.name, path: env.PATH?.split(SEP), keys }).toEqual({
      name: row.name,
      path: row.path,
      keys: row.keys,
    });
  }
});

// The env map is a plain object: on Windows it carries the variable under the casing the runner
// stored it (PSMODULEPATH, PsModulePath), so every read of it goes by case-insensitive match.
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

// cmd.exe expands %VAR% even inside double quotes, so the Windows dispatch may fall back to it only
// for a batch-ONLY shim. The picker is pure, so the whole decision table runs on every platform.

const PS_PREFIX = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];
const ARGS = ["--resume", "%USERPROFILE%", "x y"];

// The decision table: a native .exe spawns directly; an npm .ps1 shim (or the .ps1 sibling npm
// always ships beside a .cmd) runs via powershell -File with literal argv; only a batch-ONLY shim
// or an unresolved command takes the cmd.exe hop, quoted (binDir stays the real directory).
test("pickVerbatimWindowsSpawn: .exe direct, .ps1 (or its sibling) via powershell -File, batch-only and none via cmd.exe", () => {
  const rows: {
    label: string;
    candidates: string[];
    args: string[];
    exists: (path: string) => boolean;
    picked: { file: string; args: string[]; shell: boolean; binDir: string | null };
  }[] = [
    {
      label: "a native .exe spawns directly with plain argv",
      candidates: ["C:\\apps\\claude.exe", "C:\\npm\\claude.cmd"],
      args: ARGS,
      exists: () => true,
      picked: { file: "C:\\apps\\claude.exe", args: ARGS, shell: false, binDir: "C:\\apps" },
    },
    {
      label: "the npm .ps1 shim runs via powershell -File (literal argv)",
      candidates: ["C:\\npm\\claude.ps1"],
      args: ARGS,
      exists: () => false,
      picked: {
        file: "powershell",
        args: [...PS_PREFIX, "C:\\npm\\claude.ps1", ...ARGS],
        shell: false,
        binDir: "C:\\npm",
      },
    },
    {
      label: "a .cmd candidate with the .ps1 sibling npm always ships: prefer the sibling",
      candidates: ["C:\\npm\\claude", "C:\\npm\\claude.cmd"],
      args: ARGS,
      exists: (path) => path === "C:\\npm\\claude.ps1",
      picked: {
        file: "powershell",
        args: [...PS_PREFIX, "C:\\npm\\claude.ps1", ...ARGS],
        shell: false,
        binDir: "C:\\npm",
      },
    },
    {
      label: "a batch-only shim falls back to cmd.exe quoting",
      candidates: ["C:\\hand tools\\claude.cmd"],
      args: ["a b"],
      exists: () => false,
      picked: {
        file: '"C:\\hand tools\\claude.cmd"',
        args: ['"a b"'],
        shell: true,
        binDir: "C:\\hand tools",
      },
    },
    {
      label: "no candidate falls back to the bare command through cmd.exe",
      candidates: [],
      args: ["a"],
      exists: () => false,
      picked: { file: "claude", args: ["a"], shell: true, binDir: null },
    },
  ];
  for (const row of rows) {
    const picked = pickVerbatimWindowsSpawn("claude", row.candidates, row.args, row.exists);
    expect({ label: row.label, picked }).toEqual({ label: row.label, picked: row.picked });
  }
});

test("cmdSpawn quotes the program like every arg, and only when needed", () => {
  // Unquoted, a program path with a space launches `C:\Users\Jane` and fails, with or without args.
  expect(cmdSpawn("C:\\Users\\Jane Doe\\bin\\codex.cmd", [])).toEqual({
    file: '"C:\\Users\\Jane Doe\\bin\\codex.cmd"',
    args: [],
    shell: true,
  });
  expect(cmdSpawn("codex", ["--version", "a b"])).toEqual({
    file: "codex",
    args: ["--version", '"a b"'],
    shell: true,
  });
});

test("verbatimCliSpawn on POSIX resolves the command and never adds a shell", () => {
  if (process.platform === "win32") return; // the Windows half is the pure picker above
  const spawn = verbatimCliSpawn("sh", ["-c", "echo %USERPROFILE%"]);
  expect(spawn.shell).toBe(false);
  expect(spawn.args).toEqual(["-c", "echo %USERPROFILE%"]);
  expect(spawn.file.endsWith("sh")).toBe(true);
});

// --- the command look: a failed probe never reads "command missing" ------------

test("commandLookFromSpawn: only a completed probe yields a proven verdict", () => {
  const resolved = () => "/bin/gh";
  expect(commandLookFromSpawn({ status: 0 }, resolved)).toEqual({ kind: "found", path: "/bin/gh" });
  expect(commandLookFromSpawn({ status: 1 }, resolved)).toEqual({ kind: "absent" });
  // A completed probe that resolved no path is a proven absence too.
  expect(commandLookFromSpawn({ status: 0 }, () => null)).toEqual({ kind: "absent" });
  // A probe that never completed is the failed look, never a proven absence (the runCaptured mark contract).
  expect(commandLookFromSpawn({ status: null, error: new Error("ENOENT") }, resolved)).toEqual({
    kind: "unproven",
  });
  expect(commandLookFromSpawn({ status: null }, resolved)).toEqual({ kind: "unproven" });
});

// The real lookup argv against the real probe shell: a completed look is proven either way.
test("findCommand: a real found command and a real proven absence, both proven", () => {
  // The probe shell itself is always findable where the probe can run at all.
  const found = findCommand(process.platform === "win32" ? "powershell" : "sh");
  expect(found).toMatchObject({ kind: "found" });
  expect(found.kind === "found" && found.path).toBeTruthy();
  expect(findCommand("copilot-env-no-such-command-xyz")).toEqual({ kind: "absent" });
});

// Nothing in the runtime bounds a child, so a probe shell that never returns would hang every
// look. The shim ignores TERM and execs the sleeper under its own pid, so only a KILL ends it.
const HANGING_SHIM = "#!/bin/sh\ntrap '' TERM\nexec sleep 20\n";

test.skipIf(process.platform === "win32")(
  "findCommand: a probe shell that never exits reads as unproven at the bound, never as absent",
  () => {
    const bin = tempDir("copilot-env-hanging-sh-");
    writeFileSync(join(bin, "sh"), HANGING_SHIM, { mode: 0o755 });
    process.env.PATH = childPathPrepending([bin]);
    const started = performance.now();
    const look = findCommand("gh");
    const elapsed = performance.now() - started;
    // Control: a missing shell fails in milliseconds; only the bound ending a live child takes
    // seconds, and it must end it well before a caller's own deadline would.
    expect({ look, waited: elapsed > 1000 && elapsed < 15_000 }).toEqual({
      look: { kind: "unproven" },
      waited: true,
    });
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
