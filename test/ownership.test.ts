import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { OwnershipLedger, ProxyProjectionState } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function isolate(): CopilotApiPaths {
  dir = isolateProxyHome("copilot-ownership-");
  const paths = new CopilotApiPaths();
  // The daemon home (profiles/default on a fresh root) so tests can seed
  // paths.projectionsFile with raw writeFileSync.
  mkdirSync(paths.home, { recursive: true });
  return paths;
}

test("ownership round-trips per kind; kinds never bleed into one another", () => {
  const paths = isolate();
  const ledger = new OwnershipLedger();
  expect(ledger.owns("webSearchDeny", "/a/settings.json")).toBe(false);

  ledger.record("webSearchDeny", "/a/settings.json");
  ledger.record("claudeDesktop", "/lib/uuid.json");
  ledger.record("codexCatalog", "/home/.codex/config.toml");

  const reread = new OwnershipLedger(paths);
  expect(reread.owns("webSearchDeny", "/a/settings.json")).toBe(true);
  // Exact-path doctrine: a different path (or the same path under another kind)
  // is never ours.
  expect(reread.owns("webSearchDeny", "/b/settings.json")).toBe(false);
  expect(reread.owns("claudeDesktop", "/a/settings.json")).toBe(false);
  expect(reread.ownedPaths("codexCatalog")).toEqual(["/home/.codex/config.toml"]);

  // Idempotent record: no duplicate entries.
  ledger.record("webSearchDeny", "/a/settings.json");
  expect(ledger.ownedPaths("webSearchDeny")).toEqual(["/a/settings.json"]);

  ledger.release("webSearchDeny", "/a/settings.json");
  expect(new OwnershipLedger(paths).owns("webSearchDeny", "/a/settings.json")).toBe(false);
});

test("the on-disk contract is pinned: filename and ledger keys", () => {
  const paths = isolate();
  // These spellings are external contracts (an existing install's records must
  // stay readable): a rename here would orphan every shipped ledger.
  expect(basename(paths.ownershipFile)).toBe("ownership.json");
  const ledger = new OwnershipLedger();
  ledger.record("webSearchDeny", "/a/settings.json");
  ledger.record("claudeDesktop", "/lib/uuid.json");
  ledger.record("codexCatalog", "/home/.codex/config.toml");
  expect(JSON.parse(readFileSync(paths.ownershipFile, "utf8"))).toEqual({
    webSearchDenyPaths: ["/a/settings.json"],
    claudeDesktopPaths: ["/lib/uuid.json"],
    codexCatalogConfigPaths: ["/home/.codex/config.toml"],
  });
});

test("a release with nothing recorded never materializes the ledger file", () => {
  const paths = isolate();
  new OwnershipLedger().release("claudeDesktop", "/lib/uuid.json");
  expect(existsSync(paths.ownershipFile)).toBe(false);
});

test("reads write nothing on a fresh home (no lock sidecar); a mutation takes the lock", () => {
  const paths = isolate();
  const before = readdirSync(dirname(paths.ownershipFile)).sort();
  const ledger = new OwnershipLedger();
  const reported = (fn: () => void): string[] => {
    deferWriteReports();
    try {
      fn();
      return flushWriteReports();
    } catch (e) {
      flushWriteReports();
      throw e;
    }
  };
  expect(reported(() => {
    expect(ledger.owns("claudeDesktop", "/lib/uuid.json")).toBe(false);
    expect(ledger.ownedPaths("codexCatalog")).toEqual([]);
  })).toEqual([]);
  expect(readdirSync(dirname(paths.ownershipFile)).sort()).toEqual(before);
  // The control, on disk: a mutation takes the ops lock (its sidecar lands under
  // locks/) and writes the ledger -- bookkeeping inside the data home, so it
  // prints nothing either.
  const sidecar = `${paths.ownershipOpsLock}.oslock`;
  expect(existsSync(sidecar)).toBe(false);
  expect(reported(() => ledger.record("claudeDesktop", "/lib/uuid.json"))).toEqual([]);
  expect(existsSync(sidecar)).toBe(true);
  expect(existsSync(paths.ownershipFile)).toBe(true);
});

test("a junk-degraded ledger owns less, never crashes; survivors come back trimmed", () => {
  const paths = isolate();
  writeFileSync(
    paths.ownershipFile,
    `${
      JSON.stringify({
        webSearchDenyPaths: ["/a/settings.json", 7, "", null, "  /b/settings.json  "],
        codexCatalogConfigPaths: { bogus: true },
        unknownKey: "ignored",
      })
    }\n`,
  );
  const ledger = new OwnershipLedger();
  expect(ledger.ownedPaths("webSearchDeny")).toEqual(["/a/settings.json", "/b/settings.json"]);
  expect(ledger.owns("webSearchDeny", "/b/settings.json")).toBe(true);
  expect(ledger.ownedPaths("codexCatalog")).toEqual([]);
});

// --- the per-daemon-home projection record (ProxyProjectionState) ----------------

test("recorded projection paths round-trip; an empty record never materializes a file", () => {
  const paths = isolate();
  const state = new ProxyProjectionState(paths);
  expect(state.ownedPaths()).toEqual([]);

  // Writing "nothing owned" over "nothing recorded" is a no-op, so a default-configured
  // start never litters every daemon home with an empty record file.
  state.setOwnedPaths([]);
  expect(existsSync(paths.projectionsFile)).toBe(false);

  state.setOwnedPaths([["contextManagement", "responses"], ["messageApiWebSearchModel"]]);
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([
    ["contextManagement", "responses"],
    ["messageApiWebSearchModel"],
  ]);

  state.setOwnedPaths([]);
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([]);
});

test("the projection parser drops a malformed entry WHOLE, never truncating it to a parent path", () => {
  const paths = isolate();
  writeFileSync(
    paths.projectionsFile,
    JSON.stringify({
      optInPaths: [
        // A non-string key drops the ENTIRE entry -- truncating it to ["contextManagement"]
        // would claim a parent record we never wrote.
        ["contextManagement", 5],
        ["", "responses"],
        [],
        "junk",
        ["messageApiWebSearchModel"],
      ],
    }),
  );
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([["messageApiWebSearchModel"]]);
});

test("a non-array optInPaths value reads as owning nothing", () => {
  const paths = isolate();
  writeFileSync(paths.projectionsFile, JSON.stringify({ optInPaths: { bogus: true } }));
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([]);
});

// owns()/ownedPaths() gate every take-back, so an unreadable record must throw, never read as
// owns-nothing: a false "not ours" leaves a WebSearch deny with its replacement removed.
//   junk CONTENT  -> degrades (the tests above)
//   failed READ   -> throws
// POSIX, non-root only: root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable ownership record THROWS at the read instead of owning nothing",
  () => {
    const paths = isolate();
    const ledger = new OwnershipLedger();
    ledger.record("webSearchDeny", "/a/settings.json");
    const projections = new ProxyProjectionState(paths);
    projections.setOwnedPaths([["smallModel"]]);

    chmodSync(paths.ownershipFile, 0o000);
    chmodSync(paths.projectionsFile, 0o000);
    try {
      expect(() => ledger.owns("webSearchDeny", "/a/settings.json")).toThrow(
        "refusing to treat an unreadable store as empty",
      );
      expect(() => ledger.ownedPaths("webSearchDeny")).toThrow(paths.ownershipFile);
      expect(() => projections.ownedPaths()).toThrow(paths.projectionsFile);
    } finally {
      chmodSync(paths.ownershipFile, 0o600);
      chmodSync(paths.projectionsFile, 0o600);
    }
    // Control: readable again, the recorded claims still answer in full.
    expect(ledger.owns("webSearchDeny", "/a/settings.json")).toBe(true);
    expect(projections.ownedPaths()).toEqual([["smallModel"]]);
  },
);
