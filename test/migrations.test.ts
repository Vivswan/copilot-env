import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { startLockPath } from "../src/copilot_api/launch.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { defaultDaemonHome } from "../src/copilot_api/paths.ts";
import {
  moveDataHome,
  moveDefaultDaemonHome,
  v356,
  v356DefaultHome,
  v356DefaultSlot,
  v356Ownership,
  v356VersionedLayout,
} from "../src/migrations/3.5.6.ts";
import { v400LauncherShims } from "../src/migrations/4.0.0.ts";
import { dueMigrations, type Migration, runMigrations } from "../src/migrations/index.ts";
import { readResolvedVersionRecord, writeResolvedVersionRecord } from "../src/proxy_float.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "../src/scripts/daemon_lock.ts";
import { releaseFileLock, tryAcquireFileLock } from "../src/utils/file_lock.ts";
import type { SemverString } from "../src/utils/semver.ts";
import { denoRunArgs, importSpecifier, ROOT, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir, tmpDir, writeRunState } from "./helpers.ts";

// Pure selection logic for which migrations run across a version range, with a synthetic
// registry so the real migrations' side effects are never triggered here. Migrations are
// named for the version they migrate AWAY FROM, and run for the range [from, to).
const mig = (version: SemverString): Migration => ({
  version,
  description: version,
  run: () => {},
});
const LIST = [mig("1.2.1"), mig("1.2.5"), mig("1.3.0")];

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

test("dueMigrations selects [from, to) in ascending order over the registry", () => {
  // One row per selection guarantee, each named by its comment.
  const cases: { from: string; to: string; expected: string[] }[] = [
    { from: "1.2.1", to: "1.3.0", expected: ["1.2.1", "1.2.5"] }, // ascending [from, to)
    { from: "1.2.5", to: "1.3.0", expected: ["1.2.5"] }, // from included, to excluded
    { from: "1.2.5", to: "3.0.0", expected: ["1.2.5", "1.3.0"] }, // 1.2.1 already left behind never re-runs
    { from: "1.3.0", to: "1.3.0", expected: [] }, // already up to date: nothing due
    { from: "v1.2.1", to: "v1.3.0", expected: ["1.2.1", "1.2.5"] }, // leading v tolerated on either bound
  ];
  for (const { from, to, expected } of cases) {
    // The bounds ride along in the asserted value so a red run names the failing row.
    expect({ from, to, due: dueMigrations(from, to, LIST).map((m) => m.version) }).toEqual({
      from,
      to,
      due: expected,
    });
  }
});

test("the shipped registry holds exactly the named fix-ups in order, home move first", () => {
  // Adding a step has to be a deliberate edit to the registry, not an accident of
  // a stale import; this pins the full set BY IDENTITY and in order -- a count
  // (or a list of version strings) could stay green while a same-version fix-up
  // was silently dropped in a merge. Order matters within the version: the
  // later fix-ups read the state store the home move relocates, the default
  // daemon-home move relocates files inside that moved home, and the
  // layout adoption runs LAST of the 3.5.6 set (it relocates the install the others
  // fixed up). The 4.0.0 shim refresh converges that layout on the new release.
  expect(dueMigrations("0.0.1", "999.0.0")).toEqual([
    v356,
    v356Ownership,
    v356DefaultSlot,
    v356DefaultHome,
    v356VersionedLayout,
    v400LauncherShims,
  ]);
});

test("equal-version fix-ups keep their registry order across the sort", () => {
  const first = { ...mig("1.2.5"), description: "first" };
  const second = { ...mig("1.2.5"), description: "second" };
  expect(dueMigrations("1.0.0", "2.0.0", [first, second]).map((m) => m.description)).toEqual([
    "first",
    "second",
  ]);
});

test("an unparseable registry version throws instead of silently never running", () => {
  // The type demands a version-shaped literal, so only a cast reaches runtime -- but a
  // registry entry the range filter cannot see is a migration that never fires, so the
  // guard stays and names the offender.
  const bad = [mig("1.2.1"), { ...mig("1.2.5"), version: "oops" as SemverString }];
  expect(() => dueMigrations("1.0.0", "2.0.0", bad)).toThrow(
    'registry version (1.2.5) "oops" is not a semver version',
  );
});

test("an unparseable from or to bound throws instead of mis-selecting", () => {
  // A garbage `to` would otherwise select [] (no migration runs); a garbage `from`
  // would select everything below `to` -- both silent, both wrong.
  expect(() => dueMigrations("1.0.0", "oops", LIST)).toThrow(
    'to version "oops" is not a semver version',
  );
  expect(() => dueMigrations("oops", "2.0.0", LIST)).toThrow(
    'from version "oops" is not a semver version',
  );
});

test("runMigrations is best-effort: a failing step never stops the rest", async () => {
  const ran: string[] = [];
  const steps: Migration[] = [
    { version: "1.0.0", description: "ok", run: () => void ran.push("first") },
    {
      version: "1.1.0",
      description: "boom",
      run: () => {
        throw new Error("migration exploded");
      },
    },
    { version: "1.2.0", description: "ok", run: () => void ran.push("third") },
  ];
  // A migration hiccup must never abort an otherwise-successful update, so the third
  // step still runs after the second throws -- and runMigrations itself must not reject.
  await runMigrations("1.0.0", "2.0.0", steps);
  expect(ran).toEqual(["first", "third"]);
});

// --- the 3.5.6 data-home move (injectable core; real dirs never touched) --------

interface MoveFixture {
  legacy: string;
  next: string;
  codexConfig: string;
  desktopEntry: string;
  stopped: { count: number };
  run: () => Promise<void>;
}

/** A legacy home with a marker file, plus a codex config and a Desktop entry whose
 *  managed values point into it. */
function moveFixture(): MoveFixture {
  dir = tmpDir("copilot-migrate-");
  delete process.env.COPILOT_API_HOME; // the unpinned path is the one under test
  const legacy = join(dir, "copilot-api");
  const next = join(dir, "copilot-env");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "config.json"), "{}\n");
  // The float record pins its deno cache by absolute path into the home.
  writeResolvedVersionRecord(legacy, "2.3.3", 1_700_000_000_000, join(legacy, "proxy", "deno"));
  const codexConfig = join(dir, "codex-config.toml");
  writeFileSync(
    codexConfig,
    `model_provider = "copilot-env"\nmodel_catalog_json = "${
      join(legacy, "codex-model-catalog.json").replaceAll("\\", "\\\\")
    }"\n`,
  );
  const desktopEntry = join(dir, "entry.json");
  writeFileSync(
    desktopEntry,
    `${
      JSON.stringify({
        "inferenceCredentialHelper": join(legacy, "claude-desktop-token.sh"),
        "userKey": "keep",
      })
    }\n`,
  );
  const stopped = { count: 0 };
  return {
    legacy,
    next,
    codexConfig,
    desktopEntry,
    stopped,
    run: () =>
      moveDataHome({
        legacyHome: legacy,
        nextHome: next,
        stopDaemons: () => {
          stopped.count++;
          return Promise.resolve();
        },
        codexConfigPaths: () => [codexConfig],
        desktopEntryPaths: () => [desktopEntry],
      }),
  };
}

test("3.5.6 move: daemons stopped, dir renamed, both artifact kinds repointed", async () => {
  const fx = moveFixture();
  await fx.run();
  expect(fx.stopped.count).toBe(1);
  expect(existsSync(fx.legacy)).toBe(false);
  expect(existsSync(join(fx.next, "config.json"))).toBe(true);
  expect(readFileSync(fx.codexConfig, "utf8")).toContain(
    join(fx.next, "codex-model-catalog.json").replaceAll("\\", "\\\\"),
  );
  const entry = JSON.parse(readFileSync(fx.desktopEntry, "utf8")) as Record<string, unknown>;
  expect(entry["inferenceCredentialHelper"]).toBe(join(fx.next, "claude-desktop-token.sh"));
  expect(entry["userKey"]).toBe("keep"); // foreign keys survive
  // The float record's deno_dir followed the home; version/timestamp untouched.
  expect(readResolvedVersionRecord(fx.next)).toEqual({
    version: "2.3.3",
    resolvedAtMs: 1_700_000_000_000,
    denoDir: join(fx.next, "proxy", "deno"),
  });

  // Idempotent: a re-run has nothing to move and rewrites nothing.
  await fx.run();
  expect(fx.stopped.count).toBe(1);
});

test("3.5.6 move: a stopDaemons refusal aborts the move -- the legacy home is untouched", async () => {
  const fx = moveFixture();
  // The production stopDaemons (stopLegacyDaemons) throws for ANY daemon not confirmed
  // stopped -- a kill survivor, or a stop refused because the pid could not be
  // corroborated as ours. The move must then never race the (possibly live) writer.
  await expect(
    moveDataHome({
      legacyHome: fx.legacy,
      nextHome: fx.next,
      stopDaemons: () =>
        Promise.reject(new Error("a daemon (pid 123) under the legacy home would not stop")),
      codexConfigPaths: () => [fx.codexConfig],
      desktopEntryPaths: () => [fx.desktopEntry],
    }),
  ).rejects.toThrow("would not stop");
  expect(existsSync(join(fx.legacy, "config.json"))).toBe(true);
  expect(existsSync(fx.next)).toBe(false);
});

test(
  "3.5.6 move: the REAL stopLegacyDaemons guard aborts on a refused stop (subprocess)",
  async () => {
    dir = tmpDir("copilot-migrate-guard-");
    const home = join(dir, "home");
    // LEGACY_HOME is frozen from homedir() at module load, so the real guard is only
    // reachable in a subprocess whose HOME points at the sandbox BEFORE the import.
    const legacy = join(home, ".local", "share", "copilot-api");
    const next = join(home, ".local", "share", "copilot-env");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "{}\n");
    // The refusal, staged for real: THIS test process holds legacy's daemon.lock (the
    // marker names our pid -- alive, but nothing like a daemon), and legacy's run state
    // tracks the same pid. The child's stopTrackedProxy reads lock-"alive", cannot
    // corroborate the pid, and refuses with stopped: false -- the guard must abort the
    // rename rather than race the (possibly live) writer.
    expect(acquireDaemonLockForLife(legacy, { waitMs: 0 })).toBe(true);
    const savedApiHome = process.env.COPILOT_API_HOME;
    process.env.COPILOT_API_HOME = legacy;
    try {
      writeRunState({ pid: process.pid, port: 4141 });
    } finally {
      if (savedApiHome === undefined) delete process.env.COPILOT_API_HOME;
      else process.env.COPILOT_API_HOME = savedApiHome;
    }
    const worker = join(dir, "worker.ts");
    writeFileSync(
      worker,
      `import { v356 } from ${importSpecifier(join(ROOT, "src", "migrations", "3.5.6.ts"))};\n` +
        "try {\n" +
        "  await v356.run();\n" +
        "  console.log('guard-missed: the move ran');\n" +
        "} catch (e) {\n" +
        "  console.log(`aborted: ${(e as Error).message}`);\n" +
        "}\n",
    );
    // Full parent env (Windows children need SystemRoot etc.) with HOME repointed and
    // COPILOT_API_HOME removed -- set, it would opt the whole migration out.
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      HOME: home,
      USERPROFILE: home,
    };
    delete env.COPILOT_API_HOME;
    delete env.COPILOT_ENV_ROOT_HOME;
    try {
      const child = spawnChild(Deno.execPath(), {
        args: [...denoRunArgs(), worker],
        env,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await child.output();
      expect(new TextDecoder().decode(output.stdout)).toContain("would not stop");
      expect(existsSync(join(legacy, "config.json"))).toBe(true);
      expect(existsSync(next)).toBe(false);
    } finally {
      releaseFileLock(daemonLockPath(legacy));
    }
  },
  60_000,
);

test("3.5.6 move: both dirs existing is a refusal, never a merge", async () => {
  const fx = moveFixture();
  mkdirSync(fx.next, { recursive: true });
  await fx.run();
  expect(existsSync(join(fx.legacy, "config.json"))).toBe(true); // untouched
  expect(fx.stopped.count).toBe(0);
  // The codex value still points at the (still live) legacy home.
  expect(readFileSync(fx.codexConfig, "utf8")).toContain("copilot-api");
});

test("3.5.6 move: a pinned COPILOT_API_HOME opts the machine out entirely", async () => {
  const fx = moveFixture();
  process.env.COPILOT_API_HOME = fx.legacy;
  await fx.run();
  expect(existsSync(fx.legacy)).toBe(true);
  expect(fx.stopped.count).toBe(0);
});

test("3.5.6 move: foreign helper paths are never repointed", async () => {
  const fx = moveFixture();
  writeFileSync(
    fx.desktopEntry,
    `${JSON.stringify({ "inferenceCredentialHelper": "/opt/own/helper.sh" })}\n`,
  );
  await fx.run();
  const entry = JSON.parse(readFileSync(fx.desktopEntry, "utf8")) as Record<string, unknown>;
  expect(entry["inferenceCredentialHelper"]).toBe("/opt/own/helper.sh");
});

// --- the 3.5.6 ownership adoption (second fix-up of the step) --------------------

test("3.5.6 ownership: legacy records move into the ledger; a re-run finds nothing", async () => {
  dir = isolateProxyHome("copilot-migrate-own-");
  writeFileSync(
    join(dir, ".copilot-env-state.json"),
    `${
      JSON.stringify({
        githubToken: "ghu_keep",
        webSearchDenyOwnedPaths: ["/home/u/.claude/settings.json"],
        claudeDesktopOwnedPaths: ["/lib/uuid.json"],
      })
    }\n`,
  );

  await v356Ownership.run();
  const ledger = new OwnershipLedger();
  expect(ledger.ownedPaths("webSearchDeny")).toEqual(["/home/u/.claude/settings.json"]);
  expect(ledger.ownedPaths("claudeDesktop")).toEqual(["/lib/uuid.json"]);
  const raw = JSON.parse(readFileSync(join(dir, ".copilot-env-state.json"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(raw.webSearchDenyOwnedPaths).toBeUndefined();
  expect(raw.claudeDesktopOwnedPaths).toBeUndefined();
  expect(raw.githubToken).toBe("ghu_keep");

  // Idempotent: the re-run has nothing to adopt and rewrites nothing.
  const stateBytes = readFileSync(join(dir, ".copilot-env-state.json"), "utf8");
  await v356Ownership.run();
  expect(readFileSync(join(dir, ".copilot-env-state.json"), "utf8")).toBe(stateBytes);
});

// --- the 3.5.6 default-slot lift (third fix-up of the step) -----------------------

test("3.5.6 default slot: the top-level pair lifts into profiles.default; a re-run is a no-op", async () => {
  dir = isolateProxyHome("copilot-migrate-slot-");
  const stateFile = join(dir, ".copilot-env-state.json");
  writeFileSync(
    stateFile,
    `${
      JSON.stringify({
        githubToken: "ghu_keep",
        authProvider: "copilot",
        profiles: { work: { githubToken: "ghp_work", authProvider: "gh-token", mode: "proxy" } },
      })
    }\n`,
  );

  await v356DefaultSlot.run();
  const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  expect(raw.githubToken).toBeUndefined();
  expect(raw.authProvider).toBeUndefined();
  expect(raw.profiles?.default).toEqual({
    "authProvider": "copilot",
    "githubToken": "ghu_keep",
  });
  // Named slots are untouched (their stored keys are an external contract).
  expect(raw.profiles?.work).toEqual({
    "authProvider": "gh-token",
    "githubToken": "ghp_work",
    "mode": "proxy",
  });
  // The unified read answers identically after the lift.
  expect(new CopilotEnvState().readCredential(null)).toEqual({
    kind: "stored",
    provider: "copilot",
    token: "ghu_keep",
  });

  // Idempotent: the re-run finds nothing to lift and rewrites nothing.
  const stateBytes = readFileSync(stateFile, "utf8");
  await v356DefaultSlot.run();
  expect(readFileSync(stateFile, "utf8")).toBe(stateBytes);
});

test("3.5.6 default slot: a slot already holding a credential wins over a lingering pair", async () => {
  dir = isolateProxyHome("copilot-migrate-slot-");
  const stateFile = join(dir, ".copilot-env-state.json");
  writeFileSync(
    stateFile,
    `${
      JSON.stringify({
        githubToken: "ghu_stale",
        authProvider: "copilot",
        profiles: { default: { githubToken: "ghu_slot", authProvider: "gh-token" } },
      })
    }\n`,
  );
  await v356DefaultSlot.run();
  const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  expect(raw.githubToken).toBeUndefined();
  expect(raw.profiles?.default?.githubToken).toBe("ghu_slot");
  expect(raw.profiles?.default?.authProvider).toBe("gh-token");
});

test("3.5.6 default slot: a store without legacy keys is untouched; an absent file is never created", async () => {
  dir = isolateProxyHome("copilot-migrate-slot-");
  const stateFile = join(dir, ".copilot-env-state.json");
  // Fresh install: no state file at all -- the migration must not materialize one.
  await v356DefaultSlot.run();
  expect(existsSync(stateFile)).toBe(false);
  // Already-migrated (or never-authenticated) store: byte-identical after the run.
  writeFileSync(
    stateFile,
    `${JSON.stringify({ profiles: { default: { authProvider: "gh-cli" } } })}\n`,
  );
  const bytes = readFileSync(stateFile, "utf8");
  await v356DefaultSlot.run();
  expect(readFileSync(stateFile, "utf8")).toBe(bytes);
});

// --- the 3.5.6 default daemon-home move (fourth fix-up of the step) ----------------

// A pid no real process holds (far above any OS pid ceiling we run on): the fixture's
// stale lock marker must name a provably dead holder, or the dead-holder-only reclaim
// could refuse on a live coincidental pid and flake the test.
const DEAD_PID = 2_147_483_646;

/** A flat root: every daemon-home artifact at the root itself, a stale
 *  daemon.lock (marker file naming a dead pid, held by nobody), and the
 *  account-wide stores beside them. Returns the root (== dir). */
function flatRootFixture(): string {
  dir = isolateProxyHome("copilot-migrate-home-");
  mkdirSync(join(dir, ".run", "myhost"), { recursive: true });
  writeFileSync(join(dir, ".run", "myhost", ".state.json"), `${JSON.stringify({ port: 4141 })}\n`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}\n");
  writeFileSync(join(dir, ".copilot-env-projections.json"), "{}\n");
  writeFileSync(join(dir, "copilot-api.sqlite"), "");
  writeFileSync(daemonLockPath(dir), `${DEAD_PID}\n${Date.now()}\n`); // stale: holder dead
  writeFileSync(join(dir, ".copilot-env-state.json"), `${JSON.stringify({ profiles: {} })}\n`);
  writeFileSync(join(dir, "github_token"), "ghu_keep\n");
  return dir;
}

test("3.5.6 default home: the flat daemon files move whole into profiles/default", async () => {
  const root = flatRootFixture();
  await moveDefaultDaemonHome();
  const target = join(root, "profiles", "default");
  // The daemon-home set moved -- contents included -- and the stale lock marker was
  // DELETED, not moved (its holder is dead; the new home takes a fresh one).
  expect(readFileSync(join(target, ".run", "myhost", ".state.json"), "utf8")).toContain("4141");
  for (
    const name of ["config.json", ".copilot-env-projections.json", "logs", "copilot-api.sqlite"]
  ) {
    expect(existsSync(join(target, name))).toBe(true);
    expect(existsSync(join(root, name))).toBe(false);
  }
  expect(existsSync(join(root, ".run"))).toBe(false);
  expect(existsSync(daemonLockPath(root))).toBe(false);
  expect(existsSync(daemonLockPath(target))).toBe(false);
  // No staging leftover: the flip renamed it into place whole.
  expect(existsSync(join(root, "profiles", ".default.migrating"))).toBe(false);
  // The account-wide files stay at the root -- that separation is the design.
  expect(existsSync(join(root, ".copilot-env-state.json"))).toBe(true);
  expect(existsSync(join(root, "github_token"))).toBe(true);
  // The paths layer now resolves the default daemon into the moved home.
  expect(defaultDaemonHome()).toBe(target);
  // Idempotent: the re-run finds nothing flat and moves nothing.
  await moveDefaultDaemonHome();
  expect(existsSync(join(target, "config.json"))).toBe(true);
});

test("3.5.6 default home: a LIVE daemon.lock refuses the whole move, files untouched", async () => {
  const root = flatRootFixture();
  // Stand in for the still-running daemon: THIS process holds the root's lock.
  expect(acquireDaemonLockForLife(root, { waitMs: 0 })).toBe(true);
  try {
    await moveDefaultDaemonHome();
    // Nothing moved, nothing created: the daemon still owns the flat home.
    expect(existsSync(join(root, "profiles"))).toBe(false);
    expect(existsSync(join(root, "config.json"))).toBe(true);
    expect(existsSync(join(root, ".run", "myhost", ".state.json"))).toBe(true);
    expect(existsSync(daemonLockPath(root))).toBe(true);
    expect(defaultDaemonHome()).toBe(root); // flat tolerance still routes reads here
  } finally {
    releaseFileLock(daemonLockPath(root));
  }
});

test(
  "3.5.6 default home: a live PRE-LOCK daemon (tracked pid, no lock) refuses the move",
  async () => {
    const root = flatRootFixture();
    rmSync(daemonLockPath(root), { force: true }); // a pre-lock daemon holds no lock at all
    // A live daemon-shaped process tracked in the flat root's run state: the argv-scan
    // corroboration must refuse the move even though the lock is acquirable.
    const decoy = join(dir, "copilot-api-decoy.mjs");
    writeFileSync(decoy, "setTimeout(() => {}, 30_000);\n");
    const child = spawnChild(Deno.execPath(), {
      args: ["run", decoy, "start"],
      stdout: "null",
      stderr: "null",
    });
    try {
      writeRunState({ pid: child.pid, port: 4141 }); // resolves flat: the fixture is unmigrated
      await moveDefaultDaemonHome();
      expect(existsSync(join(root, "profiles", "default"))).toBe(false);
      expect(existsSync(join(root, "config.json"))).toBe(true);
      // The same refusal must hold when profiles/default ALREADY exists: the tracked
      // pid lives in the FLAT root's state file, which resolution no longer answers --
      // the check must read it by explicit path, or the per-file move would run under
      // the live daemon.
      mkdirSync(join(root, "profiles", "default"), { recursive: true });
      await moveDefaultDaemonHome();
      expect(existsSync(join(root, "config.json"))).toBe(true);
      expect(existsSync(join(root, "profiles", "default", "config.json"))).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await child.status;
    }
  },
  30_000,
);

test("3.5.6 default home: a busy start lock refuses the move (a launch is in flight)", async () => {
  const root = flatRootFixture();
  rmSync(daemonLockPath(root), { force: true });
  // Stand in for a mid-flight `agent start`: THIS process holds the global start lock
  // (which lives in the flat run dir while the root is unmigrated).
  const startLock = startLockPath();
  mkdirSync(dirname(startLock), { recursive: true });
  expect(tryAcquireFileLock(startLock, Number.POSITIVE_INFINITY)).toBe(true);
  try {
    await moveDefaultDaemonHome();
    expect(existsSync(join(root, "profiles"))).toBe(false);
    expect(existsSync(join(root, "config.json"))).toBe(true);
  } finally {
    releaseFileLock(startLock);
  }
});

test("3.5.6 default home: an UNREADABLE pid identity refuses the move (fail closed)", async () => {
  const root = flatRootFixture();
  rmSync(daemonLockPath(root), { force: true });
  // The tracked pid is alive (this very process) but its identity cannot be read -- a
  // restricted token, or a failed process scan. "Failed to look" is never "nobody
  // there": proceeding would relocate the home out from under a possibly-live pre-lock
  // daemon, so the move must refuse. (The kill paths' boolean scan reads this state as
  // false and would PROCEED here -- the inversion this control pins.)
  writeRunState({ pid: process.pid, port: 4141 });
  await moveDefaultDaemonHome(() => Promise.resolve("unknown" as const));
  expect(existsSync(join(root, "profiles", "default"))).toBe(false);
  expect(existsSync(join(root, "config.json"))).toBe(true);
  // Control: a CONFIDENT "no" (the pid is provably another process) proceeds -- the
  // refusal above is the classification's doing, not an unconditional block.
  await moveDefaultDaemonHome(() => Promise.resolve("no" as const));
  expect(existsSync(join(root, "profiles", "default", "config.json"))).toBe(true);
  expect(existsSync(join(root, "config.json"))).toBe(false);
});

test("3.5.6 default home: an artifact already in profiles/default is refused, never merged", async () => {
  const root = flatRootFixture();
  const target = join(root, "profiles", "default");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "config.json"), `{"keep":true}\n`);
  // A daemon RUNNING out of the pre-existing target refuses the per-file finish whole:
  // the flat root's lock says nothing about this home, so the move must take the
  // target's own lock before writing into it.
  expect(acquireDaemonLockForLife(target, { waitMs: 0 })).toBe(true);
  try {
    await moveDefaultDaemonHome();
    expect(existsSync(join(root, ".run"))).toBe(true); // nothing moved
  } finally {
    releaseFileLock(daemonLockPath(target));
  }
  await moveDefaultDaemonHome();
  // The conflicting artifact stayed on BOTH sides; the rest still moved.
  expect(readFileSync(join(target, "config.json"), "utf8")).toContain("keep");
  expect(existsSync(join(root, "config.json"))).toBe(true);
  expect(existsSync(join(target, ".run", "myhost", ".state.json"))).toBe(true);
  expect(existsSync(join(root, ".run"))).toBe(false);
});

test("3.5.6 default home: a crashed staging run resumes and still flips atomically", async () => {
  const root = flatRootFixture();
  // Stage what a mid-move crash leaves: some artifacts already in profiles/.default.migrating,
  // the rest still flat, and NO profiles/default -- reads must still resolve to the flat root.
  const staging = join(root, "profiles", ".default.migrating");
  mkdirSync(staging, { recursive: true });
  renameSync(join(root, "logs"), join(staging, "logs"));
  expect(defaultDaemonHome()).toBe(root); // no profiles/default yet: the flip never happened
  await moveDefaultDaemonHome();
  const target = join(root, "profiles", "default");
  expect(existsSync(join(target, "logs"))).toBe(true);
  expect(existsSync(join(target, "config.json"))).toBe(true);
  expect(existsSync(staging)).toBe(false);
  expect(defaultDaemonHome()).toBe(target);
});

test("3.5.6 default home: a FULLY staged crash still resolves flat, and the re-run finalizes", async () => {
  const root = flatRootFixture();
  rmSync(daemonLockPath(root), { force: true });
  // The worst crash point: EVERY artifact staged, the final rename never ran. With no
  // flat artifacts left, only the staging dir marks the root as mid-move -- without
  // that rule reads would see a fresh root and split from the staged data.
  const staging = join(root, "profiles", ".default.migrating");
  mkdirSync(staging, { recursive: true });
  for (
    const name of [
      "config.json",
      ".copilot-env-projections.json",
      ".run",
      "logs",
      "copilot-api.sqlite",
    ]
  ) {
    renameSync(join(root, name), join(staging, name));
  }
  expect(defaultDaemonHome()).toBe(root); // the staging dir alone keeps resolution flat
  await moveDefaultDaemonHome();
  const target = join(root, "profiles", "default");
  expect(readFileSync(join(target, ".run", "myhost", ".state.json"), "utf8")).toContain("4141");
  expect(existsSync(join(target, "config.json"))).toBe(true);
  expect(existsSync(staging)).toBe(false);
  expect(defaultDaemonHome()).toBe(target);
});

test("3.5.6 default home: a fresh (or migrated) root is a strict no-op", async () => {
  dir = isolateProxyHome("copilot-migrate-home-");
  writeFileSync(join(dir, ".copilot-env-state.json"), `${JSON.stringify({ profiles: {} })}\n`);
  await moveDefaultDaemonHome();
  // Nothing fabricated: no profiles dir, no daemon files, no lock marker.
  expect(existsSync(join(dir, "profiles"))).toBe(false);
  expect(existsSync(join(dir, "config.json"))).toBe(false);
  expect(existsSync(daemonLockPath(dir))).toBe(false);
});
