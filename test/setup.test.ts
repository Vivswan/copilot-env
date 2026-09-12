import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { AGENT_CLIS } from "../src/agents/clis.ts";
import {
  buildNodePosixInstallScript,
  computePathRefresh,
  parseShellAction,
  runShell,
} from "../src/commands/setup.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CI_RC_DIR_ENV, MARKER } from "../src/shell/integration.ts";
import { expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

// runShell's flag validation throws BEFORE any install or rc wiring, so these
// need no filesystem/network isolation.

test("shell: the CLI-install tuning flags require --clis", () => {
  expect(() => runShell({ cooldown: 7 })).toThrow("require --clis");
  expect(() => runShell({ noSudo: true })).toThrow("require --clis");
  expect(() => runShell({ noPrereqs: true })).toThrow("require --clis");
});

test("parseShellAction: remove vs wire arms, with the CLI install inside the wire arm", () => {
  expect(parseShellAction({ remove: true })).toEqual({ kind: "remove", allHosts: false });
  expect(parseShellAction({ remove: true, allHosts: true })).toEqual({
    kind: "remove",
    allHosts: true,
  });
  expect(parseShellAction({})).toEqual({ kind: "wire", allHosts: false, clis: null });
  expect(parseShellAction({ clis: true, cooldown: 7 })).toEqual({
    kind: "wire",
    allHosts: false,
    clis: { mode: "install", cooldown: 7, noSudo: false },
  });
  expect(parseShellAction({ clis: true, noPrereqs: true })).toEqual({
    kind: "wire",
    allHosts: false,
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

// The rc writes ride the suite's rc-dir/Documents seams, so this runs for real on every OS.
test("runShell reports the launchers key on a wire and never writes it", () => {
  const restore = envSnapshot();
  let dir = isolateProxyHome("copilot-setup-");
  const lines: string[] = [];
  const orig = consola.info;
  consola.info = ((msg: string) => {
    lines.push(String(msg));
  }) as typeof consola.info;
  try {
    runShell({});
    expect(lines.at(-1)).toContain("Launchers: disabled (the launchers config key)");
    expect(new CopilotEnvConfig().read().launchers).toBeUndefined();
    new CopilotEnvConfig().set({ launchers: true });
    runShell({});
    expect(lines.at(-1)).toContain("Launchers: enabled (the launchers config key)");
    runShell({ remove: true }); // the unwire is the rc block's; the key is the user's
    expect(new CopilotEnvConfig().launchersEnabled()).toBe(true);
  } finally {
    consola.info = orig;
    restore();
    dir = removeDir(dir);
  }
});

// --- the best-effort `--clis` install run ---------------------------------------
//
// POSIX-only: the fake `npm` is a sh script, and the win32 arm rewrites the real
// user-registry PATH, which no test may touch.

/** What the fake `npm view <pkg> version` answers: the version every run targets. */
const FAKE_LATEST = "2.0.0";

interface CliInstallFixture {
  dir: string;
  /** Where the fake `npm install -g` lays down CLI shims (`<prefix>/bin`). */
  globalBin: string;
  /** The rc file the wire targets (pre-created so rcFiles picks it). */
  bashrc: string;
}

/**
 * Nothing real may satisfy a look: PATH holds only the fixture bin (the fake npm plus `sh` and
 * `chmod` links), NVM_DIR points nowhere, and the rc seam targets a fresh dir. The fake npm
 * answers silently: stdio is inherited, so a chatty fake would bypass captureRun.
 */
function stageCliInstallFixture(opts: {
  /** `npm prefix -g` exits 1 instead of printing the prefix. */
  prefixFails?: boolean;
  /** `npm ls -g` prints only npm's `error` object and exits 1 instead of the tree. */
  lsFails?: boolean;
  /** Packages whose `npm install -g` exits 1 instead of laying down the shim. */
  failInstalls?: readonly string[];
  /** Commands pre-placed on PATH, so installCli reads them as already installed. */
  preinstalled?: readonly string[];
  /** What the fake `npm ls -g` reports as installed: package name -> version, or null for a
   *  package npm lists without a version (its package.json unreadable). */
  npmInstalled?: Readonly<Record<string, string | null>>;
}): CliInstallFixture {
  const dir = tempDir("copilot-setup-clis-");
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
  // The install arm writes the spec it was given into the shim, so a test can read back
  // WHICH version npm was told to install.
  const installArms = AGENT_CLIS.map((cli) => {
    if (opts.failInstalls?.includes(cli.packageName)) return `  "${cli.packageName}"@*) exit 1 ;;`;
    const target = `"${globalBin}/${cli.command}"`;
    return `  "${cli.packageName}"@*) printf '#!/bin/sh\\n# %s\\nexit 0\\n' "$3" > ${target}` +
      `; chmod +x ${target}; exit 0 ;;`;
  });
  // The real `npm ls -g --json` shapes: no `dependencies` key for an empty tree, a
  // version-less entry for a package whose package.json it could not read, and only an
  // `error` object when the list itself failed.
  const installedEntries = Object.entries(opts.npmInstalled ?? {});
  const lsTree = JSON.stringify(
    opts.lsFails
      ? { error: { code: "ENOTDIR", summary: "", detail: "" } }
      : installedEntries.length === 0
      ? {}
      : {
        dependencies: Object.fromEntries(
          installedEntries.map(([name, version]) => [name, version === null ? {} : { version }]),
        ),
      },
  );
  writeFileSync(
    join(pathBin, "npm"),
    [
      "#!/bin/sh",
      'case "$1" in',
      opts.prefixFails ? "  prefix) exit 1 ;;" : `  prefix) echo "${prefix}"; exit 0 ;;`,
      `  ls) echo '${lsTree}'; exit ${opts.lsFails ? 1 : 0} ;;`,
      `  view) echo '${JSON.stringify([FAKE_LATEST])}'; exit 0 ;;`,
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
        `Could not install ${broken.name} (npm install -g ${broken.packageName}@${FAKE_LATEST} failed); continuing.`,
      );
      expect(output).not.toContain("probe failed to run");
      expect(existsSync(join(fixture.globalBin, broken.command))).toBe(false);
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
      // Each CLI is on PATH but absent from the fake `npm ls`, so it reads as a non-npm install;
      // the sync failure must never be dressed as a per-CLI install or could-not-check failure.
      for (const cli of AGENT_CLIS) {
        expect(output).toContain(`${cli.name} is installed outside npm; leaving it as it is.`);
      }
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
        expect(output).toContain(`Installing ${cli.name} (${cli.packageName}@${FAKE_LATEST}) ...`);
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

test.skipIf(process.platform === "win32")(
  "shell --clis: an outdated npm-installed CLI is updated; a current or newer one is kept",
  () => {
    const restore = envSnapshot(CLI_ENV_EXTRAS);
    const [outdated, current, newer] = AGENT_CLIS;
    let dir = "";
    try {
      const fixture = stageCliInstallFixture({
        preinstalled: AGENT_CLIS.map((cli) => cli.command),
        npmInstalled: {
          [outdated.packageName]: "1.0.0",
          [current.packageName]: FAKE_LATEST,
          [newer.packageName]: "3.0.0",
        },
      });
      dir = fixture.dir;
      const output = captureRun(() => runShell({ clis: true }));
      expect(output).not.toContain("Could not");
      expect(output).toContain(`Updating ${outdated.name} 1.0.0 -> ${FAKE_LATEST} ...`);
      expect(output).toContain(`${current.name} is current (${FAKE_LATEST}).`);
      expect(output).toContain(
        `${newer.name} 3.0.0 is newer than the target ${FAKE_LATEST}; keeping it.`,
      );
      // The fake shim names the spec it was installed at, so the readback proves WHICH version;
      // the current and the newer CLI were never reinstalled, let alone downgraded.
      expect(readFileSync(join(fixture.globalBin, outdated.command), "utf-8")).toContain(
        `${outdated.packageName}@${FAKE_LATEST}`,
      );
      expect(existsSync(join(fixture.globalBin, current.command))).toBe(false);
      expect(existsSync(join(fixture.globalBin, newer.command))).toBe(false);
    } finally {
      restore();
      dir = removeDir(dir);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "shell --clis: an npm-installed CLI whose command is off PATH is never downgraded",
  () => {
    const restore = envSnapshot(CLI_ENV_EXTRAS);
    const [unreadable, absent, offPath] = AGENT_CLIS;
    let dir = "";
    try {
      const fixture = stageCliInstallFixture({
        npmInstalled: { [unreadable.packageName]: null, [offPath.packageName]: "3.0.0" },
      });
      dir = fixture.dir;
      const output = captureRun(() => runShell({ clis: true }));
      expect(output).not.toContain("Could not");
      expect(output).toContain(
        `${offPath.name} 3.0.0 is installed by npm, but '${offPath.command}' is not on PATH; leaving it as it is.`,
      );
      expect(output).toContain(
        `${unreadable.name} is installed by npm, but its version could not be read; leaving it as it is.`,
      );
      expect(output).toContain(
        `Installing ${absent.name} (${absent.packageName}@${FAKE_LATEST}) ...`,
      );
      expect(existsSync(join(fixture.globalBin, absent.command))).toBe(true);
      expect(existsSync(join(fixture.globalBin, offPath.command))).toBe(false);
      expect(existsSync(join(fixture.globalBin, unreadable.command))).toBe(false);
    } finally {
      restore();
      dir = removeDir(dir);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "shell --clis: a failed npm package list installs nothing, the wiring still lands",
  () => {
    const restore = envSnapshot(CLI_ENV_EXTRAS);
    let dir = "";
    try {
      const fixture = stageCliInstallFixture({ lsFails: true });
      dir = fixture.dir;
      const output = captureRun(() => runShell({ clis: true }));
      // Nothing on PATH would once have meant "install"; with npm's list unreadable the run
      // cannot rule out a newer install whose bin dir is off PATH, so it installs nothing.
      expect(output).toContain(
        "Could not read npm's global package list (npm ls -g failed); skipping the CLI installs.",
      );
      expect(output).not.toContain("Installing");
      for (const cli of AGENT_CLIS) {
        expect(existsSync(join(fixture.globalBin, cli.command))).toBe(false);
      }
      expect(readFileSync(fixture.bashrc, "utf-8")).toContain(MARKER);
    } finally {
      restore();
      dir = removeDir(dir);
    }
  },
);
// computePathRefresh takes the platform as a parameter so the win32 arm runs on POSIX CI.

test("computePathRefresh on win32 writes BOTH Path and PATH with ';' and prepends the prefix", () => {
  const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const old = "C:\\Windows;C:\\Windows\\System32";
  const { bin, separator, assignments } = computePathRefresh("win32", prefix, old);

  // On Windows the npm prefix IS the bin dir (no /bin suffix).
  expect(bin).toBe(prefix);
  expect(separator).toBe(";");
  expect(Object.keys(assignments).sort()).toEqual(["PATH", "Path"]);
  expect(assignments.Path).toBe(assignments.PATH);
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
  expect(assignments).toEqual({});
});

// A `default` aliased at the remote `lts/*` meta-alias resolves to N/A offline, so sourcing
// nvm.sh activates nothing and the resolveCommand nvm fallback silently breaks.
test("buildNodePosixInstallScript pins default to the installed version, not lts/*", () => {
  const script = buildNodePosixInstallScript();
  expect(script).toContain("nvm install --lts");
  expect(script).not.toContain("alias default 'lts/*'");
  expect(script).not.toContain("alias default lts/*");
  // default tracks the concrete active version, with a `node` (latest local) fallback.
  expect(script).toContain('NODE_DEFAULT="$(nvm current)"');
  expect(script).toContain('nvm alias default "$NODE_DEFAULT"');
  expect(script).toContain("NODE_DEFAULT=node");
});
