import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { consola } from "consola";
import { AGENT_CLIS } from "../src/agents/clis.ts";
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
  MARKER,
  windowsProfileTarget,
} from "../src/shell/integration.ts";
import { expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir, tmpDir } from "./helpers.ts";

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

// --- the best-effort `--clis` install run ---------------------------------------
//
// These drive the REAL install arm end to end against a fake `npm` on PATH (a sh
// script, so the trio is POSIX-only: the win32 arm additionally rewrites the real
// user-registry PATH, which no test may touch). The whole outcome under guard: a
// contained npm failure warns honestly, the remaining CLIs are still attempted,
// and the rc wiring `runShell` does afterwards still lands.

interface CliInstallFixture {
  dir: string;
  /** Where the fake `npm install -g` lays down CLI shims (`<prefix>/bin`). */
  globalBin: string;
  /** The rc file the wire targets (pre-created so rcFiles picks it). */
  bashrc: string;
}

/**
 * Stage a hermetic `--clis` run: PATH holds ONLY a fixture bin -- the fake npm plus
 * `sh`/`chmod` symlinks (all the probes and the fake need) -- so no real CLI on the
 * host can satisfy a look; NVM_DIR points nowhere (so findCommand's nvm fallback
 * cannot resolve real CLIs either) and the rc seam targets a fresh dir. The fake
 * npm answers `prefix -g` and `install -g <pkg>` per the options, silently (stdio
 * is inherited, so a chatty fake would bypass the capture below).
 */
function stageCliInstallFixture(opts: {
  /** `npm prefix -g` exits 1 instead of printing the prefix. */
  prefixFails?: boolean;
  /** Packages whose `npm install -g` exits 1 instead of laying down the shim. */
  failInstalls?: readonly string[];
  /** Commands pre-placed on PATH, so installCli reads them as already installed. */
  preinstalled?: readonly string[];
}): CliInstallFixture {
  const dir = tmpDir("copilot-setup-clis-");
  const pathBin = join(dir, "path-bin");
  const prefix = join(dir, "npm-prefix");
  const globalBin = join(prefix, "bin");
  const rcDir = join(dir, "rc");
  for (const d of [pathBin, globalBin, rcDir]) mkdirSync(d, { recursive: true });
  const bashrc = join(rcDir, ".bashrc");
  writeFileSync(bashrc, "");
  symlinkSync("/bin/sh", join(pathBin, "sh"));
  const chmod = ["/bin/chmod", "/usr/bin/chmod"].find((p) => existsSync(p));
  if (!chmod) throw new Error("no chmod found for the fake npm");
  symlinkSync(chmod, join(pathBin, "chmod"));

  const shim = (path: string): void => {
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  };
  const installArms = AGENT_CLIS.map((cli) => {
    if (opts.failInstalls?.includes(cli.packageName)) return `  "${cli.packageName}") exit 1 ;;`;
    const target = `"${globalBin}/${cli.command}"`;
    return `  "${cli.packageName}") printf '#!/bin/sh\\nexit 0\\n' > ${target}` +
      `; chmod +x ${target}; exit 0 ;;`;
  });
  writeFileSync(
    join(pathBin, "npm"),
    [
      "#!/bin/sh",
      'case "$1" in',
      opts.prefixFails ? "  prefix) exit 1 ;;" : `  prefix) echo "${prefix}"; exit 0 ;;`,
      '  install) case "$3" in',
      ...installArms,
      "  *) exit 1 ;;",
      "  esac ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(pathBin, "npm"), 0o755);
  for (const command of opts.preinstalled ?? []) shim(join(pathBin, command));

  process.env.PATH = pathBin;
  process.env.NVM_DIR = join(dir, "no-nvm");
  process.env[CI_RC_DIR_ENV] = rcDir;
  return { dir, globalBin, bashrc };
}

/** Run `fn` with stdout/stderr captured and consola at info level; returns the output. */
function captureRun(fn: () => void): string {
  const written: string[] = [];
  const savedLevel = consola.level;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array) => {
    written.push(String(s));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array) => {
    written.push(String(s));
    return true;
  };
  try {
    consola.level = 3; // ensure info is not self-silenced under the test runner
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    consola.level = savedLevel;
  }
  return written.join("");
}

const CLI_ENV_EXTRAS = ["PATH", "Path", "NVM_DIR"] as const;

test.skipIf(process.platform === "win32")(
  "shell --clis: one CLI's npm failure warns, the rest still install, the wiring lands",
  () => {
    const restore = envSnapshot(CLI_ENV_EXTRAS);
    const [broken, ...others] = AGENT_CLIS;
    let dir = "";
    try {
      const fixture = stageCliInstallFixture({ failInstalls: [broken.packageName] });
      dir = fixture.dir;
      const output = captureRun(() => runShell({ clis: true }));
      // The genuine npm failure warns as ITSELF (which CLI, why, and that the run
      // goes on) -- never dressed in the could-not-check look-failure wording.
      expect(output).toContain(
        `Could not install ${broken.name} (npm install -g ${broken.packageName} failed); continuing.`,
      );
      expect(output).not.toContain("probe failed to run");
      expect(existsSync(join(fixture.globalBin, broken.command))).toBe(false);
      // The remaining CLIs really installed, and the rc wiring still ran.
      for (const cli of others) {
        expect(existsSync(join(fixture.globalBin, cli.command))).toBe(true);
      }
      expect(readFileSync(fixture.bashrc, "utf-8")).toContain(MARKER);
    } finally {
      restore();
      dir = removeDir(dir);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "shell --clis: a failed npm PATH sync warns, the CLIs are still checked, the wiring lands",
  () => {
    const restore = envSnapshot(CLI_ENV_EXTRAS);
    let dir = "";
    try {
      const fixture = stageCliInstallFixture({
        prefixFails: true,
        preinstalled: AGENT_CLIS.map((cli) => cli.command),
      });
      dir = fixture.dir;
      const output = captureRun(() => runShell({ clis: true }));
      expect(output).toContain(
        "Could not sync npm's global bin dir to PATH (npm prefix -g failed); continuing.",
      );
      // The loop still ran over every CLI, and the sync failure was never dressed
      // as a per-CLI install failure or a could-not-check look failure.
      for (const cli of AGENT_CLIS) expect(output).toContain(`${cli.name} already installed.`);
      expect(output).not.toContain("Could not install");
      expect(output).not.toContain("probe failed to run");
      expect(readFileSync(fixture.bashrc, "utf-8")).toContain(MARKER);
    } finally {
      restore();
      dir = removeDir(dir);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "shell --clis: the all-good run installs every CLI, extends PATH, and wires -- warn-free",
  () => {
    const restore = envSnapshot(CLI_ENV_EXTRAS);
    let dir = "";
    try {
      const fixture = stageCliInstallFixture({});
      dir = fixture.dir;
      const output = captureRun(() => runShell({ clis: true }));
      expect(output).not.toContain("Could not");
      for (const cli of AGENT_CLIS) {
        expect(output).toContain(`Installing ${cli.name} ...`);
        expect(existsSync(join(fixture.globalBin, cli.command))).toBe(true);
      }
      // syncNpmGlobalBinToPath prepended npm's global bin, so the fresh installs
      // resolved in THIS process.
      expect(process.env.PATH?.startsWith(`${fixture.globalBin}:`)).toBe(true);
      expect(readFileSync(fixture.bashrc, "utf-8")).toContain(MARKER);
    } finally {
      restore();
      dir = removeDir(dir);
    }
  },
);
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
