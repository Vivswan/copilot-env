import { dueMigrations, type Migration, runMigrations } from "../src/migrations/index.ts";
import { expect, test } from "./helpers/testing.ts";

// Pure selection logic for which migrations run across a version range, with a synthetic
// registry so the real migrations' side effects are never triggered here. Migrations are
// named for the version they migrate AWAY FROM, and run for the range [from, to).
const mig = (version: string): Migration => ({ version, description: version, run: () => {} });
const LIST = [mig("1.2.1"), mig("1.2.5"), mig("1.3.0")];

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

test("the shipped registry is empty, so no range has anything due", async () => {
  // The deno rewrite deleted every historical step (each one re-derivable by
  // init/auth/claude/shell, or self-healing). This pins that state: adding a step back
  // has to be a deliberate edit to the registry, not an accident of a stale import.
  expect(dueMigrations("0.0.1", "999.0.0")).toEqual([]);
  await runMigrations("0.0.1", "999.0.0"); // no-op, and must not throw
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
