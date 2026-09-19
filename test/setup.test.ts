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
import {
  AGENT_CLIS,
  buildNodePosixInstallScript,
  computePathRefresh,
} from "../src/agents/cli_install.ts";
import { parseShellAction, runShell } from "../src/commands/setup.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CI_RC_DIR_ENV, MARKER } from "../src/shell/integration.ts";
import { expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

// runShell's flag validation throws BEFORE any install or rc wiring, so these
// need no filesystem/network isolation.

test("shell: the CLI-install tuning flags require --clis, --no-prereqs excludes --no-sudo and --cooldown, the cooldown is a non-negative integer, and --clis never combines with --remove", () => {
  const rows: Array<[Parameters<typeof runShell>[0], string]> = [
    [{ cooldown: 7 }, "require --clis"],
    [{ noSudo: true }, "require --clis"],
    [{ noPrereqs: true }, "require --clis"],
    [{ clis: true, noSudo: true, noPrereqs: true }, "mutually exclusive"],
    // --no-prereqs installs nothing, so a cooldown has nothing to steer; the boundary
    // rejects the pair instead of silently dropping the cooldown.
    [
      { clis: true, cooldown: 7, noPrereqs: true },
      "--cooldown and --no-prereqs are mutually exclusive",
    ],
    [{ clis: true, cooldown: 1.5 }, "--cooldown"],
    [{ clis: true, cooldown: -1 }, "--cooldown"],
    [{ clis: true, remove: true }, "cannot be combined with --remove"],
  ];
  for (const [opts, message] of rows) {
    expect(() => runShell(opts), JSON.stringify(opts)).toThrow(message);
  }
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
    expect(lines.at(-1)).toContain("Launchers: disabled (the shell.launchers config key)");
    expect(new CopilotEnvConfig().read().global["shell.launchers"]).toBeUndefined();
    new CopilotEnvConfig().set({ "shell.launchers": true });
    runShell({});
    expect(lines.at(-1)).toContain("Launchers: enabled (the shell.launchers config key)");
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

const [FIRST, SECOND, THIRD] = AGENT_CLIS;

interface CliInstallRow {
  name: string;
  opts: Parameters<typeof stageCliInstallFixture>[0];
  /** Lines the run must print, and lines it must never print. */
  lines: readonly string[];
  never: readonly string[];
  /** CLI commands the fake npm must have laid down under the global bin, and must not have. */
  installed: readonly string[];
  absent: readonly string[];
  /** The install spec a shim must name: the readback proves WHICH version npm was told. */
  shimSpec?: readonly [command: string, spec: string];
  /** syncNpmGlobalBinToPath prepended npm's global bin, so fresh installs resolve in THIS process. */
  pathPrepended?: true;
}

const CLI_INSTALL_ROWS: readonly CliInstallRow[] = [
  {
    name: "one CLI's npm failure warns as itself, the rest still install",
    opts: { failInstalls: [FIRST.packageName] },
    // The genuine npm failure warns as ITSELF (which CLI, why, and that the run goes on),
    // never dressed in the could-not-check look-failure wording.
    lines: [
      `Could not install ${FIRST.name} (npm install -g ${FIRST.packageName}@${FAKE_LATEST} failed); continuing.`,
    ],
    never: ["probe failed to run"],
    installed: [SECOND.command, THIRD.command],
    absent: [FIRST.command],
  },
  {
    name: "a failed npm PATH sync warns, the CLIs are still checked",
    opts: { prefixFails: true, preinstalled: AGENT_CLIS.map((cli) => cli.command) },
    // Each CLI is on PATH but absent from the fake `npm ls`, so it reads as a non-npm install;
    // the sync failure must never be dressed as a per-CLI install or could-not-check failure.
    lines: [
      "Could not sync npm's global bin dir to PATH (npm prefix -g failed); continuing.",
      ...AGENT_CLIS.map((cli) => `${cli.name} is installed outside npm; leaving it as it is.`),
    ],
    never: ["Could not install", "probe failed to run"],
    installed: [],
    absent: [],
  },
  {
    name: "the all-good run installs every CLI and extends PATH, warn-free",
    opts: {},
    lines: AGENT_CLIS.map((cli) =>
      `Installing ${cli.name} (${cli.packageName}@${FAKE_LATEST}) ...`
    ),
    never: ["Could not"],
    installed: AGENT_CLIS.map((cli) => cli.command),
    absent: [],
    pathPrepended: true,
  },
  {
    name: "an outdated npm-installed CLI is updated; a current or newer one is kept",
    opts: {
      preinstalled: AGENT_CLIS.map((cli) => cli.command),
      npmInstalled: {
        [FIRST.packageName]: "1.0.0",
        [SECOND.packageName]: FAKE_LATEST,
        [THIRD.packageName]: "3.0.0",
      },
    },
    lines: [
      `Updating ${FIRST.name} 1.0.0 -> ${FAKE_LATEST} ...`,
      `${SECOND.name} is current (${FAKE_LATEST}).`,
      `${THIRD.name} 3.0.0 is newer than the target ${FAKE_LATEST}; keeping it.`,
    ],
    never: ["Could not"],
    installed: [FIRST.command],
    // The current and the newer CLI were never reinstalled, let alone downgraded.
    absent: [SECOND.command, THIRD.command],
    shimSpec: [FIRST.command, `${FIRST.packageName}@${FAKE_LATEST}`],
  },
  {
    name:
      "an npm-installed CLI whose command is off PATH, or whose version is unreadable, is never downgraded",
    opts: { npmInstalled: { [FIRST.packageName]: null, [THIRD.packageName]: "3.0.0" } },
    lines: [
      `${THIRD.name} 3.0.0 is installed by npm, but '${THIRD.command}' is not on PATH; leaving it as it is.`,
      `${FIRST.name} is installed by npm, but its version could not be read; leaving it as it is.`,
      `Installing ${SECOND.name} (${SECOND.packageName}@${FAKE_LATEST}) ...`,
    ],
    never: ["Could not"],
    installed: [SECOND.command],
    absent: [FIRST.command, THIRD.command],
  },
  {
    name: "a failed npm package list installs nothing",
    opts: { lsFails: true },
    // Nothing on PATH would once have meant "install"; with npm's list unreadable the run
    // cannot rule out a newer install whose bin dir is off PATH, so it installs nothing.
    lines: [
      "Could not read npm's global package list (npm ls -g failed); skipping the CLI installs.",
    ],
    never: ["Installing"],
    installed: [],
    absent: AGENT_CLIS.map((cli) => cli.command),
  },
];

test.skipIf(process.platform === "win32")(
  "shell --clis: every npm outcome is reported as itself, the other CLIs still install, and the wiring lands",
  () => {
    for (const row of CLI_INSTALL_ROWS) {
      const restore = envSnapshot(CLI_ENV_EXTRAS);
      let dir = "";
      try {
        const fixture = stageCliInstallFixture(row.opts);
        dir = fixture.dir;
        const output = captureRun(() => runShell({ clis: true }));
        for (const line of row.lines) expect(output, row.name).toContain(line);
        for (const line of row.never) expect(output, row.name).not.toContain(line);
        for (const command of row.installed) {
          expect(existsSync(join(fixture.globalBin, command)), `${row.name}: ${command}`).toBe(
            true,
          );
        }
        for (const command of row.absent) {
          expect(existsSync(join(fixture.globalBin, command)), `${row.name}: ${command}`).toBe(
            false,
          );
        }
        if (row.shimSpec) {
          const [command, spec] = row.shimSpec;
          expect(readFileSync(join(fixture.globalBin, command), "utf-8"), row.name).toContain(spec);
        }
        if (row.pathPrepended) {
          expect(process.env.PATH?.startsWith(`${fixture.globalBin}:`), row.name).toBe(true);
        }
        expect(readFileSync(fixture.bashrc, "utf-8"), row.name).toContain(MARKER);
      } finally {
        restore();
        dir = removeDir(dir);
      }
    }
  },
);

// computePathRefresh takes the platform as a parameter so the win32 arm runs on POSIX CI.

test("computePathRefresh: win32 writes BOTH Path and PATH with ';' off the prefix itself, POSIX uses ':' and <prefix>/bin, each prepended, and a bin dir already on PATH is a no-op", () => {
  const winPrefix = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const winOld = "C:\\Windows;C:\\Windows\\System32";
  const prefix = "/home/me/.npm-global";
  const old = "/usr/bin:/bin";
  const rows: Array<
    [NodeJS.Platform, string, string, ReturnType<typeof computePathRefresh>]
  > = [
    // On Windows the npm prefix IS the bin dir (no /bin suffix).
    ["win32", winPrefix, winOld, {
      bin: winPrefix,
      separator: ";",
      assignments: { PATH: `${winPrefix};${winOld}`, Path: `${winPrefix};${winOld}` },
    }],
    ["linux", prefix, old, {
      bin: `${prefix}/bin`,
      separator: ":",
      assignments: { PATH: `${prefix}/bin:${old}`, Path: `${prefix}/bin:${old}` },
    }],
    // darwin behaves like linux (any non-win32 platform).
    ["darwin", prefix, old, {
      bin: `${prefix}/bin`,
      separator: ":",
      assignments: { PATH: `${prefix}/bin:${old}`, Path: `${prefix}/bin:${old}` },
    }],
    ["linux", prefix, `${prefix}/bin:/usr/bin`, {
      bin: `${prefix}/bin`,
      separator: ":",
      assignments: {},
    }],
  ];
  for (const [platform, npmPrefix, oldPath, expected] of rows) {
    expect(computePathRefresh(platform, npmPrefix, oldPath), `${platform} ${oldPath}`).toEqual(
      expected,
    );
  }
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
