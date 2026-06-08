import { expect, test } from "bun:test";

import { normalizeSetupClisOptions } from "../src/commands/setup.ts";

test("setup clis defaults to latest npm releases", () => {
  expect(normalizeSetupClisOptions({})).toEqual({
    cooldown: null,
    launchers: false,
    noSudo: false,
    noPrereqs: false,
  });
});

test("setup clis parses cooldown days", () => {
  expect(normalizeSetupClisOptions({ cooldown: 7 })).toEqual({
    cooldown: 7,
    launchers: false,
    noSudo: false,
    noPrereqs: false,
  });
  expect(normalizeSetupClisOptions({ cooldown: 14 }).cooldown).toBe(14);
});

test("setup clis parses launcher wiring", () => {
  expect(normalizeSetupClisOptions({ launchers: true }).launchers).toBe(true);
});

test("setup clis rejects invalid cooldown days", () => {
  expect(() => normalizeSetupClisOptions({ cooldown: -1 })).toThrow("--cooldown");
  expect(() => normalizeSetupClisOptions({ cooldown: 1.5 })).toThrow("--cooldown");
});

test("setup clis rejects mutually exclusive prereq modes", () => {
  expect(() => normalizeSetupClisOptions({ noSudo: true, noPrereqs: true })).toThrow(
    "mutually exclusive",
  );
});
