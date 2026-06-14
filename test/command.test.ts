import { afterEach, expect, test } from "bun:test";

import { childEnvWithPath, childPathPrepending } from "../src/utils/command.ts";

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
