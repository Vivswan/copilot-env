// Named credential/wiring profiles: the opt-in additions beside the default
// (settings-<name>.json, [profiles.<name>], per-profile credential slots and
// daemon homes). The default path must stay byte-identical throughout.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

import {
  configureClaudeConfig,
  inspectClaudeWiring,
  settingsPathFor,
} from "../src/claude/config.ts";
import { codexProviderId, configureCodexConfig } from "../src/codex/config.ts";
import { renderProfileTable, runProfile } from "../src/commands/profile.ts";
import { runStart } from "../src/commands/start.ts";
import { runStop } from "../src/commands/stop.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths, profileHome, profileHomeNames } from "../src/copilot_api/paths.ts";
import { copilotApiResolvePort, reserveProfilePort } from "../src/copilot_api/port.ts";
import { assertProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { isRecord } from "../src/utils/json.ts";

const WIN = process.platform === "win32";

const SAVED = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  COPILOT_API_HOME: process.env.COPILOT_API_HOME,
  COPILOT_ENV_ROOT_HOME: process.env.COPILOT_ENV_ROOT_HOME,
};
let dir = "";

function restore(key: keyof typeof SAVED): void {
  if (SAVED[key] === undefined) delete process.env[key];
  else process.env[key] = SAVED[key];
}

afterEach(() => {
  for (const k of Object.keys(SAVED) as (keyof typeof SAVED)[]) restore(k);
  // Reset to 0 (NOT undefined -- bun's setter ignores undefined), so a check test's
  // exit 1/2 never leaks into the whole `bun test` run.
  process.exitCode = 0;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

/** Isolated proxy home (credential store, run state, profile homes). */
function tmpProxyHome(): string {
  dir = mkdtempSync(join(tmpdir(), "copilot-profiles-"));
  process.env.COPILOT_API_HOME = join(dir, "proxy-home");
  delete process.env.COPILOT_ENV_ROOT_HOME;
  return process.env.COPILOT_API_HOME;
}

function tmpClaudeHome(): string {
  const home = join(dir, ".claude");
  process.env.CLAUDE_CONFIG_DIR = home;
  return home;
}

function tmpCodexHome(): string {
  const home = join(dir, ".codex");
  process.env.CODEX_HOME = home;
  return home;
}

// --- profile names ------------------------------------------------------------

test("assertProfileName accepts kebab names and rejects reserved/invalid ones", () => {
  assertProfileName("work");
  assertProfileName("gh-alt2");
  for (const bad of ["default", "direct", "proxy", "all"]) {
    expect(() => assertProfileName(bad)).toThrow(/reserved/);
  }
  for (const bad of ["", "-x", "Work", "a b", "x".repeat(33)]) {
    expect(() => assertProfileName(bad)).toThrow(/invalid profile name/);
  }
  // Windows reserved device names can't be directories there; cross-platform means
  // they're invalid everywhere.
  for (const bad of ["con", "nul", "prn", "aux", "com1", "lpt9"]) {
    expect(() => assertProfileName(bad)).toThrow(/reserved device name/);
  }
});

// --- credential store slots -----------------------------------------------------

test("named credential slots are isolated and never fall back to the default", () => {
  tmpProxyHome();
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_default");
  const work = new Credential(state, "work");

  // Hard-fail: no slot of its own -> null, even though the default resolves.
  expect(work.resolve()).toBeNull();
  expect(work.isAuthenticated()).toBe(false);

  work.store("gh-token", "ghp_work");
  expect(work.resolve()).toBe("ghp_work");
  expect(new Credential(state).resolve()).toBe("ghp_default");

  // Clearing the profile leaves the default untouched and drops the slot entirely.
  expect(work.clear()).toBe(true);
  expect(work.resolve()).toBeNull();
  expect(new Credential(state).resolve()).toBe("ghp_default");
  expect(state.read().profiles).toEqual({});
});

test("a store that never used profiles keeps the pre-profile on-disk shape", () => {
  tmpProxyHome();
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_default");
  const raw = JSON.parse(readFileSync(new CopilotApiPaths().sharedStateFile, "utf8")) as Record<
    string,
    unknown
  >;
  expect(Object.keys(raw)).toEqual(["authProvider", "githubToken"]);

  // Creating then fully clearing a profile drops the `profiles` key again.
  const work = new Credential(state, "work");
  work.store("gh-token", "ghp_work");
  work.clear();
  const raw2 = JSON.parse(readFileSync(new CopilotApiPaths().sharedStateFile, "utf8")) as Record<
    string,
    unknown
  >;
  expect(raw2.profiles).toBeUndefined();
});

// --- profile homes + ports ------------------------------------------------------

test("profile paths isolate the daemon home but share the account-wide files", () => {
  const root = tmpProxyHome();
  const def = new CopilotApiPaths();
  const work = new CopilotApiPaths("work");
  expect(work.home).toBe(join(root, "profiles", "work"));
  expect(work.home).toBe(profileHome("work"));
  expect(work.configFile.startsWith(work.home)).toBe(true);
  expect(work.sqliteDb.startsWith(work.home)).toBe(true);
  expect(work.stateFile.startsWith(work.home)).toBe(true);
  // Account-wide files anchor at the ROOT home for every profile.
  expect(work.sharedStateFile).toBe(def.sharedStateFile);
  expect(work.envConfigFile).toBe(def.envConfigFile);
  expect(work.codexModelCatalogFile).toBe(def.codexModelCatalogFile);
  expect(work.githubTokenFile).toBe(def.githubTokenFile);
});

test("COPILOT_ENV_ROOT_HOME re-anchors the shared files inside a profile daemon", () => {
  const root = tmpProxyHome();
  process.env.COPILOT_API_HOME = join(root, "profiles", "work");
  process.env.COPILOT_ENV_ROOT_HOME = root;
  const p = new CopilotApiPaths();
  expect(p.home).toBe(join(root, "profiles", "work"));
  expect(p.sharedStateFile).toBe(join(root, ".copilot-env-state.json"));
  expect(p.envConfigFile).toBe(join(root, ".copilot-env-config.json"));
});

test("reserveProfilePort records stable, distinct ports; resolve peeks read-only", () => {
  tmpProxyHome();
  const defaultPort = Number(copilotApiResolvePort());
  // Read-only peek: reports the candidate WITHOUT creating any state on disk
  // (--check/--dry-run callers must never mutate).
  const peek = Number(copilotApiResolvePort("work"));
  expect(peek).not.toBe(defaultPort);
  expect(CopilotEnvRunState.forProfile("work").read().port).toBeUndefined();
  expect(profileHomeNames()).toEqual([]);

  const work = reserveProfilePort("work");
  const alt = reserveProfilePort("gh-alt");
  expect(work).toBe(peek);
  expect(alt).not.toBe(defaultPort);
  expect(alt).not.toBe(work);
  // Stable: re-reserving and resolving both return the recorded reservation.
  expect(reserveProfilePort("work")).toBe(work);
  expect(Number(copilotApiResolvePort("work"))).toBe(work);
  expect(CopilotEnvRunState.forProfile("work").read().port).toBe(work);
  expect(profileHomeNames()).toEqual(["gh-alt", "work"]);
});

test("clearIfPid keeps a profile daemon's port reservation when asked", () => {
  tmpProxyHome();
  const state = CopilotEnvRunState.forProfile("work");
  state.set({ pid: 4242, port: 5555 });
  state.clearIfPid(4242, true);
  expect(state.read()).toEqual({ port: 5555 });
  state.set({ pid: 4242 });
  state.clearIfPid(4242);
  expect(state.read()).toEqual({});
});

// --- Claude profile artifacts ----------------------------------------------------

test("a direct Claude profile writes settings-<name>.json + a --profile helper, leaving the default untouched", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  const state = new CopilotEnvState();
  new Credential(state, "work").store("gh-token", "ghp_work");

  // Pre-existing default settings must stay byte-identical.
  configureClaudeConfig(home, "direct", { quiet: true });
  const defaultBefore = readFileSync(settingsPathFor(home), "utf8");

  configureClaudeConfig(home, "direct", { quiet: true, profile: "work" });

  expect(readFileSync(settingsPathFor(home), "utf8")).toBe(defaultBefore);
  const doc = JSON.parse(readFileSync(settingsPathFor(home, "work"), "utf8")) as Record<
    string,
    unknown
  >;
  const helperPath = String(doc.apiKeyHelper);
  expect(helperPath).toContain(`copilot-token-work.${WIN ? "cmd" : "sh"}`);
  const helper = readFileSync(helperPath, "utf8");
  expect(helper).toContain("--profile");
  expect(helper).toContain("work");
  expect(helper).not.toContain("ghp_work"); // never baked

  const status = inspectClaudeWiring(
    JSON.stringify(doc),
    home,
    Number(copilotApiResolvePort("work")),
    "work",
  );
  expect(status.providerMode).toBe("direct");
  // The default inspector must NOT recognize the profile file as managed.
  expect(inspectClaudeWiring(JSON.stringify(doc), home, 0).providerMode).toBe("other");
});

test("a direct Claude profile without its own credential is refused", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  new Credential().store("gh-token", "ghp_default"); // default cred must NOT satisfy it
  expect(() => configureClaudeConfig(home, "direct", { quiet: true, profile: "work" })).toThrow(
    /no credential of its own/,
  );
  expect(existsSync(settingsPathFor(home, "work"))).toBe(false);
});

test("a proxy Claude profile bakes ITS reserved port and blanks the direct-only env keys", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  configureClaudeConfig(home, "proxy", { quiet: true, profile: "fast" });
  const doc = JSON.parse(readFileSync(settingsPathFor(home, "fast"), "utf8")) as Record<
    string,
    unknown
  >;
  const env = isRecord(doc.env) ? doc.env : {};
  expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${copilotApiResolvePort("fast")}`);
  // Blanked (not deleted): the overlay layers over a possibly-direct default.
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("");
  expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("");
  const helper = readFileSync(String(doc.apiKeyHelper), "utf8");
  expect(helper).toContain("--profile");
  expect(helper).toContain("fast");
});

test("a foreign settings-<name>.json is never taken over", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  configureClaudeConfig(home, "proxy", { quiet: true }); // creates the home
  writeFileSync(
    settingsPathFor(home, "work"),
    JSON.stringify({ apiKeyHelper: "/somewhere/else.sh" }),
  );
  expect(() => configureClaudeConfig(home, "proxy", { quiet: true, profile: "work" })).toThrow(
    /refusing to overwrite/,
  );
  // A custom base URL ALONE (no apiKeyHelper) is also foreign wiring.
  writeFileSync(
    settingsPathFor(home, "alt"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://my-gateway.example" } }),
  );
  expect(() => configureClaudeConfig(home, "proxy", { quiet: true, profile: "alt" })).toThrow(
    /refusing to overwrite/,
  );
});

// --- Codex profile artifacts ------------------------------------------------------

function readToml(path: string): Record<string, unknown> {
  return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("a Codex profile writes [profiles.<name>] + its provider table, leaving the default selection untouched", () => {
  tmpProxyHome();
  const codexHome = tmpCodexHome();
  const state = new CopilotEnvState();
  new Credential(state, "work").store("gh-token", "ghp_work");

  expect(configureCodexConfig(codexHome, "direct", { quiet: true })).toBe(0);
  const before = readToml(join(codexHome, "config.toml"));
  expect(before.model_provider).toBe("copilot-env");

  expect(configureCodexConfig(codexHome, "direct", { quiet: true, profile: "work" })).toBe(0);
  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBe("copilot-env"); // untouched
  const profiles = doc.profiles as Record<string, Record<string, unknown>>;
  expect(profiles.work?.model_provider).toBe(codexProviderId("work"));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  const table = providers[codexProviderId("work")];
  expect(table).toBeDefined();
  const auth = table?.auth as Record<string, unknown>;
  expect(JSON.stringify(auth.args)).toContain("--profile");
  expect(JSON.stringify(auth.args)).toContain("work");
  // The default table is still the unsuffixed contract.
  expect(providers["copilot-env"]).toBeDefined();
});

test("a Codex profile write on a FRESH config leaves no dangling default model_provider", () => {
  tmpProxyHome();
  const codexHome = tmpCodexHome();
  expect(
    configureCodexConfig(codexHome, "proxy", {
      quiet: true,
      profile: "fast",
      baseUrl: `http://127.0.0.1:${copilotApiResolvePort("fast")}/v1`,
    }),
  ).toBe(0);
  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBeUndefined();
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId("fast")]).toBeDefined();
  // Proxy profiles force the global sandbox loopback exemption (auth.command needs it).
  const sandbox = doc.sandbox_workspace_write as Record<string, unknown>;
  expect(sandbox.network_access).toBe(true);
});

test("a Codex profile write on an EMPTY config file also leaves no dangling model_provider", () => {
  tmpProxyHome();
  const codexHome = tmpCodexHome();
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "   \n");
  expect(configureCodexConfig(codexHome, "direct", { quiet: true, profile: "fast" })).toBe(0);
  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBeUndefined();
});

test("profile --sync refreshes wiring from the STORE mode and never touches model_provider", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  new Credential(undefined, "fast").store("gh-token", "ghp_fast");
  new CopilotEnvState().setProfileMode("fast", "proxy");
  const port = copilotApiResolvePort("fast");
  // Seed a deliberately stale codex table; leave the top-level provider unset
  // (the --mobile pairing state) to prove sync never touches it.
  expect(
    configureCodexConfig(codexHome, "proxy", {
      quiet: true,
      profile: "fast",
      baseUrl: "http://127.0.0.1:1/v1",
    }),
  ).toBe(0);
  expect(readToml(join(codexHome, "config.toml")).model_provider).toBeUndefined();

  await runProfile({ sync: true });

  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBeUndefined(); // still untouched
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId("fast")]?.base_url).toBe(`http://127.0.0.1:${port}/v1`);
  // The Claude side was (re)written too -- one sync covers both agents.
  expect(existsSync(settingsPathFor(claudeHome, "fast"))).toBe(true);
});

test("profile --check is store-driven: exit 1 unknown/incomplete, 2 proxy, 0 direct", async () => {
  tmpProxyHome();
  await runProfile({ check: "ghost" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  const state = new CopilotEnvState();
  // Mode without credential is INCOMPLETE under the atomic model: never launchable.
  state.setProfileMode("fast", "proxy");
  await runProfile({ check: "fast" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  new Credential(state, "fast").store("gh-token", "ghp_fast");
  await runProfile({ check: "fast" });
  expect(process.exitCode).toBe(2);
  process.exitCode = 0;
  state.setProfileMode("fast", "direct");
  await runProfile({ check: "fast" });
  expect(process.exitCode).toBe(0);
});

test("renderProfileTable aligns columns under a header and flags incomplete slots", () => {
  const table = renderProfileTable([
    { name: "fast", provider: "gh-cli", mode: "proxy", daemon: { up: true, port: 4142 } },
    { name: "idle", provider: "gh-cli", mode: "proxy", daemon: { up: false } },
    { name: "warm", provider: "gh-cli", mode: "proxy", daemon: { up: true } },
    { name: "work", provider: "gh-token", mode: "direct", daemon: null },
    { name: "broken", provider: null, mode: null, daemon: null },
  ]);
  // Strip ANSI styling (the local run may have color enabled) so the
  // plain-text assertions hold everywhere. The escape byte is built with
  // fromCharCode: a literal control character in a regex is a lint error.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
  const lines = table.split("\n").map((l) => l.replace(ansi, ""));
  expect(lines[0]).toBe("     NAME      MODE          PROVIDER         DAEMON");
  expect(lines[1]).toBe("     fast      proxy         gh-cli           up (port 4142)");
  expect(lines[2]).toBe("     idle      proxy         gh-cli           down");
  // A tracked-but-portless daemon renders a bare "up", never "port undefined".
  expect(lines[3]).toBe("     warm      proxy         gh-cli           up");
  // A direct profile has no daemon: "-", never a blank that reads as missing data.
  expect(lines[4]).toBe("     work      direct        gh-token         -");
  // Missing mode/credential surface as repairable gaps, not blanks.
  expect(lines[5]).toBe("     broken    incomplete    no credential    -");
});

test("profile --add wires both agents atomically; --del removes everything", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  await runProfile({ add: "work", proxy: true, set: "ghp_worktoken" });

  const state = new CopilotEnvState();
  expect(state.readProfileSlot("work").mode).toBe("proxy");
  expect(state.readProfileSlot("work").authProvider).toBe("gh-token");
  expect(existsSync(settingsPathFor(claudeHome, "work"))).toBe(true);
  const doc = readToml(join(codexHome, "config.toml"));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId("work")]).toBeDefined();
  expect((doc.profiles as Record<string, Record<string, unknown>>).work?.model_provider).toBe(
    codexProviderId("work"),
  );

  // Mode switch: re-add with the other flag flips BOTH agents (one mode, never both).
  await runProfile({ add: "work", direct: true });
  expect(state.readProfileSlot("work").mode).toBe("direct");
  const flipped = readToml(join(codexHome, "config.toml"));
  const flippedTable = (flipped.model_providers as Record<string, Record<string, unknown>>)[
    codexProviderId("work")
  ];
  expect(flippedTable?.base_url).toBe("https://api.githubcopilot.com");

  await runProfile({ del: "work" });
  expect(state.readProfileSlot("work")).toEqual({
    githubToken: null,
    authProvider: null,
    mode: null,
  });
  expect(existsSync(settingsPathFor(claudeHome, "work"))).toBe(false);
  const after = readToml(join(codexHome, "config.toml"));
  expect(
    (after.model_providers as Record<string, unknown> | undefined)?.[codexProviderId("work")],
  ).toBeUndefined();
  expect(after.profiles).toBeUndefined();
  expect(existsSync(profileHome("work"))).toBe(false);
});

test("profile --add requires a mode for a new profile and rejects both flags", async () => {
  tmpProxyHome();
  tmpClaudeHome();
  tmpCodexHome();
  expect(runProfile({ add: "work", set: "ghp_x" })).rejects.toThrow(/--direct or --proxy/);
  expect(runProfile({ add: "work", direct: true, proxy: true, set: "ghp_x" })).rejects.toThrow(
    /mutually exclusive/,
  );
  // Same conflict contract as `agent auth`: --set is the gh-token path; a different
  // explicit provider must error, never be silently coerced to gh-token.
  expect(
    runProfile({ add: "work", proxy: true, provider: "copilot", set: "ghp_x" }),
  ).rejects.toThrow(/--set only applies/);
});

test("stop/record-event against a never-existing profile fabricate NOTHING", async () => {
  tmpProxyHome();
  await runStop({ profile: "typo" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  await runStart({ recordEvent: true, profile: "typo" });
  // Neither command may materialize a phantom profile home (profile --list,
  // stop --all, and the proxy float all enumerate profile homes).
  expect(existsSync(profileHome("typo"))).toBe(false);
  expect(profileHomeNames()).toEqual([]);
});
