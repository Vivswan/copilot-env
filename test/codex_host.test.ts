// Pins the CURRENT observable behavior of src/codex/host.ts (the per-host
// CODEX_HOME symlink farm) through its exported surface (getHostLocalCodexHome +
// runCodexHost): on-disk layout, symlink targets, seed contents, tolerated
// conflicts, and the swallowed-error paths exactly as they are today. Farm
// tests run proxy-forced so nothing probes the network, and
// PATH points at an empty dir so the shared-home prime can never spawn a real
// codex CLI from the machine running the suite.

import * as fs from "node:fs";
import { join } from "node:path";
import { getHostLocalCodexHome, runCodexHost } from "../src/codex/host.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { codexFarmHostsDir, getSanitizedHostname } from "../src/utils/hostname.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  isolateAgentHomes,
  removeDir,
  resetExitCode,
  writeRunState,
} from "./helpers.ts";

// host.ts guards every farm operation behind assertUnix (POSIX symlinks); the
// farm tests mirror that guard. Windows CI still runs the path-derivation test
// below plus the Windows-only guard test.
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
// Known suite-wide escape, shared with codex_config.test.ts: the disabled
// catalog sync inside applyCodexConfig sweeps homedir()/.codex, and bun caches
// os.homedir() at startup, so it READS the real ~/.codex/config.toml. It can
// never write there (the temp catalog path matches nothing real) and no
// assertion depends on that read.
function isolate(): Farm {
  const homes = isolateAgentHomes("copilot-codex-host-");
  dir = homes.dir;
  const emptyBin = join(dir, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  process.env.PATH = emptyBin;
  return { sharedRoot: join(dir, ".codex"), hostHome: getHostLocalCodexHome() };
}

function build(): Promise<void> {
  return runCodexHost({ mode: "proxy" });
}

// Capture everything written to stderr while `run` executes (host.ts logs its
// conflict warnings through a consola bound to process.stderr). Output is
// swallowed during the window; the original writer is always restored.
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

// --- platform guard (mirrors assertUnix: the Windows CI job runs only this) --

onlyWin(
  "runCodexHost refuses on Windows: exit code 1, nothing built, state untouched",
  async () => {
    const { sharedRoot } = isolate();
    writeRunState({ codexHome: "/pre-existing" });
    await runCodexHost({ mode: "proxy" });
    expect(process.exitCode).toBe(1);
    expect(lexists(sharedRoot)).toBe(false);
    // The guard fires before the delete branch too, so --delete-host is equally inert.
    resetExitCode();
    await runCodexHost({ mode: "proxy", delete: true });
    expect(process.exitCode).toBe(1);
    expect(new CopilotEnvRunState().read().codexHome).toBe("/pre-existing");
  },
);

// --- farm build from scratch -------------------------------------------------

skipWin("a fresh build lays out the full farm and persists CODEX_HOME to state", async () => {
  const { sharedRoot, hostHome } = isolate();
  await build();

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

  // The active CODEX_HOME is persisted so `agent env` exports it.
  expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
});

skipWin("building twice changes nothing (idempotent, byte for byte)", async () => {
  const { sharedRoot, hostHome } = isolate();
  await build();
  const before = snapshotTree(sharedRoot);
  await build();
  expect(snapshotTree(sharedRoot)).toEqual(before);
  expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);
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
    process.env.PATH = bin;

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
  process.env.PATH = bin;

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
    `Skipping local Codex seed because the path already exists as a symlink: ${join(hostHome, "history.jsonl")}`,
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

// --- delete (--delete-host) ---------------------------------------------------

skipWin("delete removes the per-host home, keeps the shared root, clears the state", async () => {
  const { sharedRoot, hostHome } = isolate();
  await build();
  expect(new CopilotEnvRunState().read().codexHome).toBe(hostHome);

  await runCodexHost({ mode: "proxy", delete: true });
  expect(lexists(hostHome)).toBe(false);
  for (const d of SHARED_DIRS) expect(isRealDir(join(sharedRoot, d))).toBe(true);
  for (const f of SHARED_FILES) expect(isRegularFile(join(sharedRoot, f))).toBe(true);
  expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
});

skipWin("delete with no farm built is a quiet no-op that still clears the state", async () => {
  const { hostHome } = isolate();
  writeRunState({ codexHome: hostHome });

  await runCodexHost({ mode: "proxy", delete: true });
  expect(lexists(hostHome)).toBe(false);
  expect(new CopilotEnvRunState().read().codexHome).toBeUndefined();
});
