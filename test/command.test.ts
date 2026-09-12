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

test("childPathPrepending puts dirs first, deduped, preserving the rest of PATH", () => {
  process.env.PATH = `/usr/bin${SEP}/bin`;
  const out = childPathPrepending(["/opt/gh/bin", "/opt/gh/bin", null]);
  expect(out.split(SEP)).toEqual(["/opt/gh/bin", "/usr/bin", "/bin"]);
});

test("childEnvWithPath prepends dirs to PATH and keeps other inherited vars", () => {
  process.env.PATH = `/usr/bin${SEP}/bin`;
  process.env.COPILOT_TEST_LEAK = "keep-me";
  const env = childEnvWithPath(["/opt/cli/bin"]);
  expect(env.PATH?.split(SEP)[0]).toBe("/opt/cli/bin");
  expect(env.PATH).toContain("/usr/bin");
  expect(env.COPILOT_TEST_LEAK).toBe("keep-me");
});

test("childEnvWithPath drops any case-variant PATH key (the Windows Path/PATH collision)", () => {
  // The Windows shape: process.env carries `Path` while we set canonical PATH; the child gets exactly one.
  process.env.Path = "C:\\stale\\only";
  const env = childEnvWithPath(["/new/dir"]);
  expect(Object.hasOwn(env, "Path")).toBe(false);
  expect(env.PATH?.split(SEP)[0]).toBe("/new/dir");
  expect(env.PATH).not.toBe("C:\\stale\\only");
});

test("childEnvWithPath applies extra and honors the omit predicate (case-insensitive)", () => {
  // The predicate sees the UPPERCASED key, mirroring Windows' case-insensitive env names; the
  // original-cased key is what gets dropped.
  process.env.Copilot_Mixed_Var = "leaked";
  const env = childEnvWithPath([], {
    extra: { HOME_OVERRIDE: "/tmp/h" },
    omit: (upper) => upper === "COPILOT_MIXED_VAR",
  });
  expect(env.HOME_OVERRIDE).toBe("/tmp/h");
  expect(Object.hasOwn(env, "Copilot_Mixed_Var")).toBe(false);
});

// cmd.exe expands %VAR% even inside double quotes, so the Windows dispatch may fall back to it only
// for a batch-ONLY shim. The picker is pure, so the whole decision table runs on every platform.

const PS_PREFIX = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];
const ARGS = ["--resume", "%USERPROFILE%", "x y"];

test("pickVerbatimWindowsSpawn: a native .exe spawns directly with plain argv", () => {
  const picked = pickVerbatimWindowsSpawn(
    "claude",
    ["C:\\apps\\claude.exe", "C:\\npm\\claude.cmd"],
    ARGS,
    () => true,
  );
  expect(picked.file).toBe("C:\\apps\\claude.exe");
  expect(picked.args).toEqual(ARGS);
  expect(picked.shell).toBe(false);
  expect(picked.binDir).toBe("C:\\apps");
});

test("pickVerbatimWindowsSpawn: the npm .ps1 shim runs via powershell -File (literal argv)", () => {
  const direct = pickVerbatimWindowsSpawn("claude", ["C:\\npm\\claude.ps1"], ARGS, () => false);
  expect(direct.file).toBe("powershell");
  expect(direct.args).toEqual([...PS_PREFIX, "C:\\npm\\claude.ps1", ...ARGS]);
  expect(direct.shell).toBe(false);
  expect(direct.binDir).toBe("C:\\npm");

  // A .cmd candidate with the .ps1 sibling npm always ships: prefer the sibling.
  const sibling = pickVerbatimWindowsSpawn(
    "claude",
    ["C:\\npm\\claude", "C:\\npm\\claude.cmd"],
    ARGS,
    (path) => path === "C:\\npm\\claude.ps1",
  );
  expect(sibling.file).toBe("powershell");
  expect(sibling.args).toEqual([...PS_PREFIX, "C:\\npm\\claude.ps1", ...ARGS]);
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

test("pickVerbatimWindowsSpawn: batch-only shims and no-candidate fall back to cmd.exe quoting", () => {
  const batchOnly = pickVerbatimWindowsSpawn(
    "claude",
    ["C:\\hand tools\\claude.cmd"],
    ["a b"],
    () => false,
  );
  expect(batchOnly.file).toBe('"C:\\hand tools\\claude.cmd"');
  expect(batchOnly.shell).toBe(true); // cmd.exe: batch parsing is that shim's own semantics
  expect(batchOnly.args).toEqual(['"a b"']);
  expect(batchOnly.binDir).toBe("C:\\hand tools"); // the real directory, never the quoted form

  const none = pickVerbatimWindowsSpawn("claude", [], ["a"], () => false);
  expect(none.file).toBe("claude");
  expect(none.binDir).toBeNull();
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
