import {
  childEnvWithPath,
  childPathPrepending,
  pickVerbatimWindowsSpawn,
  verbatimCliSpawn,
} from "../src/utils/command.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

const SEP = process.platform === "win32" ? ";" : ":";

// Save/restore the env keys these tests poke so they never leak between tests.
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
  // Simulate the Windows shape: process.env carries a `Path` key AND we set canonical PATH.
  // The child env must end up with EXACTLY one PATH (`PATH`), never the stale `Path`.
  process.env.Path = "C:\\stale\\only";
  const env = childEnvWithPath(["/new/dir"]);
  expect(Object.hasOwn(env, "Path")).toBe(false);
  expect(env.PATH?.split(SEP)[0]).toBe("/new/dir");
  expect(env.PATH).not.toBe("C:\\stale\\only");
});

test("childEnvWithPath applies extra and honors the omit predicate (case-insensitive)", () => {
  // The predicate receives the UPPERCASED key, so a mixed-case inherited var is matched by its
  // uppercase form -- mirroring Windows' case-insensitive env names. The original-cased key must
  // be dropped from the child env.
  process.env.Copilot_Mixed_Var = "leaked";
  const env = childEnvWithPath([], {
    extra: { HOME_OVERRIDE: "/tmp/h" },
    omit: (upper) => upper === "COPILOT_MIXED_VAR",
  });
  expect(env.HOME_OVERRIDE).toBe("/tmp/h");
  expect(Object.hasOwn(env, "Copilot_Mixed_Var")).toBe(false);
});

// --- verbatim agent-CLI spawn ------------------------------------------------
//
// User-typed launch args must reach the agent CLI verbatim: cmd.exe expands %VAR%
// even inside double quotes, so the Windows dispatch may only fall back to it for
// a batch-ONLY shim. The picker is pure (candidates + an injected sibling probe),
// so the whole Windows decision table runs on every platform.

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
  expect(picked.args).toEqual(ARGS); // untouched: no quoting layer at all
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
  // The extensionless npm sh script was skipped, not spawned.
});

test("pickVerbatimWindowsSpawn: batch-only shims and no-candidate fall back to cmd.exe quoting", () => {
  const batchOnly = pickVerbatimWindowsSpawn(
    "claude",
    ["C:\\hand\\claude.cmd"],
    ["a b"],
    () => false,
  );
  expect(batchOnly.file).toBe("C:\\hand\\claude.cmd");
  expect(batchOnly.shell).toBe(true); // cmd.exe: batch parsing is that shim's own semantics
  expect(batchOnly.args).toEqual(['"a b"']);
  expect(batchOnly.binDir).toBe("C:\\hand");

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
