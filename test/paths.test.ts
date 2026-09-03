import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CopilotApiPaths,
  DEFAULT_HOME,
  defaultDaemonHome,
  profileHome,
  resolveHome,
  RUN_DIR_NAME,
  SQLITE_DB_FILENAME,
  usageDbsUnderHome,
} from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { getSanitizedHostname } from "../src/utils/hostname.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

test("DEFAULT_HOME is copilot-env's own data dir", () => {
  expect(DEFAULT_HOME).toBe(join(homedir(), ".local", "share", "copilot-env"));
});

test("resolveHome prefers COPILOT_API_HOME and falls back to DEFAULT_HOME (empty included)", () => {
  process.env.COPILOT_API_HOME = "/tmp/copilot-env-paths-home";
  expect(resolveHome()).toBe("/tmp/copilot-env-paths-home");
  delete process.env.COPILOT_API_HOME;
  expect(resolveHome()).toBe(DEFAULT_HOME);
  process.env.COPILOT_API_HOME = "";
  expect(resolveHome()).toBe(DEFAULT_HOME);
});

// --- THE default-home precedence rule (defaultDaemonHome) -------------------------

test("a fresh root resolves the default daemon home to profiles/default", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  expect(defaultDaemonHome()).toBe(join(dir, "profiles", "default"));
});

test("an unmigrated FLAT root (daemon files at the root itself) resolves to the root", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  // Any one daemon-home artifact at the root marks the flat legacy layout; the
  // account-wide files alone (state/config stores) must NOT.
  writeFileSync(join(dir, ".copilot-env-state.json"), "{}\n");
  expect(defaultDaemonHome()).toBe(join(dir, "profiles", "default"));
  mkdirSync(join(dir, ".run"), { recursive: true });
  expect(defaultDaemonHome()).toBe(dir);
});

test("profiles/default wins over lingering flat files once it exists", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  mkdirSync(join(dir, ".run"), { recursive: true }); // flat leftover
  mkdirSync(join(dir, "profiles", "default"), { recursive: true });
  expect(defaultDaemonHome()).toBe(join(dir, "profiles", "default"));
});

test("an unfinished migration staging dir alone still resolves to the flat root", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  // A crash after the last artifact staged but before the flip: no flat artifacts and
  // no profiles/default -- the staging dir is what proves the root is mid-move, not
  // fresh, so reads must not split onto an absent profiles/default.
  mkdirSync(join(dir, "profiles", ".default.migrating"), { recursive: true });
  expect(defaultDaemonHome()).toBe(dir);
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
  expect(new CopilotApiPaths().sharedStateFile).toBe(join(dir, ".copilot-env-state.json"));
});

// --- CopilotApiPaths composition ---------------------------------------------------

test("CopilotApiPaths composes per-host run files under the daemon home", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  const home = join(dir, "profiles", "default"); // fresh root: the uniform shape
  const paths = new CopilotApiPaths();
  const runDir = join(home, ".run", getSanitizedHostname());

  expect(paths.home).toBe(home);
  expect(paths.configFile).toBe(join(home, "config.json"));
  expect(paths.projectionsFile).toBe(join(home, ".copilot-env-projections.json"));
  expect(paths.runDir).toBe(runDir);
  expect(paths.stateFile).toBe(join(runDir, ".state.json"));
  expect(paths.logFile).toBe(join(runDir, ".log"));
  expect(paths.logsDir).toBe(join(home, "logs"));
  expect(paths.sqliteDb).toBe(join(runDir, "copilot-api.sqlite"));
});

test("a named profile's home has the identical shape under profiles/<name>", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  const work = parseProfileName("work");
  const home = join(dir, "profiles", "work");
  expect(profileHome(work)).toBe(home);
  const paths = new CopilotApiPaths(work);
  expect(paths.home).toBe(home);
  expect(paths.configFile).toBe(join(home, "config.json"));
  expect(paths.sqliteDb).toBe(join(home, ".run", getSanitizedHostname(), "copilot-api.sqlite"));
});

test("account-wide files resolve to the ROOT home, never a daemon home or .run/<host>/", () => {
  dir = isolateProxyHome("copilot-env-paths-");
  const paths = new CopilotApiPaths();

  // Load-bearing invariant: the credential store, the preferences store, the
  // ownership ledger, the proxy's own device-login token, and the Codex catalog
  // all live at the ROOT home (account/machine-wide) -- never inside the
  // default daemon's profiles/default home or the per-host runDir. A
  // regression moving any of them must fail here.
  expect(paths.sharedStateFile).toBe(join(dir, ".copilot-env-state.json"));
  expect(paths.envConfigFile).toBe(join(dir, ".copilot-env-config.json"));
  expect(paths.ownershipFile).toBe(join(dir, ".copilot-env-ownership.json"));
  expect(paths.githubTokenFile).toBe(join(dir, "github_token"));
  expect(paths.codexModelCatalogFile).toBe(join(dir, "codex-model-catalog.json"));

  for (
    const rootFile of [
      paths.sharedStateFile,
      paths.envConfigFile,
      paths.ownershipFile,
      paths.githubTokenFile,
      paths.codexModelCatalogFile,
    ]
  ) {
    expect(rootFile.startsWith(paths.home)).toBe(false);
    expect(rootFile.startsWith(paths.runDir)).toBe(false);
    expect(rootFile.startsWith(dir)).toBe(true);
  }
});

// The usage sweep's stat checks narrow like its own readdir: only ENOENT/ENOTDIR
// read as "nothing there". An EACCES one level below the home (a host dir the
// sweep cannot look into) must propagate -- swallowed, it silently drops that
// host's DB from the cost totals the list is summed into. POSIX, non-root only:
// root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "usageDbsUnderHome propagates a stat failure instead of silently dropping a DB",
  () => {
    dir = mkdtempSync(join(tmpdir(), "copilot-paths-"));
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
