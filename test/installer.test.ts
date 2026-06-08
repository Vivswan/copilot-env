import { expect, test } from "bun:test";

import { parseInstallArgs, shellSetupArgs } from "../src/install/installer.ts";

test("installer parses default install options", () => {
  expect(parseInstallArgs(["install"])).toEqual({
    noShellIntegration: false,
    allHosts: false,
  });
});

test("installer parses shell wiring flags", () => {
  expect(parseInstallArgs(["install", "--no-shell-integration", "--all-hosts"])).toEqual({
    noShellIntegration: true,
    allHosts: true,
  });
});

test("installer rejects unknown commands and flags", () => {
  expect(() => parseInstallArgs([])).toThrow("usage:");
  expect(() => parseInstallArgs(["repair"])).toThrow("usage:");
  expect(() => parseInstallArgs(["install", "--launchers"])).toThrow("unknown argument");
});

test("installer delegates shell setup through agent setup shell", () => {
  expect(shellSetupArgs({ noShellIntegration: false, allHosts: false })).toEqual([
    "setup",
    "shell",
  ]);
  expect(shellSetupArgs({ noShellIntegration: false, allHosts: true })).toEqual([
    "setup",
    "shell",
    "--all-hosts",
  ]);
  expect(shellSetupArgs({ noShellIntegration: true, allHosts: true })).toBeNull();
});
