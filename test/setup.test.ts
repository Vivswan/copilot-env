import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildNodePosixInstallScript,
  computePathRefresh,
  parseShellAction,
  runShell,
} from "../src/commands/setup.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  CI_RC_DIR_ENV,
  LAUNCHERS_MARKER,
  LAUNCHERS_MARKER_END,
  windowsProfileTarget,
} from "../src/shell/integration.ts";
import { expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

// runShell's flag validation throws BEFORE any install or rc wiring, so these
// need no filesystem/network isolation.

test("shell: the CLI-install tuning flags require --clis", () => {
  expect(() => runShell({ cooldown: 7 })).toThrow("require --clis");
  expect(() => runShell({ noSudo: true })).toThrow("require --clis");
  expect(() => runShell({ noPrereqs: true })).toThrow("require --clis");
});

test("parseShellAction: remove vs wire arms, with the CLI install inside the wire arm", () => {
  // Removal: --launchers scopes it to just the launchers block.
  expect(parseShellAction({ remove: true })).toEqual({
    kind: "remove",
    allHosts: false,
    launchersOnly: false,
  });
  expect(parseShellAction({ remove: true, launchers: true, allHosts: true })).toEqual({
    kind: "remove",
    allHosts: true,
    launchersOnly: true,
  });
  // Wiring: no --clis means no CliSetup at all; --clis folds the install knobs
  // into the arm (verify-only under --no-prereqs).
  expect(parseShellAction({ launchers: true })).toEqual({
    kind: "wire",
    allHosts: false,
    launchers: true,
    clis: null,
  });
  expect(parseShellAction({ clis: true, cooldown: 7 })).toEqual({
    kind: "wire",
    allHosts: false,
    launchers: false,
    clis: { mode: "install", cooldown: 7, noSudo: false },
  });
  expect(parseShellAction({ clis: true, noPrereqs: true })).toEqual({
    kind: "wire",
    allHosts: false,
    launchers: false,
    clis: { mode: "verify-only" },
  });
});

test("shell --clis: --no-sudo and --no-prereqs are mutually exclusive", () => {
  expect(() => runShell({ clis: true, noSudo: true, noPrereqs: true })).toThrow(
    "mutually exclusive",
  );
});

test("shell --clis: --cooldown and --no-prereqs are mutually exclusive", () => {
  // --no-prereqs installs nothing, so a cooldown has nothing to steer; the boundary
  // rejects the pair instead of silently dropping the cooldown.
  expect(() => runShell({ clis: true, cooldown: 7, noPrereqs: true })).toThrow(
    "--cooldown and --no-prereqs are mutually exclusive",
  );
});

test("shell --clis: a non-integer/negative cooldown is rejected", () => {
  expect(() => runShell({ clis: true, cooldown: 1.5 })).toThrow("--cooldown");
  expect(() => runShell({ clis: true, cooldown: -1 })).toThrow("--cooldown");
});

test("shell --clis cannot combine with --remove", () => {
  expect(() => runShell({ clis: true, remove: true })).toThrow("cannot be combined with --remove");
});

// runShell's launcher toggle is the `launchers` config key (the rc writes ride the
// suite's rc-dir/Documents seams, so this runs for real on every OS): --launchers
// sets it, every remove flavor clears it, and a plain wire leaves it alone.
test("runShell toggles the launchers config key; a plain wire leaves it alone", () => {
  const restore = envSnapshot();
  let dir = isolateProxyHome("copilot-setup-");
  try {
    runShell({ launchers: true });
    expect(new CopilotEnvConfig().launchersEnabled()).toBe(true);
    runShell({}); // a plain re-wire never drops the opt-in
    expect(new CopilotEnvConfig().launchersEnabled()).toBe(true);
    runShell({ remove: true, launchers: true }); // launchers-only disable
    expect(new CopilotEnvConfig().launchersEnabled()).toBe(false);
    runShell({ launchers: true });
    runShell({ remove: true }); // the full unwire disables them too
    expect(new CopilotEnvConfig().launchersEnabled()).toBe(false);
  } finally {
    restore();
    dir = removeDir(dir);
  }
});

// The upgrade path, on THIS platform's own wire target (the rc-dir seam on POSIX,
// the redirected $PROFILE tree on Windows): a legacy launchers rc block carries the
// old opt-in, so a wire migrates it to the config key -- but a stored preference,
// either way, is the user's decision and is never overwritten.
test("a wire migrates a legacy launchers block's opt-in, never over a stored value", () => {
  const restore = envSnapshot();
  let dir = isolateProxyHome("copilot-setup-migrate-");
  try {
    const target = process.platform === "win32"
      ? windowsProfileTarget(false).paths[0]
      : join(process.env[CI_RC_DIR_ENV] ?? "", ".bashrc");
    if (target === undefined) throw new Error("no wire target resolved");
    const legacyBlock = `\n${LAUNCHERS_MARKER}\n${LAUNCHERS_MARKER_END}\n`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, legacyBlock);
    runShell({});
    expect(new CopilotEnvConfig().launchersEnabled()).toBe(true);
    // Explicit false + another legacy block: the wire strips the block but the
    // stored decision stands.
    new CopilotEnvConfig().set({ launchers: false });
    writeFileSync(target, legacyBlock);
    runShell({});
    expect(new CopilotEnvConfig().launchersEnabled()).toBe(false);
  } finally {
    restore();
    dir = removeDir(dir);
  }
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

test("computePathRefresh on POSIX uses ':' and a <prefix>/bin dir, prepended", () => {
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

// The nvm install script must pin `default` to a LOCALLY resolvable version, not
// the remote `lts/*` meta-alias. A remote default resolves to N/A offline, so
// sourcing nvm.sh activates nothing and the resolveCommand nvm fallback (and the
// whole CLI install) silently breaks. Guard against that regression.
test("buildNodePosixInstallScript pins default to the installed version, not lts/*", () => {
  const script = buildNodePosixInstallScript();
  // Installs LTS, but never aliases default at the remote meta-alias.
  expect(script).toContain("nvm install --lts");
  expect(script).not.toContain("alias default 'lts/*'");
  expect(script).not.toContain("alias default lts/*");
  // default tracks the concrete active version, with a `node` (latest local) fallback.
  expect(script).toContain('NODE_DEFAULT="$(nvm current)"');
  expect(script).toContain('nvm alias default "$NODE_DEFAULT"');
  expect(script).toContain("NODE_DEFAULT=node");
});
