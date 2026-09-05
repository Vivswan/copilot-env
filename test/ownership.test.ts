// The machine-local artifact-ownership ledger and the per-daemon-home projection
// record (src/copilot_api/ownership.ts): per-kind exact-path round-trips, junk
// degradation, and the 3.5.6 adoption of the pre-ledger state-store records
// (the ledger's own readers never consult them).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger, ProxyProjectionState } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

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

function readStateRaw(paths: CopilotApiPaths): Record<string, unknown> {
  return JSON.parse(readFileSync(paths.sharedStateFile, "utf8"));
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
  expect(basename(paths.ownershipFile)).toBe(".copilot-env-ownership.json");
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

test("a junk-degraded ledger owns less, never crashes; survivors come back trimmed", () => {
  const paths = isolate();
  // Hand-mangled file: junk entries drop individually, a padded entry still
  // matches the exact-path checks, an ill-typed list reads as owning nothing.
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

test("an unmigrated pre-ledger record in the state store owns nothing; only the migration moves it", () => {
  const paths = isolate();
  // A pre-ledger install: ownership sits under the LEGACY state-store keys.
  writeFileSync(
    paths.sharedStateFile,
    `${
      JSON.stringify({
        githubToken: "ghu_keep",
        webSearchDenyOwnedPaths: ["/a/settings.json"],
        claudeDesktopOwnedPaths: ["/lib/uuid.json"],
      })
    }\n`,
  );
  const ledger = new OwnershipLedger();
  expect(ledger.owns("webSearchDeny", "/a/settings.json")).toBe(false);
  expect(ledger.ownedPaths("claudeDesktop")).toEqual([]);

  // A release of the unowned path touches neither store: the state store's
  // legacy keys survive (the state store's own writes preserve them too) for
  // the migration to move, and no ledger file materializes.
  const stateBytes = readFileSync(paths.sharedStateFile, "utf8");
  ledger.release("webSearchDeny", "/a/settings.json");
  expect(readFileSync(paths.sharedStateFile, "utf8")).toBe(stateBytes);
  expect(existsSync(paths.ownershipFile)).toBe(false);
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: 5 });
  expect(readStateRaw(paths).webSearchDenyOwnedPaths).toEqual(["/a/settings.json"]);

  // A malformed ledger cannot take the record, so the adoption refuses BEFORE it
  // deletes the legacy keys (naming the ledger); both files keep their bytes.
  writeFileSync(paths.ownershipFile, "{ not json");
  const legacyBytes = readFileSync(paths.sharedStateFile, "utf8");
  expect(() => ledger.adoptLegacyRecords()).toThrow(
    `${paths.ownershipFile} is not valid JSON`,
  );
  expect(readFileSync(paths.sharedStateFile, "utf8")).toBe(legacyBytes);
  expect(readFileSync(paths.ownershipFile, "utf8")).toBe("{ not json");
});

test("adoptLegacyRecords moves both legacy kinds into the ledger and is idempotent", () => {
  const paths = isolate();
  writeFileSync(
    paths.sharedStateFile,
    `${
      JSON.stringify({
        githubToken: "ghu_keep",
        webSearchDenyOwnedPaths: ["/a/settings.json"],
        claudeDesktopOwnedPaths: ["/lib/uuid.json", 42, ""],
      })
    }\n`,
  );
  const ledger = new OwnershipLedger();
  // A post-update record already in the ledger must survive the merge.
  ledger.record("webSearchDeny", "/other/settings.json");

  ledger.adoptLegacyRecords();
  expect(ledger.ownedPaths("webSearchDeny").sort()).toEqual([
    "/a/settings.json",
    "/other/settings.json",
  ]);
  expect(ledger.ownedPaths("claudeDesktop")).toEqual(["/lib/uuid.json"]);
  const raw = readStateRaw(paths);
  expect(raw.webSearchDenyOwnedPaths).toBeUndefined();
  expect(raw.claudeDesktopOwnedPaths).toBeUndefined();
  expect(raw.githubToken).toBe("ghu_keep");

  // Re-run: nothing left to adopt, nothing rewritten.
  const ledgerBytes = readFileSync(paths.ownershipFile, "utf8");
  const stateBytes = readFileSync(paths.sharedStateFile, "utf8");
  ledger.adoptLegacyRecords();
  expect(readFileSync(paths.ownershipFile, "utf8")).toBe(ledgerBytes);
  expect(readFileSync(paths.sharedStateFile, "utf8")).toBe(stateBytes);
});

test("adoptLegacyRecords on a store without legacy keys writes nothing at all", () => {
  const paths = isolate();
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_x",
  });
  const stateBytes = readFileSync(paths.sharedStateFile, "utf8");
  new OwnershipLedger().adoptLegacyRecords();
  expect(existsSync(paths.ownershipFile)).toBe(false);
  expect(readFileSync(paths.sharedStateFile, "utf8")).toBe(stateBytes);
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

// THE ownership-boundary control: an unreadable record must NOT read as
// owns-nothing. owns()/ownedPaths() gate every take-back (the WebSearch deny,
// desktop entries, the codex catalog reference) and the projection record gates
// applyDefaultConfig's config.json deletions -- a false "not ours" leaves a deny
// with its replacement removed, so a failed read must surface, never flatten.
// Junk CONTENT keeps degrading (the tests above); a failed READ is different.
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
