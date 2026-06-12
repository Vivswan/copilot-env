import { expect, test } from "bun:test";

import { runShell } from "../src/commands/setup.ts";

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
