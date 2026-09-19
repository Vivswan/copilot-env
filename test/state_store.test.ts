// The one account-wide store (`state.json`): three maps, one file, one lock; settings and state
// keys share `global` and each `profiles.<name>`, and every reader picks its own keys out. The
// readers' own semantics are pinned in their files (state, env_config, ownership); this pins the
// store and the per-key setting|state rule.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runConfig } from "../src/commands/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { afterEach, beforeEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers/env.ts";

const restoreEnv = envSnapshot();
let dir = "";

beforeEach(() => {
  dir = isolateProxyHome("copilot-state-store-");
});

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

test("the three writers share one file under one lock, and each preserves the keys it does not own", () => {
  const paths = new CopilotApiPaths();
  new CopilotEnvConfig().set({ "daemon.port": 4242 });
  new CopilotEnvConfig().setProfile(null, { passthrough: "on" });
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_x",
  });
  new OwnershipLedger().record("claudeDesktop", "/lib/uuid.json");
  // One lock sidecar for the whole store, under locks/; none per former store.
  expect(existsSync(`${paths.stateStoreLock}.oslock`)).toBe(true);
  expect(existsSync(join(paths.locksDir, "credentials.json.lock.oslock"))).toBe(false);
  // A newer release's keys in `global` and in a profile map survive a settings write, and the
  // state keys sharing the maps survive it too.
  const doc = JSON.parse(readFileSync(paths.stateStoreFile, "utf8")) as {
    global: Record<string, unknown>;
    profiles: { default: Record<string, unknown> };
  };
  doc.global.future = 1;
  doc.profiles.default.futureSlotKey = true;
  writeFileSync(paths.stateStoreFile, `${JSON.stringify(doc)}\n`);
  new CopilotEnvConfig().set({ "daemon.port": 4243 });
  new CopilotEnvConfig().delProfile(null, "passthrough");
  const after = JSON.parse(readFileSync(paths.stateStoreFile, "utf8")) as typeof doc;
  expect(after.global.future).toBe(1);
  expect(after.global["daemon.port"]).toBe(4243);
  expect(after.profiles.default).toEqual({
    githubToken: "ghu_x",
    authProvider: "gh-token",
    futureSlotKey: true,
  });
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual(["/lib/uuid.json"]);
});

test("a settings reader never surfaces a state key, so the export bundle carries settings only", () => {
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_x",
  });
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: 5 });
  expect(new CopilotEnvConfig().read()).toEqual({ global: {}, profiles: {} });
  // Control: a setting beside the slot is read, and the slot stays whole beside it.
  new CopilotEnvConfig().setProfile(null, { passthrough: "on" });
  expect(new CopilotEnvConfig().read().profiles).toEqual({ default: { passthrough: "on" } });
  expect(new CopilotEnvState().readCredential(null)).toEqual({
    kind: "stored",
    provider: "gh-token",
    token: "ghu_x",
  });
});

test("a map emptied by its writer leaves the file; a missing or non-object map reads empty", () => {
  const paths = new CopilotApiPaths();
  new OwnershipLedger().record("claudeDesktop", "/lib/uuid.json");
  new OwnershipLedger().release("claudeDesktop", "/lib/uuid.json");
  expect(existsSync(paths.stateStoreFile)).toBe(true);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
  writeFileSync(paths.stateStoreFile, `${JSON.stringify({ ownership: 7, global: [] })}\n`);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
  expect(new CopilotEnvConfig().read()).toEqual({ global: {}, profiles: {} });
  expect(new CopilotEnvState().read().codexCatalogLastAttemptMs).toBe(0);
});

test("`agent config` writes settings only: a state key, bare or as a path into the file, is refused with its owner", () => {
  const cases: [string, RegExp][] = [
    ["githubToken", /`agent auth`, `agent profile`/],
    ["mode", /the wiring commands/],
    ["profiles.default.githubToken", /`agent auth`/],
    ["codexCatalogLastAttemptMs", /Codex catalog sync/],
    ["claudeDesktopPaths", /claims on the files they wrote/],
    ["ownership", /claims on the files they wrote/],
  ];
  for (const [key, owner] of cases) {
    expect(() =>
      runConfig({ kind: "set", key: key, value: "x", view: { kind: "config" }, dryRun: false })
    ).toThrow(owner);
    expect(() => runConfig({ kind: "unset", key: key, view: { kind: "config" }, dryRun: false }))
      .toThrow(/sets preferences only/);
  }
  // Control: a settings key still lands, and an unknown key still gets the unknown-key error.
  runConfig({
    kind: "set",
    key: "daemon.port",
    value: "4250",
    view: { kind: "config" },
    dryRun: false,
  });
  expect(new CopilotEnvConfig().defaultPort()).toBe(4250);
  expect(() =>
    runConfig({
      kind: "set",
      key: "global.daemon.port",
      value: "1",
      view: { kind: "config" },
      dryRun: false,
    })
  ).toThrow(
    /unknown config key/,
  );
});
