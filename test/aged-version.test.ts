import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { pickAgedVersion } from "../src/install/aged-version.ts";

const DAY = 86_400_000;

// --- pure-function units: `now` is injected, so these are clock-independent ---
const NOW = Date.parse("2026-06-05T00:00:00.000Z");
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

// A realistic `npm view <pkg> time --json` payload: the created/modified
// bookkeeping keys plus stable releases at various ages and one prerelease.
const TIME: Record<string, string> = {
  created: iso(800),
  modified: iso(1),
  "1.0.0": iso(800),
  "1.2.9": iso(30),
  "1.2.10": iso(20),
  "1.10.0": iso(10),
  "2.0.0-rc.1": iso(15),
};

describe("pickAgedVersion", () => {
  test("picks the newest stable release older than the cutoff", () => {
    expect(pickAgedVersion(TIME, 7, NOW)).toBe("1.10.0");
  });

  test("excludes releases still inside the cooldown window", () => {
    // 1.10.0 is only 10d old; at 14d the newest qualifying release is 1.2.10 (20d).
    expect(pickAgedVersion(TIME, 14, NOW)).toBe("1.2.10");
  });

  test("orders by numeric semver, not lexically (1.2.10 > 1.2.9)", () => {
    // At 25d, 1.2.10 (20d) is too new, so it falls back to 1.2.9 (30d).
    expect(pickAgedVersion(TIME, 25, NOW)).toBe("1.2.9");
  });

  test("treats 1.10.0 as newer than 1.9.9 (numeric minor, not string)", () => {
    expect(pickAgedVersion({ "1.9.9": iso(40), "1.10.0": iso(40) }, 7, NOW)).toBe("1.10.0");
  });

  test("never selects a prerelease, even when it is newest and highest", () => {
    // 2.0.0-rc.1 (15d) is numerically the highest but must be skipped.
    expect(pickAgedVersion(TIME, 14, NOW)).not.toBe("2.0.0-rc.1");
  });

  test("ignores the created/modified bookkeeping keys", () => {
    expect(pickAgedVersion({ created: iso(800), modified: iso(1) }, 7, NOW)).toBeNull();
  });

  test("returns null when no release is old enough", () => {
    expect(pickAgedVersion(TIME, 1000, NOW)).toBeNull();
  });

  test("returns null for an empty map", () => {
    expect(pickAgedVersion({}, 7, NOW)).toBeNull();
  });

  test("counts a release published exactly at the cutoff as old enough", () => {
    expect(pickAgedVersion({ "3.0.0": iso(7) }, 7, NOW)).toBe("3.0.0");
  });
});

// --- real smoke tests: spawn the exact CLI both installers invoke ---
// (`npm view ... | bun src/install/aged-version.ts --days N`). process.execPath
// is the bun running this test, matching the installers. The CLI reads the real
// clock, so the fixture is built relative to live `Date.now()` with wide day
// gaps -- the few-seconds skew between here and the child can never flip a cutoff.
const RESOLVER = fileURLToPath(new URL("../src/install/aged-version.ts", import.meta.url));
const liveIso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();
const LIVE_TIME: Record<string, string> = {
  created: liveIso(800),
  modified: liveIso(1),
  "1.2.9": liveIso(30),
  "1.2.10": liveIso(20),
  "1.10.0": liveIso(10),
  "2.0.0-rc.1": liveIso(15),
};

function runCli(input: string, ...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [RESOLVER, ...args], { input, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim() };
}

describe("aged-version.ts CLI (the exact command the installers run)", () => {
  test("prints the resolved version and exits 0", () => {
    const result = runCli(JSON.stringify(LIVE_TIME), "--days", "14");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("1.2.10");
  });

  test("exits 4 (and prints nothing) when no release is old enough", () => {
    const result = runCli(JSON.stringify(LIVE_TIME), "--days", "1000");
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
  });

  test("exits 3 on unparseable stdin", () => {
    expect(runCli("not json at all", "--days", "7").status).toBe(3);
  });

  test("exits 3 on non-object JSON (array, string, number)", () => {
    expect(runCli("[]", "--days", "7").status).toBe(3);
    expect(runCli('"1.2.3"', "--days", "7").status).toBe(3);
    expect(runCli("42", "--days", "7").status).toBe(3);
  });

  test("exits 3 on empty stdin", () => {
    expect(runCli("", "--days", "7").status).toBe(3);
  });

  test("exits 2 on missing or invalid --days", () => {
    expect(runCli("{}").status).toBe(2); // no --days flag
    expect(runCli("{}", "--days", "-1").status).toBe(2);
    expect(runCli("{}", "--days", "abc").status).toBe(2);
  });
});
