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
} from "../src/utils/command.ts";
import { afterEach, expect, tempDir, test } from "./helpers/testing.ts";

const SEP = process.platform === "win32" ? ";" : ":";

const SAVED_PATH = process.env.PATH;
const HAD_PATH_CASE = Object.hasOwn(process.env, "Path");
const SAVED_PATH_CASE = process.env.Path;

afterEach(() => {
  process.env.PATH = SAVED_PATH;
  if (HAD_PATH_CASE) process.env.Path = SAVED_PATH_CASE;
  else delete process.env.Path;
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
  expect(commandLookFromSpawn({ status: 0 }, resolved)).toEqual({ path: "/bin/gh" });
  expect(commandLookFromSpawn({ status: 1 }, resolved)).toEqual({ path: null });
  // A probe that never completed is the marked failed look, never a proven absence (the runCaptured mark contract).
  expect(commandLookFromSpawn({ status: null, error: new Error("ENOENT") }, resolved)).toEqual({
    path: null,
    launchFailed: true,
  });
  expect(commandLookFromSpawn({ status: null }, resolved)).toEqual({
    path: null,
    launchFailed: true,
  });
});

// The real lookup argv against the real probe shell: a completed look is unmarked either way.
test("findCommand: a real found command and a real proven absence, both unmarked", () => {
  // The probe shell itself is always findable where the probe can run at all.
  const found = findCommand(process.platform === "win32" ? "powershell" : "sh");
  expect(found.path).toBeTruthy();
  expect(found.launchFailed).toBeUndefined();
  expect(findCommand("copilot-env-no-such-command-xyz")).toEqual({ path: null });
});

test("runCaptured: the launch-failure mark rides ONLY the synthesized exit", async () => {
  const ok = await runCaptured(process.execPath, ["eval", "console.log('ok')"]);
  expect(ok.exitCode).toBe(0);
  expect(ok.launchFailed).toBeUndefined();
  expect(ok.stdout.trim()).toBe("ok");

  // The child's OWN nonzero exit is a completed look: pgrep's "ran, found nothing" exit 1 rides exactly here.
  const ranNonzero = await runCaptured(process.execPath, ["eval", "Deno.exit(1)"]);
  expect(ranNonzero.exitCode).toBe(1);
  expect(ranNonzero.launchFailed).toBeUndefined();

  // ENOENT coerces to the SAME exit 1; the mark is the only thing separating it from a real exit 1.
  const missing = await runCaptured(join(tempDir("copilot-env-no-such-tool-"), "missing"), []);
  expect(missing.exitCode).toBe(1);
  expect(missing.launchFailed).toBe(true);
});
