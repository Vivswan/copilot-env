import { expect, test } from "bun:test";

import { computePathRefresh, runShell } from "../src/commands/setup.ts";

// runShell's flag validation throws BEFORE any install or rc wiring, so these
// need no filesystem/network isolation.

test("shell: the CLI-install tuning flags require --clis", () => {
  expect(() => runShell({ cooldown: 7 })).toThrow("require --clis");
  expect(() => runShell({ noSudo: true })).toThrow("require --clis");
  expect(() => runShell({ noPrereqs: true })).toThrow("require --clis");
});

test("shell --clis: --no-sudo and --no-prereqs are mutually exclusive", () => {
  expect(() => runShell({ clis: true, noSudo: true, noPrereqs: true })).toThrow(
    "mutually exclusive",
  );
});

test("shell --clis: a non-integer/negative cooldown is rejected", () => {
  expect(() => runShell({ clis: true, cooldown: 1.5 })).toThrow("--cooldown");
  expect(() => runShell({ clis: true, cooldown: -1 })).toThrow("--cooldown");
});

test("shell --clis cannot combine with --remove", () => {
  expect(() => runShell({ clis: true, remove: true })).toThrow("cannot be combined with --remove");
});

// computePathRefresh is the platform-parameterized core of syncNpmGlobalBinToPath:
// it picks the bin dir + PATH separator and produces the Path/PATH assignments.
// Parameterizing on platform lets these run on POSIX CI without win32 gating.

test("computePathRefresh on win32 writes BOTH Path and PATH with ';' and prepends the prefix", () => {
  const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const old = "C:\\Windows;C:\\Windows\\System32";
  const { bin, separator, assignments } = computePathRefresh("win32", prefix, old);

  // On Windows the npm prefix IS the bin dir (no /bin suffix).
  expect(bin).toBe(prefix);
  expect(separator).toBe(";");
  // The deliberate double-key write: both casings are produced.
  expect(Object.keys(assignments).sort()).toEqual(["PATH", "Path"]);
  expect(assignments.Path).toBe(assignments.PATH);
  // The bin dir is prepended, separated by ';', ahead of the old PATH.
  expect(assignments.PATH).toBe(`${prefix};${old}`);
  expect(assignments.PATH?.startsWith(`${prefix};`)).toBe(true);
});

test("computePathRefresh on POSIX uses ':' and a ${prefix}/bin dir, prepended", () => {
  const prefix = "/home/me/.npm-global";
  const old = "/usr/bin:/bin";
  const { bin, separator, assignments } = computePathRefresh("linux", prefix, old);

  expect(bin).toBe(`${prefix}/bin`);
  expect(separator).toBe(":");
  expect(assignments.PATH).toBe(`${prefix}/bin:${old}`);
  expect(assignments.Path).toBe(assignments.PATH);
  // darwin behaves like linux (any non-win32 platform).
  expect(computePathRefresh("darwin", prefix, old).separator).toBe(":");
});

test("computePathRefresh is a no-op when the bin dir is already on PATH", () => {
  const prefix = "/home/me/.npm-global";
  const old = `/home/me/.npm-global/bin:/usr/bin`;
  const { assignments } = computePathRefresh("linux", prefix, old);
  // Already present: nothing to assign, so neither key is rewritten.
  expect(assignments).toEqual({});
});
