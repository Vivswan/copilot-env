// `agent profile sync --codex` is proxy-forced here so nothing probes the network, and PATH is an empty dir so the
// shared-home prime can never spawn a real codex CLI.

import * as fs from "node:fs";
import { join, relative } from "node:path";
import { proxyHelperCommand } from "../src/claude/config.ts";
import { runCodex } from "../src/agents/configure_defaults.ts";
import {
  codexHostDrift,
  codexHostFarm,
  effectiveCodexHome,
  getHostLocalCodexHome,
  managedCodexHome,
  narrateCodexHome,
  planCodexHostFarm,
  resolveCodexHome,
  staleCodexHomeExportLine,
  withCodexHostFarm,
} from "../src/codex/host.ts";
import { runConfig } from "../src/commands/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { CopilotEnvRunState } from "../src/copilot_api/run_state.ts";
import { codexFarmHostsDir, getSanitizedHostname } from "../src/utils/hostname.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, resetExitCode } from "./helpers/env.ts";
import { writeClaudeSettings, writeCodexConfigToml, writeRunState } from "./helpers/fixtures.ts";
import { linesNaming } from "./helpers/dry_run.ts";
import { captureChannels } from "./helpers/output.ts";

// The farm needs POSIX symlinks; Windows CI still runs the path-derivation test and the Windows-only guard.
const skipWin = test.skipIf(process.platform === "win32");
const onlyWin = test.skipIf(process.platform !== "win32");

const restoreEnv = envSnapshot(["PATH"]);
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
});

// The farm layout contract buildCodexSymlinkFarm writes (pinned as literals on
// purpose: renaming an entry is an on-disk layout change, not a refactor).
const LOCAL_DIRS = [".tmp", "log", "tmp"];
const SHARED_DIRS = [
  "ambient-suggestions",
  "archived_sessions",
  "memories",
  "memories_extensions",
  "plugins",
  "rules",
  "sessions",
  "shell_snapshots",
  "skills",
  "vendor_imports",
  "worktrees",
];
const LOCAL_SEED_FILES = [".personality_migration", "config.toml", "history.jsonl"];
const SHARED_FILES = [
  ".codex-global-state.json",
  "AGENTS.md",
  "session_index.jsonl",
  "version.json",
];
const OPTIONAL_SHARED_FILES = ["installation_id", "shell-init.sh"];

interface Farm {
  /** The shared Codex root the farm links into: <home>/.codex */
  sharedRoot: string;
  /** The per-host CODEX_HOME the farm builds: <home>/.codex/hosts/<hostname> */
  hostHome: string;
}

// No codex on PATH makes the prime step a no-op. The disabled catalog sync inside applyCodexConfig
// sweeps homedir()/.codex; deno's node:os homedir() follows the HOME and USERPROFILE
// isolateAgentHomes just set, so that sweep stays inside the temp tree too.
function isolate(): Farm {
  const homes = isolateAgentHomes("copilot-codex-host-");
  dir = homes.dir;
  // The suite's CODEX_HOME floor would read as a shell export the farm overrides (one warning per
  // build); HOME alone lands the unmanaged home at <dir>/.codex, and the tests about the export set
  // it themselves.
  delete process.env.CODEX_HOME;
  const emptyBin = join(dir, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  process.env.PATH = emptyBin;
  return { sharedRoot: join(dir, ".codex"), hostHome: getHostLocalCodexHome() };
}

function configureCodex(): Promise<void> {
  // A single-agent write re-renders the recorded default mode (the record is `agent init`'s).
  new CopilotEnvState().recordDefaultMode("proxy");
  return runCodex({ kind: "configure", mode: "proxy" });
}

/** What `agent config set codex.host true` followed by `agent profile sync --codex` does. */
function build(): Promise<void> {
  new CopilotEnvConfig().set({ "codex.host": true });
  return configureCodex();
}

function storeFiles(): { config: string; state: string } {
  const paths = new CopilotApiPaths();
  return { config: paths.stateStoreFile, state: paths.stateFile };
}

async function stderrDuring(run: () => Promise<void>): Promise<string> {
  return (await captureChannels(run, { writeReports: true })).stderr;
}

/** The console.log lines `run` prints (`agent profile check --codex` reports on stdout). */
async function stdoutLinesDuring(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function isRealDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function linkTarget(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

// Entry kind plus link target or file bytes, so an idempotency check catches any drift, not just additions.
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string, rel: string): void => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      out[rel] = `link -> ${fs.readlinkSync(p)}`;
    } else if (st.isDirectory()) {
      out[rel] = "dir";
      for (const name of fs.readdirSync(p).sort()) walk(join(p, name), `${rel}/${name}`);
    } else {
      out[rel] = `file: ${fs.readFileSync(p, "utf8")}`;
    }
  };
  walk(root, ".");
  return out;
}

// --- path derivation (platform-independent) ---------------------------------

test("getHostLocalCodexHome is <home>/.codex/hosts/<sanitized hostname>, resolved per call", () => {
  dir = isolateAgentHomes("copilot-codex-host-").dir;
  const host = getSanitizedHostname();
  expect(host.length).toBeGreaterThan(0);
  expect(getHostLocalCodexHome()).toBe(join(codexFarmHostsDir(), host));
  expect(getHostLocalCodexHome()).toBe(join(dir, ".codex", "hosts", host));
  // HOME is read per call (the farm's contract), so retargeting it moves the farm.
  process.env.HOME = join(dir, "other-home");
  expect(getHostLocalCodexHome()).toBe(join(dir, "other-home", ".codex", "hosts", host));
  // A `codex-home` root replaces ~/.codex, HOME notwithstanding.
  expect(getHostLocalCodexHome(join(dir, "root"))).toBe(join(dir, "root", "hosts", host));
  new CopilotEnvConfig().set({ "codex.home": join(dir, "root") });
  expect(getHostLocalCodexHome()).toBe(join(dir, "root", "hosts", host));
});

// The one farm decision the derivation and the settings-import plan share.
test("planCodexHostFarm: the key against the farm facts, per platform", () => {
  const hostHome = "/h/.codex/hosts/box";
  const farm = (present: boolean, wired: boolean, probeError: string | null = null) => ({
    hostHome,
    present,
    wired,
    probeError,
    active: false,
  });
  const cases: Array<
    [enabled: boolean, farm: ReturnType<typeof farm>, plan: ReturnType<typeof planCodexHostFarm>]
  > = [
    [true, farm(false, false), { action: "build" }],
    [true, farm(true, false), { action: "verify" }],
    [true, farm(true, true), { action: "verify" }],
    [true, farm(true, false, "EACCES"), { action: "verify" }], // on: build regardless
    // Off removes only what is proven ours NOW: our managed wiring on disk.
    [false, farm(true, true), { action: "remove" }],
    [false, { ...farm(true, true), active: true }, { action: "remove" }],
    [false, { ...farm(false, false), active: true }, { action: "none" }], // a dead record: nothing on disk
    // Anything else at the path is left alone: a foreign dir, a symlink, a half-built
    // leftover even when recorded, an unprobeable path.
    [false, farm(true, false), { action: "leave" }],
    [false, { ...farm(true, false), active: true }, { action: "leave" }],
    [false, { ...farm(false, false, "EACCES"), active: true }, { action: "leave" }],
    [false, farm(false, false, "EACCES"), { action: "leave" }],
    [false, farm(false, false), { action: "none" }],
  ];
  for (const [enabled, facts, plan] of cases) {
    expect(planCodexHostFarm(enabled, facts, "linux")).toEqual(plan);
    // Windows never has a farm: every combination is a no-op there.
    expect(planCodexHostFarm(enabled, facts, "win32")).toEqual({ action: "none" });
  }
});

// --- platform guard (the Windows CI job runs only this of the farm tests) -----

onlyWin("Windows: the key cannot be set, reads off, and the derivation is inert", async () => {
  const { sharedRoot, hostHome } = isolate();
  writeRunState({ codexHome: sharedRoot });
  fs.mkdirSync(sharedRoot, { recursive: true });
  expect(() =>
    runConfig({
      kind: "set",
      key: "codex.host",
      value: "true",
      view: { kind: "config" },
      dryRun: false,
    })
  ).toThrow(
    "'codex.host' is only supported on Linux and macOS (this is win32)",
  );
  // Even a stored true (an imported bundle) reads as off here.
  new CopilotEnvConfig().set({ "codex.host": true });
  expect(new CopilotEnvConfig().codexHostEnabled()).toBe(false);
  // A farm-shaped path (a home shared with a POSIX machine) is not ours here: no drift, no build, no removal.
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(join(hostHome, "config.toml"), "x = 1\n");
  expect(codexHostDrift()).toBeNull();
  // A farm-shaped export is the user's own home here: honoured, and left in the shell.
  process.env.CODEX_HOME = hostHome;
  expect(resolveCodexHome()).toEqual({ home: hostHome, by: "default", staleExport: null });
  expect(managedCodexHome()).toBeNull();
  delete process.env.CODEX_HOME;
  const written: string[] = [];
  await withCodexHostFarm((home) => {
    written.push(home);
    return Promise.resolve();
  });
  expect(written).toEqual([sharedRoot]);
  expect(lexists(join(hostHome, "config.toml"))).toBe(true);
  expect(new CopilotEnvRunState().read().codexHome).toBe(sharedRoot);
  // `codex-home` has no symlink in it, so it works here: the write and the export follow the path.
  const root = join(dir, "explicit-root");
  new CopilotEnvConfig().set({ "codex.home": root });
  written.length = 0;
  await withCodexHostFarm((home) => {
    written.push(home);
    return Promise.resolve();
  });
  expect(written).toEqual([root]);
  expect(managedCodexHome()).toEqual({ value: root });
});

// --- farm build from scratch -------------------------------------------------

function narratedPaths(narrated: string): Set<string> {
  const out = new Set<string>();
  for (
    const m of narrated.matchAll(
      /^(?:created|rewritten|deleted|moved|linked) -> (.+?)(?: \(.*\))?$/gm,
    )
  ) {
    out.add(m[1] ?? "");
  }
  return out;
}

skipWin(
  "a fresh build lays out the full farm, records CODEX_HOME, and names every path it creates",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    const narrated = await stderrDuring(build);
    // Nothing hidden: every entry the build created under the shared root is named by a line. The
    // snapshot is the filesystem delta from an empty tree.
    const created = Object.keys(snapshotTree(sharedRoot))
      .filter((rel) => rel !== ".")
      .map((rel) => join(sharedRoot, rel.slice(2)));
    const named = narratedPaths(narrated);
    for (const p of created) expect(named.has(p), p).toBe(true);
    // One line per path, exactly: a line is about `p` when its subject (minus a trailing
    // parenthetical) IS `p`, not a descendant or a prefix-sharing sidecar.
    const about = (p: string) =>
      linesNaming(narrated, p).filter((l) => l.replace(/ \(.*\)$/, "").endsWith(p));
    expect(about(hostHome)).toEqual([`created -> ${hostHome} (per-host CODEX_HOME farm)`]);
    expect(about(join(hostHome, "config.toml"))).toEqual([
      `created -> ${join(hostHome, "config.toml")} (Codex config)`,
    ]);
    // The run-state record is bookkeeping inside the data home: written, never named.
    expect(linesNaming(narrated, storeFiles().state)).toEqual([]);
    for (const p of named) expect(about(p).length, p).toBe(1);

    for (const d of LOCAL_DIRS) {
      expect(isRealDir(join(hostHome, d))).toBe(true);
      expect(isSymlink(join(hostHome, d))).toBe(false);
    }

    // With no shared counterpart the migration marker and history seed empty; config.toml is written
    // by the proxy config pass afterwards.
    for (const f of LOCAL_SEED_FILES) {
      expect(isRegularFile(join(hostHome, f))).toBe(true);
      expect(isSymlink(join(hostHome, f))).toBe(false);
    }
    expect(fs.readFileSync(join(hostHome, ".personality_migration"), "utf8")).toBe("");
    expect(fs.readFileSync(join(hostHome, "history.jsonl"), "utf8")).toBe("");
    expect(fs.readFileSync(join(hostHome, "config.toml"), "utf8")).toContain(
      'model_provider = "copilot-env"',
    );
    // config.toml stays host-local: it is never promoted into the shared root.
    expect(lexists(join(sharedRoot, "config.toml"))).toBe(false);

    for (const d of SHARED_DIRS) {
      expect(isRealDir(join(sharedRoot, d))).toBe(true);
      expect(isSymlink(join(sharedRoot, d))).toBe(false);
      expect(linkTarget(join(hostHome, d))).toBe(join(sharedRoot, d));
    }

    for (const f of SHARED_FILES) {
      expect(isRegularFile(join(sharedRoot, f))).toBe(true);
      expect(fs.readFileSync(join(sharedRoot, f), "utf8")).toBe("");
      expect(linkTarget(join(hostHome, f))).toBe(join(sharedRoot, f));
    }

    // Optional shared files get NO placeholder: the symlink dangles until something writes the shared file.
    for (const f of OPTIONAL_SHARED_FILES) {
      expect(linkTarget(join(hostHome, f))).toBe(join(sharedRoot, f));
      expect(lexists(join(sharedRoot, f))).toBe(false);
    }

    // The active CODEX_HOME is recorded (the effective home for every read and write).
    expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
    expect(effectiveCodexHome()).toBe(hostHome);
    expect(codexHostFarm()).toEqual({
      hostHome,
      present: true,
      wired: true,
      probeError: null,
      active: true,
    });
    expect(codexHostDrift()).toBeNull();
  },
);

skipWin(
  "a relative HOME still builds an absolute farm whose links resolve to the shared root",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    // Every path the farm records, exports, or links must come out absolute anyway.
    process.env.HOME = relative(process.cwd(), dir);
    expect(getHostLocalCodexHome()).toBe(hostHome);
    await build();
    for (const d of SHARED_DIRS) {
      expect(linkTarget(join(hostHome, d))).toBe(join(sharedRoot, d));
      expect(fs.realpathSync(join(hostHome, d))).toBe(fs.realpathSync(join(sharedRoot, d)));
    }
    for (const f of SHARED_FILES) expect(linkTarget(join(hostHome, f))).toBe(join(sharedRoot, f));
    expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
  },
);

skipWin("building twice changes nothing (idempotent, byte for byte)", async () => {
  const { sharedRoot, hostHome } = isolate();
  await build();
  const before = snapshotTree(sharedRoot);
  const narrated = await stderrDuring(configureCodex);
  expect(snapshotTree(sharedRoot)).toEqual(before);
  expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
  // The record's clear-and-reset rewrites a store inside the registered data home, which
  // reportWrite never announces, so it is silent too.
  expect(narrated).toContain(`Per-host CODEX_HOME farm verified → ${hostHome}`);
  const underRoot = [...narratedPaths(narrated)].filter(
    (p) => p.startsWith(`${sharedRoot}/`) && p !== join(hostHome, "config.toml"),
  );
  expect(underRoot).toEqual([]);
});

// --- shared-home prime (primeSharedCodexHomeIfMissing) -----------------------

skipWin(
  "the shared-home prime: a missing shared root is primed by a codex on PATH (its failure swallowed, the paths it made named as ours); an existing root skips the prime entirely",
  async () => {
    for (const rootExists of [false, true]) {
      dir = removeDir(dir);
      const { sharedRoot } = isolate();
      if (rootExists) fs.mkdirSync(sharedRoot, { recursive: true });
      const bin = join(dir, "fake-bin");
      const marker = join(dir, "codex-invocations.log");
      fs.mkdirSync(bin, { recursive: true });
      // Exit nonzero on purpose: the prime is best-effort and must not fail the build.
      // It writes into the CODEX_HOME it is given, the way a real codex would.
      fs.writeFileSync(
        join(bin, "codex"),
        `#!/bin/sh\nPATH=/usr/bin:/bin\nprintf '%s\\n' "$*" >> "${marker}"\ncat > /dev/null\n` +
          `mkdir -p "$CODEX_HOME"\nprintf '{}' > "$CODEX_HOME/primed.json"\nexit 3\n`,
        { mode: 0o755 },
      );
      // The fake bin dir FIRST, but with the system dirs kept: resolveCommand
      // resolves through `sh`, which must itself stay spawnable.
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      // An inherited CODEX_HOME must not divert the prime: the spawn gets the shared root.
      const decoy = join(dir, "decoy-codex-home");
      process.env.CODEX_HOME = decoy;

      deferWriteReports();
      await build();
      const reported = flushWriteReports();
      const name = rootExists ? "existing root" : "missing root";
      expect(isRealDir(sharedRoot), name).toBe(true);
      expect(lexists(decoy), name).toBe(false);
      if (rootExists) {
        expect(lexists(marker), name).toBe(false);
        expect(lexists(join(sharedRoot, "primed.json")), name).toBe(false);
      } else {
        expect(fs.readFileSync(marker, "utf8"), name).toBe("exec\n");
        // The paths codex made on our request are named as ours.
        expect(reported, name).toContain(`created -> ${sharedRoot}`);
        expect(reported, name).toContain(`created -> ${join(sharedRoot, "primed.json")}`);
      }
    }
  },
);

// --- local seeding (seedLocalCodexFileIfMissing, via history.jsonl) -----------

skipWin(
  "the host-local seed (history.jsonl): copied from the shared root when missing; an existing local copy is left alone, a local symlink too (with a warning)",
  async () => {
    const cases: {
      name: string;
      shared?: string;
      local?: string | { symlinkTo: string };
      expected: (farm: Farm, warned: string) => void;
    }[] = [
      {
        name: "shared present, local missing: seeded as a regular file",
        shared: '{"x":1}\n',
        expected: ({ hostHome }) => {
          const local = join(hostHome, "history.jsonl");
          expect(isRegularFile(local)).toBe(true);
          expect(isSymlink(local)).toBe(false);
          expect(fs.readFileSync(local, "utf8")).toBe('{"x":1}\n');
        },
      },
      {
        name: "both present: each side keeps its own bytes",
        shared: "shared\n",
        local: "local\n",
        expected: ({ sharedRoot, hostHome }) => {
          expect(fs.readFileSync(join(hostHome, "history.jsonl"), "utf8")).toBe("local\n");
          expect(fs.readFileSync(join(sharedRoot, "history.jsonl"), "utf8")).toBe("shared\n");
        },
      },
      {
        name: "a local symlink is tolerated in place",
        local: { symlinkTo: "elsewhere-history" },
        expected: ({ hostHome }, warned) => {
          expect(linkTarget(join(hostHome, "history.jsonl"))).toBe(join(dir, "elsewhere-history"));
          expect(warned).toContain(
            `Skipping local Codex seed because the path already exists as a symlink: ${
              join(hostHome, "history.jsonl")
            }`,
          );
        },
      },
    ];
    for (const c of cases) {
      dir = removeDir(dir);
      const farm = isolate();
      if (c.shared !== undefined) {
        fs.mkdirSync(farm.sharedRoot, { recursive: true });
        fs.writeFileSync(join(farm.sharedRoot, "history.jsonl"), c.shared);
      }
      if (c.local !== undefined) {
        fs.mkdirSync(farm.hostHome, { recursive: true });
        if (typeof c.local === "string") {
          fs.writeFileSync(join(farm.hostHome, "history.jsonl"), c.local);
        } else fs.symlinkSync(join(dir, c.local.symlinkTo), join(farm.hostHome, "history.jsonl"));
      }
      const warned = await stderrDuring(build);
      c.expected(farm, warned);
    }
  },
);

// --- shared seeding (seedSharedCodexFileIfMissing, via AGENTS.md) -------------

skipWin(
  "the shared seed (AGENTS.md): a host-local copy identical to the shared file is replaced by a symlink; differing content keeps both copies unlinked (warned); a local symlink stays; the shared placeholder always lands",
  async () => {
    const cases: {
      name: string;
      shared?: string;
      local: string | { symlinkTo: string };
      expected: (farm: Farm, warned: string) => void;
    }[] = [
      {
        name: "identical content: the local copy becomes a symlink",
        shared: "agents\n",
        local: "agents\n",
        expected: ({ sharedRoot, hostHome }) => {
          expect(fs.readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("agents\n");
          expect(linkTarget(join(hostHome, "AGENTS.md"))).toBe(join(sharedRoot, "AGENTS.md"));
        },
      },
      {
        name: "local only: the empty placeholder lands and the local copy stays unlinked",
        local: "agents\n",
        expected: ({ sharedRoot, hostHome }, warned) => {
          expect(fs.readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("");
          const local = join(hostHome, "AGENTS.md");
          expect(isSymlink(local)).toBe(false);
          expect(fs.readFileSync(local, "utf8")).toBe("agents\n");
          expect(warned).toContain(`Leaving existing Codex path unchanged: ${local}`);
        },
      },
      {
        name: "conflicting content keeps both copies and skips the symlink",
        shared: "shared\n",
        local: "local\n",
        expected: ({ sharedRoot, hostHome }, warned) => {
          expect(fs.readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("shared\n");
          const local = join(hostHome, "AGENTS.md");
          expect(isRegularFile(local)).toBe(true);
          expect(isSymlink(local)).toBe(false);
          expect(fs.readFileSync(local, "utf8")).toBe("local\n");
          // The conflict is warned about and swallowed: the build still completes.
          expect(warned).toContain(`Leaving existing Codex path unchanged: ${local}`);
          expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
        },
      },
      {
        name: "a wrong-target local symlink is left in place; the shared placeholder still lands",
        local: { symlinkTo: "elsewhere-agents" },
        expected: ({ sharedRoot, hostHome }) => {
          // Not repaired today: the existing symlink wins (with a warning)...
          expect(linkTarget(join(hostHome, "AGENTS.md"))).toBe(join(dir, "elsewhere-agents"));
          // ...while the shared placeholder is still created for other hosts.
          expect(isRegularFile(join(sharedRoot, "AGENTS.md"))).toBe(true);
          expect(fs.readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("");
        },
      },
    ];
    for (const c of cases) {
      dir = removeDir(dir);
      const farm = isolate();
      if (c.shared !== undefined) {
        fs.mkdirSync(farm.sharedRoot, { recursive: true });
        fs.writeFileSync(join(farm.sharedRoot, "AGENTS.md"), c.shared);
      }
      fs.mkdirSync(farm.hostHome, { recursive: true });
      if (typeof c.local === "string") fs.writeFileSync(join(farm.hostHome, "AGENTS.md"), c.local);
      else fs.symlinkSync(join(dir, c.local.symlinkTo), join(farm.hostHome, "AGENTS.md"));
      const warned = await stderrDuring(build);
      c.expected(farm, warned);
    }
  },
);

// --- optional shared seeding (installation_id) --------------------------------

skipWin("a host-local installation_id stays where it is (warned); none is fabricated", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(join(hostHome, "installation_id"), "id-123");

  const warned = await stderrDuring(build);
  expect(lexists(join(sharedRoot, "installation_id"))).toBe(false);
  expect(isSymlink(join(hostHome, "installation_id"))).toBe(false);
  expect(fs.readFileSync(join(hostHome, "installation_id"), "utf8")).toBe("id-123");
  expect(warned).toContain(
    `Leaving existing Codex path unchanged: ${join(hostHome, "installation_id")}`,
  );
  // The other optional file stays a dangling symlink (no placeholder).
  expect(linkTarget(join(hostHome, "shell-init.sh"))).toBe(join(sharedRoot, "shell-init.sh"));
  expect(lexists(join(sharedRoot, "shell-init.sh"))).toBe(false);
});

// --- shared-dir promotion (ensureCodexDirSymlink / promoteCodexDirToSharedIfSafe)

skipWin(
  "a host-local sessions dir merges into the shared root and becomes a symlink, nested entries and symlinks preserved, every merged path named; identical content already on the shared side merges the same way",
  async () => {
    const cases: { name: string; sharedHasIdentical: boolean }[] = [
      { name: "shared side empty", sharedHasIdentical: false },
      // The shared side already carries the SAME file and nested link: identical, so the merge
      // proceeds and replaces them in place instead of failing on the existing entries.
      { name: "identical file and link on both sides", sharedHasIdentical: true },
    ];
    for (const c of cases) {
      dir = removeDir(dir);
      const { sharedRoot, hostHome } = isolate();
      const linkDest = join(dir, "session-target");
      // A symlink at the top level (mergeDirInto's own branch) and one nested (copyTree's).
      fs.mkdirSync(join(hostHome, "sessions", "nested", "deep"), { recursive: true });
      fs.writeFileSync(join(hostHome, "sessions", "top.txt"), "same");
      fs.writeFileSync(join(hostHome, "sessions", "nested", "deep", "a.txt"), "A");
      fs.symlinkSync(linkDest, join(hostHome, "sessions", "ln"));
      fs.symlinkSync(linkDest, join(hostHome, "sessions", "nested", "ln"));
      if (c.sharedHasIdentical) {
        fs.mkdirSync(join(sharedRoot, "sessions", "nested"), { recursive: true });
        fs.writeFileSync(join(sharedRoot, "sessions", "top.txt"), "same");
        fs.symlinkSync(linkDest, join(sharedRoot, "sessions", "ln"));
        fs.symlinkSync(linkDest, join(sharedRoot, "sessions", "nested", "ln"));
      }

      const narrated = await stderrDuring(build);
      const shared = join(sharedRoot, "sessions");
      expect(fs.readFileSync(join(shared, "top.txt"), "utf8"), c.name).toBe("same");
      expect(fs.readFileSync(join(shared, "nested", "deep", "a.txt"), "utf8"), c.name).toBe("A");
      expect(linkTarget(join(shared, "ln")), c.name).toBe(linkDest);
      expect(linkTarget(join(shared, "nested", "ln")), c.name).toBe(linkDest);
      expect(linkTarget(join(hostHome, "sessions")), c.name).toBe(shared);
      // The merge copies descendant by descendant, and names each one (nothing hidden).
      const named = narratedPaths(narrated);
      for (
        const p of [
          join(shared, "top.txt"),
          join(shared, "ln"),
          join(shared, "nested", "deep"),
          join(shared, "nested", "deep", "a.txt"),
          join(shared, "nested", "ln"),
          join(hostHome, "sessions"),
        ]
      ) {
        expect(named.has(p), `${c.name}: ${p}`).toBe(true);
      }
    }
  },
);

skipWin(
  "promotion refusals: a sessions slot the merge cannot prove safe is left as it is on both sides (the build still completes), and the shared dir still lands for the other hosts",
  async () => {
    // rc 2 is warned about and swallowed by the caller: the rest of the farm still builds.
    const cases: {
      name: string;
      arrange: (farm: Farm) => void;
      expected: (farm: Farm, warned: string) => void;
    }[] = [
      {
        name: "conflicting file content",
        arrange: ({ sharedRoot, hostHome }) => {
          fs.mkdirSync(join(sharedRoot, "sessions"), { recursive: true });
          fs.writeFileSync(join(sharedRoot, "sessions", "top.txt"), "A");
          fs.mkdirSync(join(hostHome, "sessions"), { recursive: true });
          fs.writeFileSync(join(hostHome, "sessions", "top.txt"), "B");
        },
        expected: ({ sharedRoot, hostHome }, warned) => {
          expect(fs.readFileSync(join(sharedRoot, "sessions", "top.txt"), "utf8")).toBe("A");
          const local = join(hostHome, "sessions");
          expect(isRealDir(local)).toBe(true);
          expect(isSymlink(local)).toBe(false);
          expect(fs.readFileSync(join(local, "top.txt"), "utf8")).toBe("B");
          expect(warned).toContain(`Leaving existing Codex path unchanged: ${local}`);
        },
      },
      {
        name: "a local subdir colliding with a shared file",
        arrange: ({ sharedRoot, hostHome }) => {
          fs.mkdirSync(join(sharedRoot, "sessions"), { recursive: true });
          fs.writeFileSync(join(sharedRoot, "sessions", "sub"), "a file");
          fs.mkdirSync(join(hostHome, "sessions", "sub"), { recursive: true });
        },
        expected: ({ sharedRoot, hostHome }) => {
          expect(fs.readFileSync(join(sharedRoot, "sessions", "sub"), "utf8")).toBe("a file");
          expect(isRealDir(join(hostHome, "sessions"))).toBe(true);
          expect(isSymlink(join(hostHome, "sessions"))).toBe(false);
        },
      },
      {
        name: "symlink entries with differing targets",
        arrange: ({ sharedRoot, hostHome }) => {
          fs.mkdirSync(join(sharedRoot, "sessions"), { recursive: true });
          fs.symlinkSync(join(dir, "target-a"), join(sharedRoot, "sessions", "ln"));
          fs.mkdirSync(join(hostHome, "sessions"), { recursive: true });
          fs.symlinkSync(join(dir, "target-b"), join(hostHome, "sessions", "ln"));
        },
        expected: ({ sharedRoot, hostHome }) => {
          expect(linkTarget(join(sharedRoot, "sessions", "ln"))).toBe(join(dir, "target-a"));
          expect(isRealDir(join(hostHome, "sessions"))).toBe(true);
          expect(linkTarget(join(hostHome, "sessions", "ln"))).toBe(join(dir, "target-b"));
        },
      },
      {
        name: "a shared dir that is itself a symlink",
        arrange: ({ sharedRoot, hostHome }) => {
          const realShared = join(dir, "real-sessions");
          fs.mkdirSync(realShared, { recursive: true });
          fs.mkdirSync(sharedRoot, { recursive: true });
          fs.symlinkSync(realShared, join(sharedRoot, "sessions"));
          fs.mkdirSync(join(hostHome, "sessions"), { recursive: true });
          fs.writeFileSync(join(hostHome, "sessions", "top.txt"), "local");
        },
        expected: ({ sharedRoot, hostHome }) => {
          expect(linkTarget(join(sharedRoot, "sessions"))).toBe(join(dir, "real-sessions"));
          expect(isRealDir(join(hostHome, "sessions"))).toBe(true);
          expect(fs.readFileSync(join(hostHome, "sessions", "top.txt"), "utf8")).toBe("local");
        },
      },
      {
        name: "a wrong-target local sessions symlink (tolerated, not repaired)",
        arrange: ({ hostHome }) => {
          fs.mkdirSync(join(dir, "elsewhere-sessions"), { recursive: true });
          fs.mkdirSync(hostHome, { recursive: true });
          fs.symlinkSync(join(dir, "elsewhere-sessions"), join(hostHome, "sessions"));
        },
        expected: ({ sharedRoot, hostHome }) => {
          expect(linkTarget(join(hostHome, "sessions"))).toBe(join(dir, "elsewhere-sessions"));
          expect(isRealDir(join(sharedRoot, "sessions"))).toBe(true);
        },
      },
      {
        name: "a local sessions regular file (left alone, no symlink)",
        arrange: ({ hostHome }) => {
          fs.mkdirSync(hostHome, { recursive: true });
          fs.writeFileSync(join(hostHome, "sessions"), "not a dir");
        },
        expected: ({ hostHome }) => {
          expect(isRegularFile(join(hostHome, "sessions"))).toBe(true);
          expect(fs.readFileSync(join(hostHome, "sessions"), "utf8")).toBe("not a dir");
        },
      },
    ];
    for (const c of cases) {
      dir = removeDir(dir);
      const farm = isolate();
      c.arrange(farm);
      const warned = await stderrDuring(build);
      // Never linked into the shared slot, and the build completed (the record is set).
      expect(linkTarget(join(farm.hostHome, "sessions")), c.name).not.toBe(
        join(farm.sharedRoot, "sessions"),
      );
      expect(new CopilotEnvRunState().read().codexHome, c.name).toBe(farm.hostHome);
      c.expected(farm, warned);
    }
  },
);

skipWin("a shared dir slot occupied by a file fails the build with the farm error", async () => {
  const { sharedRoot } = isolate();
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.writeFileSync(join(sharedRoot, "sessions"), "not a dir");

  await expect(build()).rejects.toThrow(/Failed to build the CODEX_HOME symlink farm/);
  expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
});

skipWin(
  "an empty seeded config.toml is not wired; a wired farm is active only once a write is recorded",
  () => {
    const { hostHome } = isolate();
    fs.mkdirSync(hostHome, { recursive: true });
    fs.writeFileSync(join(hostHome, "config.toml"), "");
    expect(codexHostFarm()).toEqual({
      hostHome,
      present: true,
      wired: false,
      probeError: null,
      active: false,
    });
    fs.writeFileSync(join(hostHome, "config.toml"), 'model_provider = "copilot-env"\n');
    expect(codexHostFarm()).toEqual({
      hostHome,
      present: true,
      wired: true,
      probeError: null,
      active: false,
    });
    // Wired but never activated (no successful managed write recorded) is its own drift.
    new CopilotEnvConfig().set({ "codex.host": true });
    expect(codexHostDrift()).toEqual({ kind: "inactive", hostHome });
    writeRunState({ codexHome: hostHome });
    expect(codexHostFarm().active).toBe(true);
    expect(codexHostDrift()).toBeNull();
  },
);

// --- key off (what `--delete-host` did) ---------------------------------------

skipWin(
  "the key off (false, or unset: an install that built the farm before the key) removes the per-host home, keeps the shared root, clears the record, and lands the default write at ~/.codex; with no farm built it only clears a stale record, quietly",
  async () => {
    const cases: {
      name: string;
      arrange: (farm: Farm) => Promise<void>;
      expected: (farm: Farm, narrated: string) => Promise<void>;
    }[] = [
      {
        name: "false, farm built",
        arrange: async ({ hostHome }) => {
          await build();
          expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
          new CopilotEnvConfig().set({ "codex.host": false });
        },
        expected: ({ sharedRoot, hostHome }, narrated) => {
          for (const d of SHARED_DIRS) expect(isRealDir(join(sharedRoot, d))).toBe(true);
          for (const f of SHARED_FILES) expect(isRegularFile(join(sharedRoot, f))).toBe(true);
          expect(fs.readFileSync(join(sharedRoot, "config.toml"), "utf8")).toContain(
            'model_provider = "copilot-env"',
          );
          expect(narrated).toContain(`deleted -> ${hostHome} (per-host CODEX_HOME farm)`);
          expect(narrated).toContain(`-> ${join(sharedRoot, "config.toml")} (Codex config)`);
          return Promise.resolve();
        },
      },
      {
        name: "unset, farm built",
        arrange: async ({ hostHome }) => {
          await build();
          new CopilotEnvConfig().del("codex.host");
          expect(codexHostDrift()).toEqual({ kind: "disabled", hostHome });
        },
        expected: ({ sharedRoot, hostHome }, narrated) => {
          expect(fs.readFileSync(join(sharedRoot, "config.toml"), "utf8")).toContain(
            'model_provider = "copilot-env"',
          );
          expect(narrated).toContain(`deleted -> ${hostHome} (per-host CODEX_HOME farm)`);
          expect(narrated).toContain(`-> ${join(sharedRoot, "config.toml")} (Codex config)`);
          // Never written for the user.
          expect(new CopilotEnvConfig().read().global["codex.host"]).toBeUndefined();
          return Promise.resolve();
        },
      },
      {
        name: "false, no farm built, a stale record",
        arrange: ({ hostHome }) => {
          writeRunState({ codexHome: hostHome });
          new CopilotEnvConfig().set({ "codex.host": false });
          return Promise.resolve();
        },
        expected: async ({ hostHome }, narrated) => {
          expect(narrated).not.toContain(hostHome);
          const quiet = await stderrDuring(configureCodex);
          expect(quiet).not.toContain("CODEX_HOME");
        },
      },
    ];
    for (const c of cases) {
      dir = removeDir(dir);
      const farm = isolate();
      await c.arrange(farm);
      const narrated = await stderrDuring(configureCodex);
      expect(lexists(farm.hostHome), c.name).toBe(false);
      expect(new CopilotEnvRunState().read().codexHome, c.name).toBeUndefined();
      expect(codexHostDrift(), c.name).toBeNull();
      await c.expected(farm, narrated);
    }
  },
);

skipWin(
  "key off never deletes a path it cannot prove is ours: a foreign dir and a symlink survive",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    new CopilotEnvConfig().set({ "codex.host": false });
    // A foreign Codex home at the farm path (another tool's config, no record of ours).
    fs.mkdirSync(hostHome, { recursive: true });
    fs.writeFileSync(join(hostHome, "config.toml"), 'model_provider = "openai"\n');
    fs.writeFileSync(join(hostHome, "precious.txt"), "keep");
    expect(codexHostFarm().wired).toBe(false);
    expect(codexHostDrift()).toBeNull(); // not ours, so no drift to report
    let narrated = await stderrDuring(configureCodex);
    expect(fs.readFileSync(join(hostHome, "precious.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(join(hostHome, "config.toml"), "utf8")).toBe(
      'model_provider = "openai"\n',
    );
    expect(narrated).toContain(`Leaving ${hostHome} alone`);
    expect(narrated).not.toContain("farm removed");
    // The config write landed at the default home, not in the foreign dir.
    expect(fs.readFileSync(join(sharedRoot, "config.toml"), "utf8")).toContain(
      'model_provider = "copilot-env"',
    );

    // A symlink at the farm path pointing at the user's own home, even one carrying
    // OUR provider id: wiring reached through a link is never proof the farm is ours.
    fs.rmSync(hostHome, { recursive: true, force: true });
    const elsewhere = join(dir, "elsewhere-home");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(join(elsewhere, "config.toml"), 'model_provider = "copilot-env"\n');
    fs.symlinkSync(elsewhere, hostHome);
    expect(codexHostFarm().wired).toBe(false);
    narrated = await stderrDuring(configureCodex);
    expect(fs.lstatSync(hostHome).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(join(elsewhere, "config.toml"))).toBe(true);
    expect(narrated).toContain(`Leaving ${hostHome} alone`);
    expect(codexHostDrift()).toBeNull();

    // A real dir whose config.toml is itself a symlink into the user's tree: same rule.
    fs.unlinkSync(hostHome);
    fs.mkdirSync(hostHome, { recursive: true });
    fs.symlinkSync(join(elsewhere, "config.toml"), join(hostHome, "config.toml"));
    expect(codexHostFarm().wired).toBe(false);
    await stderrDuring(configureCodex);
    expect(fs.lstatSync(join(hostHome, "config.toml")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(elsewhere, "config.toml"), "utf8")).toContain("copilot-env");
  },
);

skipWin(
  "a build or rebuild whose managed write fails leaves no activation record; the farm stays the home the key names, exported with the drift named beside it",
  async () => {
    // The first build seeds the farm's config.toml from ~/.codex's; an unparseable one makes the
    // managed write refuse (it never overwrites a user file it cannot parse).
    const seeded = isolate();
    fs.mkdirSync(seeded.sharedRoot, { recursive: true });
    fs.writeFileSync(join(seeded.sharedRoot, "config.toml"), "this = is = not toml\n");
    await expect(build()).rejects.toThrow();
    expect(isRealDir(seeded.hostHome)).toBe(true); // built ...
    expect(new CopilotEnvRunState().read().codexHome).toBeUndefined(); // ... but not activated
    expect(effectiveCodexHome()).toBe(seeded.hostHome);

    const { hostHome } = isolate();
    await build();
    expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
    expect(managedCodexHome()).toEqual({ value: hostHome });
    // The farm's config becomes invalid TOML (a hand edit gone wrong): the managed write
    // refuses to overwrite a file it cannot parse, so the rebuild fails after the farm step.
    fs.writeFileSync(join(hostHome, "config.toml"), "this = is = not toml\n");
    expect(codexHostFarm().wired).toBe(false);
    await expect(configureCodex()).rejects.toThrow();
    // The record was cleared BEFORE the rebuild and never re-set: the farm is not active, yet the
    // key still names it as the home ...
    expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
    expect(effectiveCodexHome()).toBe(hostHome);
    // ... so `agent profile env` exports it and names the drift beside it.
    const warned = await stderrDuring(() => {
      expect(managedCodexHome()).toEqual({ value: hostHome });
      return Promise.resolve();
    });
    expect(warned).toContain("farm is missing");
  },
);

// --- drift reports (`agent profile check --codex`) ------------------------------------

skipWin(
  "codexHostDrift and `agent profile check --codex` report every key-vs-disk disagreement",
  async () => {
    const { hostHome } = isolate();
    const missingLine =
      `codex.host is on but the per-host CODEX_HOME farm is missing at ${hostHome}; run \`agent profile sync --codex\` to rebuild it`;
    const check = () => stdoutLinesDuring(() => runCodex({ kind: "check" }));

    new CopilotEnvConfig().set({ "codex.host": true });
    expect(codexHostDrift()).toEqual({ kind: "missing", hostHome });
    const unbuilt = await check();
    expect(unbuilt[0]).toMatch(/^Codex provider mode: none /);
    expect(unbuilt.slice(1)).toEqual([
      `CODEX_HOME: ${hostHome}`,
      `config.toml: ${join(hostHome, "config.toml")}`,
      missingLine,
    ]);

    await configureCodex();
    expect(codexHostDrift()).toBeNull();
    const built = await check();
    expect(built[0]).toMatch(/^Codex provider mode: proxy /);
    expect(built.slice(1)).toEqual([
      `CODEX_HOME: ${hostHome}`,
      `config.toml: ${join(hostHome, "config.toml")}`,
    ]);

    // Hand-deleted farm with the key still on: the record points at a dead home.
    fs.rmSync(hostHome, { recursive: true, force: true });
    expect(codexHostDrift()).toEqual({ kind: "missing", hostHome });
    expect((await check()).at(-1)).toBe(missingLine);

    // Rebuilt, then the key turned off without a wiring pass: the farm is a leftover.
    await configureCodex();
    new CopilotEnvConfig().set({ "codex.host": false });
    expect(codexHostDrift()).toEqual({ kind: "disabled", hostHome });
    expect((await check()).at(-1)).toBe(
      `codex.host is off but a per-host CODEX_HOME farm is still present at ${hostHome}; run \`agent profile sync --codex\` to remove it`,
    );
  },
);

// --- the effective home and the shell's export ---------------------------------

skipWin(
  "resolveCodexHome: with neither key the shell's CODEX_HOME export is the home, except OUR farm export, built or not",
  () => {
    const { sharedRoot, hostHome } = isolate();
    const own = join(dir, "my-own-codex");
    const shell = { by: "default", staleExport: null } as const;
    // Codex's own convention: the export is the home ...
    process.env.CODEX_HOME = own;
    expect(resolveCodexHome()).toEqual({ home: own, ...shell });
    process.env.CODEX_HOME = `${hostHome}/`; // a variant spelling is the user's, not ours
    expect(resolveCodexHome()).toEqual({ home: `${hostHome}/`, ...shell });
    // ... except our own farm export, built or not: a write through it would resurrect the removed
    // farm as a plain dir.
    process.env.CODEX_HOME = hostHome;
    expect(resolveCodexHome()).toEqual({ home: sharedRoot, ...shell });
    fs.mkdirSync(hostHome, { recursive: true });
    expect(resolveCodexHome()).toEqual({ home: sharedRoot, ...shell });
    delete process.env.CODEX_HOME;
    expect(resolveCodexHome()).toEqual({ home: sharedRoot, ...shell });
  },
);

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

skipWin(
  "the default write names a shell export the farm overrides once per process, and never with the key off or an agreeing shell",
  async () => {
    const { hostHome } = isolate();
    const own = join(dir, "my-own-codex");
    // The user-facing line, pinned as a literal: it must name both the export and the farm in use.
    const line =
      `Ignoring the shell's CODEX_HOME=${own}: codex.host is on, so Codex is wired at the per-host farm ${hostHome}`;
    // Key off: the export IS the home, so the write lands there and nothing is stale.
    process.env.CODEX_HOME = own;
    const unmanaged = await stderrDuring(configureCodex);
    expect(fs.existsSync(join(own, "config.toml"))).toBe(true);
    expect(unmanaged).not.toContain("Ignoring the shell's CODEX_HOME");
    // Key on: the farm is written and recorded; the export the launcher's pin would otherwise
    // have inherited is named exactly once ...
    const narrated = await stderrDuring(build);
    expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
    expect(occurrences(narrated, line)).toBe(1);
    // ... and a second resolution in the same process (a launch re-wires, then pins) stays quiet.
    expect(await stderrDuring(() => runCodex({ kind: "check" }))).not.toContain(line);
    // A shell that agrees (the wrapper's `agent profile env` refresh) has nothing to be told.
    process.env.CODEX_HOME = hostHome;
    expect(await stderrDuring(configureCodex)).not.toContain("Ignoring the shell's CODEX_HOME");
  },
);

// --- the `codex-home` root -------------------------------------------------------

skipWin(
  "resolveCodexHome: the four key states against the shell's export and the farm on disk (the home, and the note only where copilot-env decided it)",
  () => {
    const { sharedRoot, hostHome } = isolate();
    const root = join(dir, "explicit-root");
    const rootFarm = join(root, "hosts", getSanitizedHostname());
    const other = join(dir, "elsewhere");
    const cases = [
      // neither key: the shell's export IS the home, so it is never stale
      { codexHome: null, codexHost: false, home: sharedRoot, by: "default" },
      { codexHome: null, codexHost: true, home: hostHome, by: "farm" },
      { codexHome: root, codexHost: false, home: root, by: "codex-home" },
      { codexHome: root, codexHost: true, home: rootFarm, by: "farm" },
    ] as const;
    // The keys alone decide: the farm rows hold with the farm missing, holding a foreign config, or
    // ours (the next `agent profile sync --codex` builds or repairs it there).
    const farmStates: Record<string, (farm: string) => void> = {
      missing: (farm) => fs.rmSync(farm, { recursive: true, force: true }),
      foreign: (farm) => {
        fs.mkdirSync(farm, { recursive: true });
        fs.writeFileSync(join(farm, "config.toml"), 'model_provider = "openai"\n');
      },
      ours: (farm) => {
        writeCodexConfigToml(farm, { baseUrl: "https://api.githubcopilot.com" });
      },
    };
    for (const c of cases) {
      const farm = c.codexHome === null ? hostHome : rootFarm;
      for (const [state, stage] of Object.entries(farmStates)) {
        const name = `codex-home=${c.codexHome} codex-host=${c.codexHost} farm=${state}`;
        stage(farm);
        new CopilotEnvConfig().set({ "codex.home": c.codexHome, "codex.host": c.codexHost });
        delete process.env.CODEX_HOME;
        expect(resolveCodexHome(), name).toEqual({ home: c.home, by: c.by, staleExport: null });
        process.env.CODEX_HOME = c.home;
        expect(resolveCodexHome(), name).toEqual({ home: c.home, by: c.by, staleExport: null });
        process.env.CODEX_HOME = other;
        expect(resolveCodexHome(), name).toEqual(
          c.by === "default"
            ? { home: other, by: c.by, staleExport: null }
            : { home: c.home, by: c.by, staleExport: other },
        );
      }
      // The farm path follows the root whether or not the farm is on.
      expect(getHostLocalCodexHome(), c.by).toBe(farm);
    }
  },
);

skipWin(
  "codex-home roots the write, the farm, `--check`, `agent profile env`, and the launch pin; a stale export is narrated once",
  async () => {
    const { hostHome } = isolate();
    const root = join(dir, "explicit-root");
    const rootFarm = join(root, "hosts", getSanitizedHostname());
    const other = join(dir, "elsewhere");
    const note = (staleExport: string, home: string, by: "farm" | "codex-home"): string => {
      const line = staleCodexHomeExportLine({ home, by, staleExport });
      if (line === null) throw new Error("a differing export must produce the note");
      return line;
    };
    /** `agent profile check --codex`: its report (stdout) and what it narrates (stderr). */
    const check = async (): Promise<{ lines: string[]; narrated: string }> => {
      let lines: string[] = [];
      const narrated = await stderrDuring(async () => {
        lines = await stdoutLinesDuring(() => runCodex({ kind: "check" }));
      });
      return { lines, narrated };
    };

    // The path alone, while the shell exports another directory. A proxy launch runs the writer
    // and then reads the home for the child through the launcher's own dependency: one process,
    // one line.
    const exported = join(dir, "shell-export");
    process.env.CODEX_HOME = exported;
    new CopilotEnvConfig().set({ "codex.home": root });
    let pinned = "";
    let narrated = await stderrDuring(async () => {
      await configureCodex();
      pinned = narrateCodexHome(resolveCodexHome());
    });
    expect(fs.readFileSync(join(root, "config.toml"), "utf8")).toContain(
      'model_provider = "copilot-env"',
    );
    expect(occurrences(narrated, note(exported, root, "codex-home"))).toBe(1);
    expect(pinned).toBe(root); // what `agent profile launch codex` pins into the child
    expect(lexists(hostHome)).toBe(false);
    expect(effectiveCodexHome()).toBe(root);
    expect(managedCodexHome()).toEqual({ value: root }); // what `agent profile env` exports
    expect(codexHostDrift()).toBeNull();
    // A shell pointing elsewhere: the report names the home in use and narrates the export once.
    process.env.CODEX_HOME = other;
    const checked = await check();
    expect(checked.lines[0]).toMatch(/^Codex provider mode: proxy /);
    expect(checked.lines.slice(1)).toEqual([
      `CODEX_HOME: ${root}`,
      `config.toml: ${join(root, "config.toml")}`,
    ]);
    expect(occurrences(checked.narrated, note(other, root, "codex-home"))).toBe(1);
    process.env.CODEX_HOME = root; // the shell re-evaled `agent profile env`
    expect((await check()).narrated).toBe("");

    // The farm on too: it roots under the path, never at the default farm path.
    new CopilotEnvConfig().set({ "codex.host": true });
    await stderrDuring(configureCodex);
    expect(new CopilotEnvRunState().read().codexHome).toBe(rootFarm);
    expect(fs.readFileSync(join(rootFarm, "config.toml"), "utf8")).toContain(
      'model_provider = "copilot-env"',
    );
    expect(linkTarget(join(rootFarm, "sessions"))).toBe(join(root, "sessions"));
    expect(lexists(hostHome)).toBe(false);
    expect(effectiveCodexHome()).toBe(rootFarm);
    expect(managedCodexHome()).toEqual({ value: rootFarm });
    expect(codexHostDrift()).toBeNull();
    // A shell pointing elsewhere again: stale against the farm under the root. (The writer above
    // already narrated the root itself as the stale export, once per process.)
    process.env.CODEX_HOME = other;
    const farmChecked = await check();
    expect(farmChecked.lines[1]).toBe(`CODEX_HOME: ${rootFarm}`);
    expect(occurrences(farmChecked.narrated, note(other, rootFarm, "farm"))).toBe(1);

    // The path removed: the farm moves back under ~/.codex. The one under the user's path is left
    // where it is (the sweep knows only the current root), and the shell's export is now stale.
    new CopilotEnvConfig().del("codex.home");
    process.env.CODEX_HOME = rootFarm;
    narrated = await stderrDuring(configureCodex);
    expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
    expect(effectiveCodexHome()).toBe(hostHome);
    expect(lexists(rootFarm)).toBe(true);
    expect(occurrences(narrated, note(rootFarm, hostHome, "farm"))).toBe(1);
  },
);

// Fixtures mirror test/configure_defaults.test.ts: proxy on the default port 4141, so the read-back
// classifies both agents as proxy-wired.

const PROXY_CODEX_BASE = "http://127.0.0.1:4141/v1";
const PROXY_CLAUDE_BASE = "http://127.0.0.1:4141";

skipWin(
  "key on: the read-back resolves Codex through the farm and records the agreement",
  async () => {
    const { hostHome } = isolate();
    // Claude already proxy-wired: the farm's proxy config creates the agreement.
    writeClaudeSettings(join(dir, ".claude"), {
      apiKeyHelper: proxyHelperCommand(),
      baseUrl: PROXY_CLAUDE_BASE,
    });

    // The shell still points elsewhere; the read-back resolves Codex through the key's farm.
    process.env.CODEX_HOME = join(dir, "elsewhere");
    await build();
    expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
    expect(new CopilotEnvState().readProfileSlot(null).mode).toBe("proxy");
  },
);

skipWin(
  "key off while the shell still carries the dead farm export: the write and the read-back use ~/.codex",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    writeCodexConfigToml(sharedRoot, { baseUrl: PROXY_CODEX_BASE, envKey: "OPENAI_API_KEY" });
    writeClaudeSettings(join(dir, ".claude"), {
      apiKeyHelper: proxyHelperCommand(),
      baseUrl: PROXY_CLAUDE_BASE,
    });
    await build();
    new CopilotEnvConfig().set({ "codex.host": false });
    // The shell's inherited CODEX_HOME still carries the farm path; only the next `agent profile env` clears it.
    process.env.CODEX_HOME = hostHome;

    await configureCodex();
    expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
    // The farm stayed gone (not resurrected as a plain dir by the config write) ...
    expect(lexists(hostHome)).toBe(false);
    // ... the write landed at ~/.codex, and the read-back through it records the agreement.
    expect(fs.readFileSync(join(sharedRoot, "config.toml"), "utf8")).toContain(
      'model_provider = "copilot-env"',
    );
    expect(new CopilotEnvState().readProfileSlot(null).mode).toBe("proxy");
  },
);
