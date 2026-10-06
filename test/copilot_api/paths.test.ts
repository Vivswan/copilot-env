import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CopilotApiPaths,
  defaultDaemonHome,
  profileHome,
  resolveHome,
  RUN_DIR_NAME,
  SQLITE_DB_FILENAME,
  usageDbsUnderHome,
} from "../../src/copilot_api/paths.ts";
import { parseProfileName, type Profile } from "../../src/copilot_api/profile.ts";
import { getSanitizedHostname } from "../../src/utils/hostname.ts";
import { afterEach, expect, tempDir, test } from "../helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "../helpers/env.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
});

test("resolveHome prefers COPILOT_API_HOME and falls back to the documented ~/.local/share/copilot-env (empty included)", () => {
  // The fallback is spelled out, not read from DEFAULT_HOME: AGENTS.md documents this path as
  // the truth root, and a constant moved elsewhere would otherwise carry the test with it.
  const documented = join(homedir(), ".local", "share", "copilot-env");
  process.env.COPILOT_API_HOME = "/tmp/copilot-env-paths-home";
  expect(resolveHome()).toBe("/tmp/copilot-env-paths-home");
  delete process.env.COPILOT_API_HOME;
  expect(resolveHome(), "unset COPILOT_API_HOME").toBe(documented);
  process.env.COPILOT_API_HOME = "";
  expect(resolveHome(), "empty COPILOT_API_HOME").toBe(documented);
});

// --- THE default-home precedence rule (defaultDaemonHome) -------------------------

test("the default daemon home is profiles/default whatever the root holds: the root is never a daemon home", () => {
  const roots: { name: string; seed: (root: string) => void }[] = [
    { name: "fresh root", seed: () => {} },
    {
      name: "daemon files at the root",
      seed: (root) => {
        mkdirSync(join(root, ".run"), { recursive: true });
        writeFileSync(join(root, "config.json"), "{}\n");
      },
    },
  ];
  for (const { name, seed } of roots) {
    dir = isolateProxyHome("copilot-env-paths-");
    seed(dir);
    expect({ name, home: defaultDaemonHome() })
      .toEqual({ name, home: join(dir, "profiles", "default") });
  }
});

test("inside a daemon (ROOT_HOME_ENV set) the pinned COPILOT_API_HOME IS the home", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  // A named profile's daemon: COPILOT_API_HOME is its own isolated home, and the
  // zero-arg constructor must keep resolving to it, never to profiles/default.
  process.env.COPILOT_API_HOME = join(dir, "profiles", "work");
  process.env.COPILOT_ENV_ROOT_HOME = dir;
  expect(defaultDaemonHome()).toBe(join(dir, "profiles", "work"));
  expect(new CopilotApiPaths().home).toBe(join(dir, "profiles", "work"));
  // Account-wide files still anchor at the ROOT home.
  expect(new CopilotApiPaths().stateStoreFile).toBe(join(dir, "state.json"));
});

// --- CopilotApiPaths composition ---------------------------------------------------

test("CopilotApiPaths composes one per-host layout under profiles/default and profiles/<name> alike", () => {
  const work = parseProfileName("work");
  const rows: { name: string; profile: Profile; segment: string; paths: () => CopilotApiPaths }[] =
    [
      {
        name: "default profile",
        profile: null,
        segment: "default",
        paths: () => new CopilotApiPaths(),
      },
      {
        name: "named profile",
        profile: work,
        segment: "work",
        paths: () => new CopilotApiPaths(work),
      },
    ];
  for (const { name, profile, segment, paths: construct } of rows) {
    dir = isolateProxyHome("copilot-env-paths-");
    const home = join(dir, "profiles", segment);
    const runDir = join(home, ".run", getSanitizedHostname());
    const paths = construct();
    expect({
      name,
      home: paths.home,
      configFile: paths.configFile,
      runDir: paths.runDir,
      stateFile: paths.stateFile,
      logFile: paths.logFile,
      logsDir: paths.logsDir,
      sqliteDb: paths.sqliteDb,
    }).toEqual({
      name,
      home,
      configFile: join(home, "config.json"),
      runDir,
      stateFile: join(runDir, ".state.json"),
      logFile: join(runDir, ".log"),
      logsDir: join(home, "logs"),
      sqliteDb: join(runDir, "copilot-api.sqlite"),
    });
    if (profile !== null) expect(profileHome(profile)).toBe(home);
  }
});

test("account-wide files resolve to the ROOT home, never a daemon home or .run/<host>/", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  const paths = new CopilotApiPaths();

  // A regression moving any account-wide store into a daemon home or runDir must fail here.
  expect(paths.stateStoreFile).toBe(join(dir, "state.json"));
  expect(paths.stateStoreLock).toBe(join(dir, "locks", "state.json.lock"));
  expect(paths.codexModelCatalogFile).toBe(join(dir, "codex-model-catalog.json"));

  for (
    const rootFile of [
      paths.stateStoreFile,
      paths.codexModelCatalogFile,
    ]
  ) {
    expect(rootFile.startsWith(paths.home)).toBe(false);
    expect(rootFile.startsWith(paths.runDir)).toBe(false);
    expect(rootFile.startsWith(dir)).toBe(true);
  }
});

// Only ENOENT/ENOTDIR read as "nothing there"; a swallowed EACCES on a host dir would silently drop
// that host's DB from the cost totals. POSIX, non-root only: root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "usageDbsUnderHome propagates a stat failure instead of silently dropping a DB",
  () => {
    dir = tempDir("copilot-paths-");
    const home = join(dir, "home");
    const open = join(home, RUN_DIR_NAME, "host-a");
    const blocked = join(home, RUN_DIR_NAME, "host-b");
    mkdirSync(open, { recursive: true });
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(open, SQLITE_DB_FILENAME), "db");
    writeFileSync(join(blocked, SQLITE_DB_FILENAME), "db");
    chmodSync(blocked, 0o000);
    try {
      expect(() => usageDbsUnderHome(home)).toThrow(/EACCES/);
    } finally {
      chmodSync(blocked, 0o755);
    }
    // Control: with the dir readable again the sweep counts BOTH hosts' DBs.
    expect(usageDbsUnderHome(home).sort()).toEqual(
      [join(open, SQLITE_DB_FILENAME), join(blocked, SQLITE_DB_FILENAME)].sort(),
    );
  },
);
