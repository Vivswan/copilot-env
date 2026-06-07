import { expect, test } from "bun:test";

import { dueMigrations, type Migration } from "../src/migrations/index.ts";

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
  // Updating 1.2.5 -> 2.0.0 must not re-run the 1.2.1 migration.
  expect(dueMigrations("1.2.5", "2.0.0", LIST).map((m) => m.version)).toEqual(["1.2.5", "1.3.0"]);
});

test("dueMigrations is empty when already up to date", () => {
  expect(dueMigrations("1.3.0", "1.3.0", LIST)).toEqual([]);
});

test("dueMigrations tolerates a leading v on either bound", () => {
  expect(dueMigrations("v1.2.1", "v1.3.0", LIST).map((m) => m.version)).toEqual(["1.2.1", "1.2.5"]);
});
