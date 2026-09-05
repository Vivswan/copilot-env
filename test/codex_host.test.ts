// The per-host CODEX_HOME farm (src/codex/host.ts), driven through the production
// path: `agent codex` (runCodex, proxy-forced so nothing probes the network)
// derives the farm from the `codex-host` key and writes the config. PATH points
// at an empty dir so the shared-home prime can never spawn a real codex CLI.

import * as fs from "node:fs";
import { join } from "node:path";
import { recordDefaultModeFromWiring } from "../src/agents/configure_defaults.ts";
import { proxyHelperCommand } from "../src/claude/config.ts";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { runCodex } from "../src/codex/config.ts";
import {
  codexHostDrift,
  codexHostFarm,
  effectiveCodexHome,
  getHostLocalCodexHome,
  isManagedFarmExport,
  planCodexHostFarm,
  withCodexHostFarm,
} from "../src/codex/host.ts";
import { runConfig } from "../src/commands/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { codexFarmHostsDir, getSanitizedHostname } from "../src/utils/hostname.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  isolateAgentHomes,
  removeDir,
  resetExitCode,
  writeClaudeSettings,
  writeCodexConfigToml,
  writeRunState,
} from "./helpers.ts";

// The farm needs POSIX symlinks; the farm tests mirror that guard. Windows CI
// still runs the path-derivation test below plus the Windows-only guard test.
const skipWin = test.skipIf(process.platform === "win32");
const onlyWin = test.skipIf(process.platform !== "win32");

const restoreEnv = envSnapshot(["PATH"]);
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
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

// Isolated homes plus an empty PATH dir (no codex resolvable => the prime step
// is a no-op and the build never leaves the temp tree or the network off).
// The disabled catalog sync inside applyCodexConfig sweeps homedir()/.codex;
// deno's node:os homedir() follows the HOME (POSIX) and USERPROFILE (Windows)
// isolateAgentHomes just set (it is not cached at startup, the way bun's was),
// so that sweep stays inside the temp tree too.
function isolate(): Farm {
  const homes = isolateAgentHomes("copilot-codex-host-");
  dir = homes.dir;
  const emptyBin = join(dir, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  process.env.PATH = emptyBin;
  return { sharedRoot: join(dir, ".codex"), hostHome: getHostLocalCodexHome() };
}

// The production path: `agent codex` (proxy-forced) derives the farm from the
// key, then writes the managed config at the effective home.
function configureCodex(): Promise<void> {
  return runCodex({ kind: "configure", mode: "proxy" }, NOOP_CATALOG_DEPS);
}

/** Turn the key on and run the wiring pass: what `agent config --set codex-host
 *  true` followed by `agent codex` does. */
function build(): Promise<void> {
  new CopilotEnvConfig().set({ codexHost: true });
  return configureCodex();
}

/** The paths the derivation narrates beside the farm: the two stores it writes. */
function storeFiles(): { config: string; state: string } {
  const paths = new CopilotApiPaths();
  return { config: paths.envConfigFile, state: paths.stateFile };
}

// Capture everything written to stderr while `run` executes (host.ts narrates
// every artifact and logs its conflict warnings through a consola bound to
// process.stderr). Output is swallowed during the window; the original writer
// is always restored.
async function stderrDuring(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/** The console.log lines `run` prints (`agent codex --check` reports on stdout). */
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

// Full structural snapshot of a tree: entry kind plus link target / file bytes,
// so an idempotency check catches any drift, not just additions.
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
});

// The shared our-export predicate's truth table, pinned directly: it gates both
// managedCodexHome's CODEX_HOME clear and the unmanaged-home skip, so its
// exact-spelling contract must never loosen.
test("isManagedFarmExport is true only for the exact farm spelling, built or not", () => {
  dir = isolateAgentHomes("copilot-codex-host-").dir;
  const hostHome = getHostLocalCodexHome();
  expect(isManagedFarmExport(hostHome)).toBe(true); // our export, farm absent
  expect(isManagedFarmExport(`${hostHome}/`)).toBe(false); // trailing slash: not our exact spelling
  expect(isManagedFarmExport(join(dir, "my-own-codex"))).toBe(false); // foreign path
  expect(isManagedFarmExport(undefined)).toBe(false); // no inherited CODEX_HOME
  expect(isManagedFarmExport("")).toBe(false); // empty spelling
  fs.mkdirSync(hostHome, { recursive: true });
  expect(isManagedFarmExport(hostHome)).toBe(true); // still ours once built: the record decides
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
    [false, farm(true, true), { action: "remove" }],
    [false, farm(true, false), { action: "remove" }], // half-built leftover
    [false, farm(false, false, "EACCES"), { action: "remove" }], // off wins over an unprobeable farm
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
  expect(() => runConfig({ set: ["codex-host", "true"] })).toThrow(
    "'codex-host' is only supported on Linux and macOS (this is win32)",
  );
  // Even a stored true (an imported bundle) reads as off here.
  new CopilotEnvConfig().set({ codexHost: true });
  expect(new CopilotEnvConfig().codexHostEnabled()).toBe(false);
  // A farm-shaped path (a home shared with a POSIX machine) is not ours: no drift,
  // and the derivation neither builds nor removes; the write goes to the effective home.
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(join(hostHome, "config.toml"), "x = 1\n");
  expect(codexHostDrift()).toBeNull();
  const written: string[] = [];
  await withCodexHostFarm((home) => {
    written.push(home);
    return Promise.resolve();
  });
  expect(written).toEqual([sharedRoot]);
  expect(lexists(join(hostHome, "config.toml"))).toBe(true);
  expect(new CopilotEnvRunState().read().codexHome).toBe(sharedRoot);
});

// --- farm build from scratch -------------------------------------------------

skipWin(
  "a fresh build lays out the full farm, records CODEX_HOME, and narrates every artifact",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    const narrated = await stderrDuring(build);
    // Nothing hidden: the farm, the run-state record, and the config write each get a line.
    expect(narrated).toContain(`Per-host CODEX_HOME farm built → ${hostHome}`);
    expect(narrated).toContain(`Active CODEX_HOME recorded → ${storeFiles().state}`);
    expect(narrated).toContain(`Codex config written → ${join(hostHome, "config.toml")}`);
    expect(narrated).not.toContain("Recorded codex-host"); // the key was set, not adopted

    // Host-local scratch dirs are real directories, never symlinks.
    for (const d of LOCAL_DIRS) {
      expect(isRealDir(join(hostHome, d))).toBe(true);
      expect(isSymlink(join(hostHome, d))).toBe(false);
    }

    // Host-local seed files are real files. With no shared counterpart the
    // migration marker and history seed empty; config.toml is then written by the
    // proxy config pass, so it carries the managed provider selection.
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

    // Shared dirs: a real directory at the shared root, an absolute symlink from
    // the host home.
    for (const d of SHARED_DIRS) {
      expect(isRealDir(join(sharedRoot, d))).toBe(true);
      expect(isSymlink(join(sharedRoot, d))).toBe(false);
      expect(linkTarget(join(hostHome, d))).toBe(join(sharedRoot, d));
    }

    // Shared files: an empty placeholder is created at the shared root and the
    // host home links to it.
    for (const f of SHARED_FILES) {
      expect(isRegularFile(join(sharedRoot, f))).toBe(true);
      expect(fs.readFileSync(join(sharedRoot, f), "utf8")).toBe("");
      expect(linkTarget(join(hostHome, f))).toBe(join(sharedRoot, f));
    }

    // Optional shared files get NO placeholder: the host-home symlink is created
    // anyway and dangles until something writes the shared file.
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

skipWin("building twice changes nothing (idempotent, byte for byte)", async () => {
  const { sharedRoot, hostHome } = isolate();
  await build();
  const before = snapshotTree(sharedRoot);
  const narrated = await stderrDuring(configureCodex);
  expect(snapshotTree(sharedRoot)).toEqual(before);
  expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
  // The re-derivation still reports what it touched, as a verification.
  expect(narrated).toContain(`Per-host CODEX_HOME farm verified → ${hostHome}`);
});

// --- shared-home prime (primeSharedCodexHomeIfMissing) -----------------------

skipWin(
  "a missing shared root primes via a codex on PATH, and its failure is swallowed",
  async () => {
    const { sharedRoot } = isolate();
    const bin = join(dir, "fake-bin");
    const marker = join(dir, "codex-invocations.log");
    fs.mkdirSync(bin, { recursive: true });
    // Exit nonzero on purpose: the prime is best-effort and must not fail the build.
    fs.writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nPATH=/usr/bin:/bin\nprintf '%s\\n' "$*" >> "${marker}"\ncat > /dev/null\nexit 3\n`,
      { mode: 0o755 },
    );
    // The fake bin dir FIRST, but with the system dirs kept: resolveCommand
    // resolves through `sh`, which must itself stay spawnable.
    process.env.PATH = `${bin}:/usr/bin:/bin`;

    await build();
    expect(fs.readFileSync(marker, "utf8")).toBe("exec\n");
    expect(isRealDir(sharedRoot)).toBe(true);
  },
);

skipWin("an existing shared root skips the codex prime entirely", async () => {
  const { sharedRoot } = isolate();
  fs.mkdirSync(sharedRoot, { recursive: true });
  const bin = join(dir, "fake-bin");
  const marker = join(dir, "codex-invocations.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh\nPATH=/usr/bin:/bin\nprintf '%s\\n' "$*" >> "${marker}"\ncat > /dev/null\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:/usr/bin:/bin`;

  await build();
  expect(lexists(marker)).toBe(false);
});

// --- local seeding (seedLocalCodexFileIfMissing, via history.jsonl) -----------

skipWin("an existing shared history.jsonl seeds the host-local copy", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.writeFileSync(join(sharedRoot, "history.jsonl"), '{"x":1}\n');

  await build();
  const local = join(hostHome, "history.jsonl");
  expect(isRegularFile(local)).toBe(true);
  expect(isSymlink(local)).toBe(false);
  expect(fs.readFileSync(local, "utf8")).toBe('{"x":1}\n');
});

skipWin("an existing host-local history.jsonl is left alone", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.writeFileSync(join(sharedRoot, "history.jsonl"), "shared\n");
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(join(hostHome, "history.jsonl"), "local\n");

  await build();
  expect(fs.readFileSync(join(hostHome, "history.jsonl"), "utf8")).toBe("local\n");
  expect(fs.readFileSync(join(sharedRoot, "history.jsonl"), "utf8")).toBe("shared\n");
});

skipWin("a host-local history.jsonl that is already a symlink is tolerated in place", async () => {
  const { hostHome } = isolate();
  fs.mkdirSync(hostHome, { recursive: true });
  const elsewhere = join(dir, "elsewhere-history");
  fs.symlinkSync(elsewhere, join(hostHome, "history.jsonl"));

  const warned = await stderrDuring(build);
  expect(linkTarget(join(hostHome, "history.jsonl"))).toBe(elsewhere);
  expect(warned).toContain(
    `Skipping local Codex seed because the path already exists as a symlink: ${
      join(hostHome, "history.jsonl")
    }`,
  );
});

// --- shared seeding (seedSharedCodexFileIfMissing, via AGENTS.md) -------------

skipWin(
  "a host-local AGENTS.md is promoted to the shared root and replaced by a symlink",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    fs.mkdirSync(hostHome, { recursive: true });
    fs.writeFileSync(join(hostHome, "AGENTS.md"), "agents\n");

    await build();
    expect(isRegularFile(join(sharedRoot, "AGENTS.md"))).toBe(true);
    expect(fs.readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("agents\n");
    expect(linkTarget(join(hostHome, "AGENTS.md"))).toBe(join(sharedRoot, "AGENTS.md"));
  },
);

skipWin("an empty shared AGENTS.md is refilled from a non-empty host-local copy", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.writeFileSync(join(sharedRoot, "AGENTS.md"), "");
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(join(hostHome, "AGENTS.md"), "agents\n");

  await build();
  expect(fs.readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("agents\n");
  expect(linkTarget(join(hostHome, "AGENTS.md"))).toBe(join(sharedRoot, "AGENTS.md"));
});

skipWin("conflicting AGENTS.md content keeps both copies and skips the symlink", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.writeFileSync(join(sharedRoot, "AGENTS.md"), "shared\n");
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(join(hostHome, "AGENTS.md"), "local\n");

  const warned = await stderrDuring(build);
  expect(fs.readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("shared\n");
  const local = join(hostHome, "AGENTS.md");
  expect(isRegularFile(local)).toBe(true);
  expect(isSymlink(local)).toBe(false);
  expect(fs.readFileSync(local, "utf8")).toBe("local\n");
  // The conflict is warned about and swallowed: the build still completes.
  expect(warned).toContain(`Leaving existing Codex path unchanged: ${local}`);
  expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
});

skipWin(
  "a wrong-target AGENTS.md symlink is left in place; the shared placeholder still lands",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    fs.mkdirSync(hostHome, { recursive: true });
    const elsewhere = join(dir, "elsewhere-agents");
    fs.symlinkSync(elsewhere, join(hostHome, "AGENTS.md"));

    await build();
    // Not repaired today: the existing symlink wins (with a warning)...
    expect(linkTarget(join(hostHome, "AGENTS.md"))).toBe(elsewhere);
    // ...while the shared placeholder is still created for other hosts.
    expect(isRegularFile(join(sharedRoot, "AGENTS.md"))).toBe(true);
    expect(fs.readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("");
  },
);

// --- optional shared seeding (installation_id) --------------------------------

skipWin("a host-local installation_id is promoted and symlinked; none is fabricated", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(join(hostHome, "installation_id"), "id-123");

  await build();
  expect(fs.readFileSync(join(sharedRoot, "installation_id"), "utf8")).toBe("id-123");
  expect(linkTarget(join(hostHome, "installation_id"))).toBe(join(sharedRoot, "installation_id"));
  // The other optional file stays a dangling symlink (no placeholder).
  expect(linkTarget(join(hostHome, "shell-init.sh"))).toBe(join(sharedRoot, "shell-init.sh"));
  expect(lexists(join(sharedRoot, "shell-init.sh"))).toBe(false);
});

// --- shared-dir promotion (ensureCodexDirSymlink / promoteCodexDirToSharedIfSafe)

skipWin("a host-local sessions dir merges into the shared root, symlinks preserved", async () => {
  const { sharedRoot, hostHome } = isolate();
  const localSessions = join(hostHome, "sessions");
  fs.mkdirSync(join(localSessions, "nested"), { recursive: true });
  fs.writeFileSync(join(localSessions, "top.txt"), "T");
  fs.writeFileSync(join(localSessions, "nested", "a.txt"), "A");
  const linkDest = join(dir, "session-target");
  fs.symlinkSync(linkDest, join(localSessions, "ln"));

  await build();
  const shared = join(sharedRoot, "sessions");
  expect(fs.readFileSync(join(shared, "top.txt"), "utf8")).toBe("T");
  expect(fs.readFileSync(join(shared, "nested", "a.txt"), "utf8")).toBe("A");
  expect(linkTarget(join(shared, "ln"))).toBe(linkDest);
  // The local dir is gone, replaced by the farm symlink.
  expect(linkTarget(join(hostHome, "sessions"))).toBe(shared);
});

skipWin("identical file content on both sides still merges and symlinks", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(join(sharedRoot, "sessions"), { recursive: true });
  fs.writeFileSync(join(sharedRoot, "sessions", "top.txt"), "same");
  fs.mkdirSync(join(hostHome, "sessions"), { recursive: true });
  fs.writeFileSync(join(hostHome, "sessions", "top.txt"), "same");

  await build();
  expect(fs.readFileSync(join(sharedRoot, "sessions", "top.txt"), "utf8")).toBe("same");
  expect(linkTarget(join(hostHome, "sessions"))).toBe(join(sharedRoot, "sessions"));
});

skipWin("conflicting file content refuses promotion and leaves the local dir", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(join(sharedRoot, "sessions"), { recursive: true });
  fs.writeFileSync(join(sharedRoot, "sessions", "top.txt"), "A");
  fs.mkdirSync(join(hostHome, "sessions"), { recursive: true });
  fs.writeFileSync(join(hostHome, "sessions", "top.txt"), "B");

  const warned = await stderrDuring(build);
  expect(fs.readFileSync(join(sharedRoot, "sessions", "top.txt"), "utf8")).toBe("A");
  const local = join(hostHome, "sessions");
  expect(isRealDir(local)).toBe(true);
  expect(isSymlink(local)).toBe(false);
  expect(fs.readFileSync(join(local, "top.txt"), "utf8")).toBe("B");
  // rc 2 is warned about and swallowed by the caller: the rest of the farm
  // still builds.
  expect(warned).toContain(`Leaving existing Codex path unchanged: ${local}`);
  expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
});

skipWin("a local subdir colliding with a shared file refuses promotion", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(join(sharedRoot, "sessions"), { recursive: true });
  fs.writeFileSync(join(sharedRoot, "sessions", "sub"), "a file");
  fs.mkdirSync(join(hostHome, "sessions", "sub"), { recursive: true });

  await build();
  expect(fs.readFileSync(join(sharedRoot, "sessions", "sub"), "utf8")).toBe("a file");
  expect(isRealDir(join(hostHome, "sessions"))).toBe(true);
  expect(isSymlink(join(hostHome, "sessions"))).toBe(false);
});

skipWin("symlink entries with differing targets refuse promotion", async () => {
  const { sharedRoot, hostHome } = isolate();
  fs.mkdirSync(join(sharedRoot, "sessions"), { recursive: true });
  fs.symlinkSync(join(dir, "target-a"), join(sharedRoot, "sessions", "ln"));
  fs.mkdirSync(join(hostHome, "sessions"), { recursive: true });
  fs.symlinkSync(join(dir, "target-b"), join(hostHome, "sessions", "ln"));

  await build();
  expect(linkTarget(join(sharedRoot, "sessions", "ln"))).toBe(join(dir, "target-a"));
  expect(isRealDir(join(hostHome, "sessions"))).toBe(true);
  expect(linkTarget(join(hostHome, "sessions", "ln"))).toBe(join(dir, "target-b"));
});

skipWin("a shared dir that is itself a symlink blocks promotion of the local dir", async () => {
  const { sharedRoot, hostHome } = isolate();
  const realShared = join(dir, "real-sessions");
  fs.mkdirSync(realShared, { recursive: true });
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.symlinkSync(realShared, join(sharedRoot, "sessions"));
  fs.mkdirSync(join(hostHome, "sessions"), { recursive: true });
  fs.writeFileSync(join(hostHome, "sessions", "top.txt"), "local");

  await build();
  expect(linkTarget(join(sharedRoot, "sessions"))).toBe(realShared);
  expect(isRealDir(join(hostHome, "sessions"))).toBe(true);
  expect(fs.readFileSync(join(hostHome, "sessions", "top.txt"), "utf8")).toBe("local");
});

skipWin("a wrong-target sessions symlink is tolerated, not repaired", async () => {
  const { sharedRoot, hostHome } = isolate();
  const elsewhere = join(dir, "elsewhere-sessions");
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.mkdirSync(hostHome, { recursive: true });
  fs.symlinkSync(elsewhere, join(hostHome, "sessions"));

  await build();
  expect(linkTarget(join(hostHome, "sessions"))).toBe(elsewhere);
  // The shared dir is still created for the other hosts.
  expect(isRealDir(join(sharedRoot, "sessions"))).toBe(true);
});

skipWin("a host-local sessions regular file is left alone and gets no symlink", async () => {
  const { hostHome } = isolate();
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(join(hostHome, "sessions"), "not a dir");

  await build();
  expect(isRegularFile(join(hostHome, "sessions"))).toBe(true);
  expect(fs.readFileSync(join(hostHome, "sessions"), "utf8")).toBe("not a dir");
  expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
});

skipWin("a shared dir slot occupied by a file fails the build with the farm error", async () => {
  const { sharedRoot } = isolate();
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.writeFileSync(join(sharedRoot, "sessions"), "not a dir");

  await expect(build()).rejects.toThrow(/Failed to build the CODEX_HOME symlink farm/);
  expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
});

skipWin(
  "a failed config write never activates the farm: no record, still the default home",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    // The build seeds the farm's config.toml from ~/.codex's; an unparseable one makes the
    // managed write refuse (it never overwrites a user file it cannot parse).
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.writeFileSync(join(sharedRoot, "config.toml"), "this = is = not toml\n");

    await expect(build()).rejects.toThrow();
    expect(isRealDir(hostHome)).toBe(true); // built ...
    expect(new CopilotEnvRunState().read().codexHome).toBeUndefined(); // ... but not activated
    expect(effectiveCodexHome()).toBe(sharedRoot);
  },
);

skipWin("an empty seeded config.toml is not wired: nothing to export until the write lands", () => {
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
  new CopilotEnvConfig().set({ codexHost: true });
  expect(codexHostDrift()).toEqual({ kind: "inactive", hostHome });
  writeRunState({ codexHome: hostHome });
  expect(codexHostFarm().active).toBe(true);
  expect(codexHostDrift()).toBeNull();
});

// --- key off (what `--delete-host` did) ---------------------------------------

skipWin(
  "turning the key off removes the per-host home, keeps the shared root, clears the record",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    await build();
    expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);

    new CopilotEnvConfig().set({ codexHost: false });
    const narrated = await stderrDuring(configureCodex);
    expect(lexists(hostHome)).toBe(false);
    for (const d of SHARED_DIRS) expect(isRealDir(join(sharedRoot, d))).toBe(true);
    for (const f of SHARED_FILES) expect(isRegularFile(join(sharedRoot, f))).toBe(true);
    expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
    // The default write then lands at the default home ($CODEX_HOME = the shared root here).
    expect(fs.readFileSync(join(sharedRoot, "config.toml"), "utf8")).toContain(
      'model_provider = "copilot-env"',
    );
    expect(narrated).toContain(`Per-host CODEX_HOME farm removed → ${hostHome}`);
    expect(narrated).toContain(`Active CODEX_HOME record cleared → ${storeFiles().state}`);
    expect(narrated).toContain(`Codex config written → ${join(sharedRoot, "config.toml")}`);
    expect(codexHostDrift()).toBeNull();
  },
);

skipWin("key off with no farm built only clears a stale record, and says so", async () => {
  const { hostHome } = isolate();
  writeRunState({ codexHome: hostHome });
  new CopilotEnvConfig().set({ codexHost: false });

  const narrated = await stderrDuring(configureCodex);
  expect(lexists(hostHome)).toBe(false);
  expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
  expect(narrated).not.toContain("farm removed");
  expect(narrated).toContain(`Active CODEX_HOME record cleared → ${storeFiles().state}`);
  // A second pass has nothing left to report about the farm.
  const quiet = await stderrDuring(configureCodex);
  expect(quiet).not.toContain("CODEX_HOME");
});

// --- an unset key is off ------------------------------------------------------

skipWin("an unset key behaves as off: an existing farm is removed and reported", async () => {
  const { sharedRoot, hostHome } = isolate();
  await build();
  new CopilotEnvConfig().del("codexHost"); // e.g. an install that built the farm before the key
  expect(codexHostDrift()).toEqual({ kind: "disabled", hostHome });

  const narrated = await stderrDuring(configureCodex);
  expect(lexists(hostHome)).toBe(false);
  expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
  expect(narrated).toContain(`Per-host CODEX_HOME farm removed → ${hostHome}`);
  expect(narrated).toContain(`Codex config written → ${join(sharedRoot, "config.toml")}`);
  expect(new CopilotEnvConfig().read().codexHost).toBeUndefined(); // never written for the user
  expect(codexHostDrift()).toBeNull();
});

// --- drift reports (`agent codex --check`) ------------------------------------

skipWin(
  "codexHostDrift and `agent codex --check` report every key-vs-disk disagreement",
  async () => {
    const { sharedRoot, hostHome } = isolate();
    const missingLine =
      `codex-host is on but the per-host CODEX_HOME farm is missing at ${hostHome}; run \`agent codex\` to rebuild it`;
    const check = () => stdoutLinesDuring(() => runCodex({ kind: "check" }));

    // Key on, nothing built yet (or hand-deleted): the check names the recovery command.
    new CopilotEnvConfig().set({ codexHost: true });
    expect(codexHostDrift()).toEqual({ kind: "missing", hostHome });
    const unbuilt = await check();
    expect(unbuilt[0]).toMatch(/^Codex provider mode: none /);
    expect(unbuilt.slice(1)).toEqual([
      `CODEX_HOME: ${sharedRoot}`,
      `config.toml: ${join(sharedRoot, "config.toml")}`,
      missingLine,
    ]);

    // Built: agreement, so the report is the plain three lines against the farm home.
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
    new CopilotEnvConfig().set({ codexHost: false });
    expect(codexHostDrift()).toEqual({ kind: "disabled", hostHome });
    expect((await check()).at(-1)).toBe(
      `codex-host is off but a per-host CODEX_HOME farm is still present at ${hostHome}; run \`agent codex\` to remove it`,
    );
  },
);

// --- the effective home and the dead export ------------------------------------

skipWin(
  "effectiveCodexHome: the record wins, then $CODEX_HOME unless it is OUR dead farm export",
  () => {
    const { sharedRoot, hostHome } = isolate();
    // A dead farm export (exact spelling, nothing on disk) is skipped for ~/.codex ...
    process.env.CODEX_HOME = hostHome;
    expect(effectiveCodexHome()).toBe(sharedRoot);
    // ... while any other spelling is the user's and stays the truth.
    process.env.CODEX_HOME = `${hostHome}/`;
    expect(effectiveCodexHome()).toBe(`${hostHome}/`);
    process.env.CODEX_HOME = join(dir, "my-own-codex");
    expect(effectiveCodexHome()).toBe(join(dir, "my-own-codex"));
    // OUR export is never the user's choice, built or not: without a record it is
    // skipped for ~/.codex (the record, not the shell, makes the farm the home).
    fs.mkdirSync(hostHome, { recursive: true });
    process.env.CODEX_HOME = hostHome;
    expect(effectiveCodexHome()).toBe(sharedRoot);
    // With the key on, the run-state record (the derivation's) wins over every env
    // value while its directory exists; a record for a hand-deleted farm is dead.
    new CopilotEnvConfig().set({ codexHost: true });
    writeRunState({ codexHome: join(dir, "recorded") });
    expect(effectiveCodexHome()).toBe(sharedRoot);
    fs.mkdirSync(join(dir, "recorded"));
    expect(effectiveCodexHome()).toBe(join(dir, "recorded"));
    // The key off (or unset) retires the record at once.
    new CopilotEnvConfig().set({ codexHost: false });
    expect(effectiveCodexHome()).toBe(sharedRoot);
    new CopilotEnvConfig().del("codexHost");
    expect(effectiveCodexHome()).toBe(sharedRoot);
  },
);

// --- default-mode recording (the read-back cli.ts runs after `agent codex`) ------
// Fixtures mirror test/configure_defaults.test.ts: proxy on the default daemon
// port (4141), so the read-back classifies both agents as proxy-wired.

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

    await build();
    recordDefaultModeFromWiring();
    expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
    // The read-back resolved Codex through the recorded farm home (the inherited
    // CODEX_HOME still points elsewhere), so the record is the truth.
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
    new CopilotEnvConfig().set({ codexHost: false });
    // The shell's inherited CODEX_HOME still carries the farm path (only the next
    // `agent env` clears it).
    process.env.CODEX_HOME = hostHome;

    await configureCodex();
    recordDefaultModeFromWiring();
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
