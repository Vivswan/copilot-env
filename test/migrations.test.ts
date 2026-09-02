import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { moveDataHome } from "../src/migrations/3.5.6.ts";
import { dueMigrations, type Migration, runMigrations } from "../src/migrations/index.ts";
import { readResolvedVersionRecord, writeResolvedVersionRecord } from "../src/proxy_float.ts";
import type { SemverString } from "../src/utils/semver.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, removeDir, tmpDir } from "./helpers.ts";

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

test("dueMigrations selects [from, to) in ascending order", () => {
  expect(dueMigrations("1.2.1", "1.3.0", LIST).map((m) => m.version)).toEqual(["1.2.1", "1.2.5"]);
});

test("dueMigrations includes the from-version, excludes the to-version", () => {
  expect(dueMigrations("1.2.5", "1.3.0", LIST).map((m) => m.version)).toEqual(["1.2.5"]);
});

test("dueMigrations skips versions already left behind", () => {
  // Updating 1.2.5 -> 3.0.0 must not re-run the 1.2.1 migration.
  expect(dueMigrations("1.2.5", "3.0.0", LIST).map((m) => m.version)).toEqual(["1.2.5", "1.3.0"]);
});

test("dueMigrations is empty when already up to date", () => {
  expect(dueMigrations("1.3.0", "1.3.0", LIST)).toEqual([]);
});

test("dueMigrations tolerates a leading v on either bound", () => {
  expect(dueMigrations("v1.2.1", "v1.3.0", LIST).map((m) => m.version)).toEqual(["1.2.1", "1.2.5"]);
});

test("the shipped registry holds exactly the 3.5.6 data-home move", () => {
  // Adding a step has to be a deliberate edit to the registry, not an accident of
  // a stale import; this pins the full set.
  expect(dueMigrations("0.0.1", "999.0.0").map((m) => m.version)).toEqual(["3.5.6"]);
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
