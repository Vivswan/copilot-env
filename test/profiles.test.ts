// Named credential/wiring profiles: the opt-in additions beside the default
// (settings-<name>.json, [profiles.<name>], per-profile credential slots and
// daemon homes). The default path must stay byte-identical throughout.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { configureClaudeConfig, inspectClaudeWiring } from "../src/claude/config.ts";
import { CLAUDE_DESKTOP_DIR_ENV, desktopLibraryDirUnder } from "../src/claude/desktop.ts";
import { settingsPathFor } from "../src/claude/paths.ts";
import { codexProviderId, configureCodexConfig } from "../src/codex/config.ts";
import { parseProfileAction, renderProfileTable, runProfile } from "../src/commands/profile.ts";
import { runStart } from "../src/commands/start.ts";
import { parseStopAction, runStop } from "../src/commands/stop.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { setIntegrationProbeFetch } from "../src/copilot_api/integration_identity.ts";
import { CopilotApiPaths, profileHome, profileHomeNames } from "../src/copilot_api/paths.ts";
import {
  copilotApiFallbackPort,
  copilotApiResolvePort,
  reserveProfilePort,
} from "../src/copilot_api/port.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { isRecord } from "../src/utils/json.ts";
import { afterEach, beforeEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, removeDir, resetExitCode } from "./helpers.ts";

// Branded fixture names: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");
const FAST = parseProfileName("fast");
const GH_ALT = parseProfileName("gh-alt");
const ALT = parseProfileName("alt");
const TYPO = parseProfileName("typo");

const restoreEnv = envSnapshot();
let dir = "";

// A direct-profile add probes the Copilot integration identity over the network; stub it
// so every test resolves to the default identity (200 = first candidate accepted) offline.
beforeEach(() => {
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
});

afterEach(() => {
  setIntegrationProbeFetch(null);
  restoreEnv();
  // A check test's exit 1/2 must never leak into the whole `deno test` run.
  resetExitCode();
  dir = removeDir(dir);
});

/** Isolated proxy home (credential store, run state, profile homes). */
function tmpProxyHome(): string {
  const homes = isolateAgentHomes("copilot-profiles-");
  dir = homes.dir;
  return homes.proxyHome;
}

// isolateAgentHomes already exported CLAUDE_CONFIG_DIR / CODEX_HOME at these paths;
// the getters keep the call sites reading as "this test uses that home".
function tmpClaudeHome(): string {
  return join(dir, ".claude");
}

function tmpCodexHome(): string {
  return join(dir, ".codex");
}

// --- profile names ------------------------------------------------------------

test("parseProfileName accepts kebab names and rejects reserved/invalid ones", () => {
  parseProfileName("work");
  parseProfileName("gh-alt2");
  for (const bad of ["default", "direct", "proxy", "all"]) {
    expect(() => parseProfileName(bad)).toThrow(/reserved/);
  }
  for (const bad of ["", "-x", "Work", "a b", "x".repeat(33)]) {
    expect(() => parseProfileName(bad)).toThrow(/invalid profile name/);
  }
  // Windows reserved device names can't be directories there; cross-platform means
  // they're invalid everywhere.
  for (const bad of ["con", "nul", "prn", "aux", "com1", "lpt9"]) {
    expect(() => parseProfileName(bad)).toThrow(/reserved device name/);
  }
});

// --- credential store slots -----------------------------------------------------

test("a named credential write requires the profile to exist (no half-profile auto-create)", () => {
  tmpProxyHome();
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_default");
  const work = new Credential(state, WORK);

  // Hard-fail: no slot of its own -> null, even though the default resolves.
  expect(work.resolve()).toBeNull();
  expect(work.isAuthenticated()).toBe(false);

  // The old behavior auto-created a credential-only half profile here; profiles
  // are created ONLY by the atomic commit, so the write is a rejection.
  expect(() => work.store("gh-token", "ghp_work")).toThrow(/no such profile 'work'/);
  expect(state.profileNames()).toEqual([]);
  expect(new Credential(state).resolve()).toBe("ghp_default"); // default untouched
});

test("a home-only half profile gets the half-created repair message on re-auth", () => {
  tmpProxyHome();
  mkdirSync(profileHome(WORK), { recursive: true });
  // The home makes the profile KNOWN (env/models/health address it), but the
  // credential write still needs a store slot: only `--add` creates one.
  expect(() => new Credential(undefined, WORK).store("gh-token", "ghp_x")).toThrow(
    /half-created.*agent profile --add work/,
  );
  expect(new CopilotEnvState().profileNames()).toEqual([]);
});

test("named credential slots are isolated and never fall back to the default", () => {
  tmpProxyHome();
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_default");
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });
  const work = new Credential(state, WORK);
  expect(work.resolve()).toBe("ghp_work");
  expect(new Credential(state).resolve()).toBe("ghp_default");

  // Re-auth targets the existing slot only; the default stays untouched.
  work.store("gh-token", "ghp_rotated");
  expect(work.resolve()).toBe("ghp_rotated");
  expect(new Credential(state).resolve()).toBe("ghp_default");

  // De-auth clears the credential half (mode stays: de-auth is not deletion),
  // and the emptied credential never falls back to the default.
  expect(work.clear()).toBe(true);
  expect(work.resolve()).toBeNull();
  expect(state.readProfileSlot(WORK).mode).toBe("direct");
  expect(new Credential(state).resolve()).toBe("ghp_default");
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

  // Creating then deleting a profile drops the `profiles` key again.
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
  state.deleteProfile(WORK);
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
  const work = new CopilotApiPaths(WORK);
  expect(work.home).toBe(join(root, "profiles", "work"));
  expect(work.home).toBe(profileHome(WORK));
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
  const peek = Number(copilotApiResolvePort(WORK));
  expect(peek).not.toBe(defaultPort);
  expect(CopilotEnvRunState.forProfile(WORK).read().port).toBeUndefined();
  expect(profileHomeNames()).toEqual([]);

  const work = reserveProfilePort(WORK);
  const alt = reserveProfilePort(GH_ALT);
  expect(work).toBe(peek);
  expect(alt).not.toBe(defaultPort);
  expect(alt).not.toBe(work);
  // Stable: re-reserving and resolving both return the recorded reservation.
  expect(reserveProfilePort(WORK)).toBe(work);
  expect(Number(copilotApiResolvePort(WORK))).toBe(work);
  expect(CopilotEnvRunState.forProfile(WORK).read().port).toBe(work);
  expect(profileHomeNames()).toEqual([GH_ALT, WORK]);
});

test("copilotApiFallbackPort ignores the addressed profile's own record (snapshot rule)", () => {
  tmpProxyHome();
  const defaultPort = Number(copilotApiResolvePort());
  // The default target's fallback is the configured/built-in default -- no scan.
  expect(copilotApiFallbackPort(null)).toBe(defaultPort);

  // WORK records the first candidate (default+1). A caller that snapshotted
  // WORK's state BEFORE that write must get a fallback the write cannot steer:
  // WORK's own record is excluded, so its fallback is still default+1 -- while
  // another profile's scan does avoid it and lands on default+2.
  expect(reserveProfilePort(WORK)).toBe(defaultPort + 1);
  expect(copilotApiFallbackPort(WORK)).toBe(defaultPort + 1);
  expect(copilotApiFallbackPort(GH_ALT)).toBe(defaultPort + 2);
});

test("clearIfPid keeps a profile daemon's port reservation when asked", () => {
  tmpProxyHome();
  const state = CopilotEnvRunState.forProfile(WORK);
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
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });

  // Pre-existing default settings must stay byte-identical.
  configureClaudeConfig(home, "direct", { quiet: true });
  const defaultBefore = readFileSync(settingsPathFor(home), "utf8");

  configureClaudeConfig(home, "direct", { quiet: true, profile: WORK });

  expect(readFileSync(settingsPathFor(home), "utf8")).toBe(defaultBefore);
  const doc = JSON.parse(readFileSync(settingsPathFor(home, WORK), "utf8")) as Record<
    string,
    unknown
  >;
  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain("auth");
  expect(helperCommand).toContain("--profile");
  expect(helperCommand).toContain("work");
  expect(helperCommand).not.toContain("ghp_work"); // never baked

  const status = inspectClaudeWiring(
    JSON.stringify(doc),
    home,
    Number(copilotApiResolvePort(WORK)),
    WORK,
  );
  expect(status.providerMode).toBe("direct");
  // The default inspector must NOT recognize the profile file as managed.
  expect(inspectClaudeWiring(JSON.stringify(doc), home, 0).providerMode).toBe("other");
});

test("a direct Claude profile without its own credential is refused", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  new Credential().store("gh-token", "ghp_default"); // default cred must NOT satisfy it
  expect(() => configureClaudeConfig(home, "direct", { quiet: true, profile: WORK })).toThrow(
    /no credential of its own/,
  );
  expect(existsSync(settingsPathFor(home, WORK))).toBe(false);
});

test("a proxy Claude profile bakes ITS reserved port and blanks the direct-only env keys", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  configureClaudeConfig(home, "proxy", { quiet: true, profile: FAST });
  const doc = JSON.parse(readFileSync(settingsPathFor(home, FAST), "utf8")) as Record<
    string,
    unknown
  >;
  const env = isRecord(doc.env) ? doc.env : {};
  expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${copilotApiResolvePort(FAST)}`);
  // Blanked (not deleted): the overlay layers over a possibly-direct default.
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("");
  expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("");
  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain("proxy-token");
  expect(helperCommand).toContain("--profile");
  expect(helperCommand).toContain("fast");
});

test("a foreign settings-<name>.json is never taken over", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  configureClaudeConfig(home, "proxy", { quiet: true }); // creates the home
  writeFileSync(
    settingsPathFor(home, WORK),
    JSON.stringify({ apiKeyHelper: "/somewhere/else.sh" }),
  );
  expect(() => configureClaudeConfig(home, "proxy", { quiet: true, profile: WORK })).toThrow(
    /refusing to overwrite/,
  );
  // A custom base URL ALONE (no apiKeyHelper) is also foreign wiring.
  writeFileSync(
    settingsPathFor(home, ALT),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://my-gateway.example" } }),
  );
  expect(() => configureClaudeConfig(home, "proxy", { quiet: true, profile: ALT })).toThrow(
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
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });

  configureCodexConfig(codexHome, { mode: "direct", quiet: true });
  const before = readToml(join(codexHome, "config.toml"));
  expect(before.model_provider).toBe("copilot-env");

  configureCodexConfig(codexHome, { mode: "direct", quiet: true, profile: WORK });
  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBe("copilot-env"); // untouched
  const profiles = doc.profiles as Record<string, Record<string, unknown>>;
  expect(profiles.work?.model_provider).toBe(codexProviderId(WORK));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  const table = providers[codexProviderId(WORK)];
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
  configureCodexConfig(codexHome, {
    mode: "proxy",
    quiet: true,
    profile: FAST,
    baseUrl: `http://127.0.0.1:${copilotApiResolvePort(FAST)}/v1`,
  });
  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBeUndefined();
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId(FAST)]).toBeDefined();
  // Proxy profiles force the global sandbox loopback exemption (auth.command needs it).
  const sandbox = doc.sandbox_workspace_write as Record<string, unknown>;
  expect(sandbox.network_access).toBe(true);
});

test("a Codex profile write on an EMPTY config file also leaves no dangling model_provider", () => {
  tmpProxyHome();
  const codexHome = tmpCodexHome();
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "   \n");
  configureCodexConfig(codexHome, { mode: "direct", quiet: true, profile: FAST });
  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBeUndefined();
});

test("profile --sync refreshes wiring from the STORE mode and never touches model_provider", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  new CopilotEnvState().commitProfile(FAST, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_fast" },
    mode: "proxy",
  });
  const port = copilotApiResolvePort(FAST);
  // Seed a deliberately stale codex table; leave the top-level provider unset
  // (the --mobile pairing state) to prove sync never touches it.
  configureCodexConfig(codexHome, {
    mode: "proxy",
    quiet: true,
    profile: FAST,
    baseUrl: "http://127.0.0.1:1/v1",
  });
  expect(readToml(join(codexHome, "config.toml")).model_provider).toBeUndefined();

  await runProfile({ sync: true, mode: "auto" });

  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBeUndefined(); // still untouched
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId(FAST)]?.base_url).toBe(`http://127.0.0.1:${port}/v1`);
  // The Claude side was (re)written too -- one sync covers both agents.
  expect(existsSync(settingsPathFor(claudeHome, FAST))).toBe(true);
});

test("profile --check is store-driven: exit 1 unknown/incomplete, 2 proxy, 0 direct", async () => {
  const proxyHome = tmpProxyHome();
  await runProfile({ check: "ghost", mode: "auto" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  // Mode without credential is INCOMPLETE under the atomic model: never
  // launchable. The atomic commit cannot create this state, so seed it the way
  // it really arises -- a pre-atomic install's interrupted add / a hand edit.
  mkdirSync(proxyHome, { recursive: true });
  writeFileSync(
    new CopilotApiPaths().sharedStateFile,
    `${JSON.stringify({ profiles: { fast: { mode: "proxy" } } })}\n`,
  );
  await runProfile({ check: "fast", mode: "auto" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  const state = new CopilotEnvState();
  // Re-auth of the (now existing) partial slot completes it.
  new Credential(state, FAST).store("gh-token", "ghp_fast");
  await runProfile({ check: "fast", mode: "auto" });
  expect(process.exitCode).toBe(2);
  process.exitCode = 0;
  state.commitProfile(FAST, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_fast" },
    mode: "direct",
  });
  await runProfile({ check: "fast", mode: "auto" });
  expect(process.exitCode).toBe(0);
});

test("renderProfileTable aligns columns under a header and flags incomplete slots", () => {
  // Rows carry branded names (every real row is built from branded sources).
  const table = renderProfileTable([
    { name: FAST, provider: "gh-cli", mode: "proxy", daemon: { up: true, port: 4142 } },
    { name: parseProfileName("idle"), provider: "gh-cli", mode: "proxy", daemon: { up: false } },
    { name: WORK, provider: "gh-token", mode: "direct", daemon: null },
    { name: parseProfileName("broken"), provider: null, mode: null, daemon: null },
  ]);
  // Strip ANSI styling (the local run may have color enabled) so the
  // plain-text assertions hold everywhere. The escape byte is built with
  // fromCharCode: a literal control character in a regex is a lint error.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
  const lines = table.split("\n").map((l) => l.replace(ansi, ""));
  expect(lines[0]).toBe("     NAME      MODE          PROVIDER         DAEMON");
  expect(lines[1]).toBe("     fast      proxy         gh-cli           up (port 4142)");
  expect(lines[2]).toBe("     idle      proxy         gh-cli           down");
  // A direct profile has no daemon: "-", never a blank that reads as missing data.
  expect(lines[3]).toBe("     work      direct        gh-token         -");
  // Missing mode/credential surface as repairable gaps, not blanks.
  expect(lines[4]).toBe("     broken    incomplete    no credential    -");
});

test("profile --add wires both agents atomically; --del removes everything", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  await runProfile({ add: "work", mode: "proxy", set: "ghp_worktoken" });

  const state = new CopilotEnvState();
  expect(state.readProfileSlot(WORK)).toEqual({
    kind: "complete",
    credential: { kind: "stored", provider: "gh-token", token: "ghp_worktoken" },
    mode: "proxy",
    integrationIdentity: null,
  });
  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(true);
  const doc = readToml(join(codexHome, "config.toml"));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId(WORK)]).toBeDefined();
  expect((doc.profiles as Record<string, Record<string, unknown>>).work?.model_provider).toBe(
    codexProviderId(WORK),
  );

  // Mode switch: re-add with the other flag flips BOTH agents (one mode, never both).
  await runProfile({ add: "work", mode: "direct" });
  expect(state.readProfileSlot(WORK).mode).toBe("direct");
  const flipped = readToml(join(codexHome, "config.toml"));
  const flippedTable = (flipped.model_providers as Record<string, Record<string, unknown>>)[
    codexProviderId(WORK)
  ];
  expect(flippedTable?.base_url).toBe("https://api.githubcopilot.com");

  await runProfile({ del: "work", mode: "auto" });
  expect(state.readProfileSlot(WORK)).toEqual({
    kind: "partial",
    credential: { kind: "none", provider: null },
    mode: null,
    integrationIdentity: null,
  });
  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(false);
  const after = readToml(join(codexHome, "config.toml"));
  expect(
    (after.model_providers as Record<string, unknown> | undefined)?.[codexProviderId(WORK)],
  ).toBeUndefined();
  expect(after.profiles).toBeUndefined();
  expect(existsSync(profileHome(WORK))).toBe(false);
});

test("a wiring failure after the atomic commit leaves a complete slot that --sync heals", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  // A foreign settings-work.json makes the Claude profile writer refuse, so the
  // add fails AFTER the slot committed (credential + mode landed together).
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(
    settingsPathFor(claudeHome, WORK),
    JSON.stringify({ apiKeyHelper: "/somewhere/else.sh" }),
  );

  await expect(runProfile({ add: "work", mode: "proxy", set: "ghp_worktoken" })).rejects.toThrow(
    /could not wire/,
  );

  // Never a half profile: the slot is COMPLETE (both halves), only unwired.
  const state = new CopilotEnvState();
  expect(state.readProfileSlot(WORK)).toEqual({
    kind: "complete",
    credential: { kind: "stored", provider: "gh-token", token: "ghp_worktoken" },
    mode: "proxy",
    integrationIdentity: null,
  });

  // Clearing the blocker and re-syncing re-derives the artifacts from the slot.
  rmSync(settingsPathFor(claudeHome, WORK));
  await runProfile({ sync: true, mode: "auto" });
  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(true);
  const doc = readToml(join(codexHome, "config.toml"));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId(WORK)]).toBeDefined();
});

test("profile --add requires a mode for a new profile", async () => {
  tmpProxyHome();
  tmpClaudeHome();
  tmpCodexHome();
  expect(runProfile({ add: "work", mode: "auto", set: "ghp_x" })).rejects.toThrow(
    /--direct or --proxy/,
  );
  // The contradictory --direct --proxy pair never reaches runProfile anymore: the
  // CLI boundary parse rejects it (see provider_mode.test.ts / cli.smoke.test.ts).
  // Same conflict contract as `agent auth`: --set is the gh-token path; a different
  // explicit provider must error, never be silently coerced to gh-token.
  expect(
    runProfile({ add: "work", mode: "proxy", provider: "copilot", set: "ghp_x" }),
  ).rejects.toThrow(/--set only applies/);
});

test("parseProfileAction: one verb per invocation, add-only knobs live on the add arm", () => {
  // Each verb maps to its own arm; --add carries the mode and the parsed acquisition.
  expect(parseProfileAction({ add: "work", mode: "proxy" })).toEqual({
    kind: "add",
    name: WORK,
    mode: "proxy",
    acquisition: { kind: "choose" },
  });
  expect(parseProfileAction({ del: "work", mode: "auto" })).toEqual({ kind: "del", name: WORK });
  expect(parseProfileAction({ check: "work", mode: "auto" })).toEqual({
    kind: "check",
    name: WORK,
  });
  expect(parseProfileAction({ settingsFor: "work", mode: "auto" })).toEqual({
    kind: "settings-for",
    name: WORK,
  });
  expect(parseProfileAction({ sync: true, mode: "auto" })).toEqual({ kind: "sync" });
  expect(parseProfileAction({ list: true, mode: "auto" })).toEqual({ kind: "list" });
  // Zero or two verbs, or an add-only knob on another verb: boundary rejections.
  expect(() => parseProfileAction({ mode: "auto" })).toThrow(/exactly one/);
  expect(() => parseProfileAction({ add: "work", list: true, mode: "auto" })).toThrow(
    /exactly one/,
  );
  expect(() => parseProfileAction({ del: "work", mode: "direct" })).toThrow(
    "--direct/--proxy only apply to --add",
  );
  expect(() => parseProfileAction({ list: true, mode: "auto", provider: "copilot" })).toThrow(
    "--provider/--set only apply to --add",
  );
});

test("parseStopAction: all/profile/default arms; --all --profile is a rejection", () => {
  expect(parseStopAction({})).toEqual({ kind: "default" });
  expect(parseStopAction({ all: true })).toEqual({ kind: "all" });
  expect(parseStopAction({ profile: "work" })).toEqual({ kind: "profile", name: WORK });
  expect(() => parseStopAction({ all: true, profile: "work" })).toThrow(
    "--all stops every daemon; it does not combine with --profile",
  );
});

test("stop/record-event against a never-existing profile fabricate NOTHING", async () => {
  tmpProxyHome();
  await runStop({ profile: "typo" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  await runStart({ kind: "record-event", profile: TYPO });
  // Neither command may materialize a phantom profile home (profile --list,
  // stop --all, and the proxy float all enumerate profile homes).
  expect(existsSync(profileHome(TYPO))).toBe(false);
  expect(profileHomeNames()).toEqual([]);
});

test("a direct profile probes the client identity ONCE, persisting the verdict for later syncs", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  tmpCodexHome();
  // Count only the identity probes (the /models candidate requests).
  let probes = 0;
  setIntegrationProbeFetch((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/models")) probes++;
    return Promise.resolve(
      url.includes("Copilot-Integration-Id") || url.includes("/copilot_internal/user")
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
  });

  await runProfile({ add: "work", mode: "direct", set: "ghp_worktoken" });
  const state = new CopilotEnvState();
  // The DEFAULT identity won, and that verdict is persisted (as the identity NAME) so it
  // is distinguishable from "never probed" -- the launcher hot path must not re-probe.
  expect(state.readProfileSlot(WORK).integrationIdentity).toBe("codex");
  const afterAdd = probes;
  expect(afterAdd).toBeGreaterThan(0);

  // `--settings-for` and `--sync` are the per-launch replay paths: no further network.
  await runProfile({ settingsFor: "work", mode: "auto" });
  await runProfile({ sync: true, mode: "auto" });
  expect(probes).toBe(afterAdd);
  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(true);

  // A credential change invalidates the cached verdict, re-arming the probe.
  new Credential(state, WORK).store("gh-token", "ghp_rotated");
  expect(state.readProfileSlot(WORK).integrationIdentity).toBeNull();
  await runProfile({ sync: true, mode: "auto" });
  expect(probes).toBeGreaterThan(afterAdd);
});

test("a direct profile bakes a non-default probed identity into BOTH agents", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  // Only copilot-developer-cli is accepted -- the PAT case this feature exists for.
  setIntegrationProbeFetch((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    const id = new Headers(init?.headers).get("Copilot-Integration-Id");
    return Promise.resolve(
      id === "copilot-developer-cli"
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("PATs not supported", { status: 400 }),
    );
  });

  await runProfile({ add: "work", mode: "direct", set: "github_pat_worktoken" });
  expect(new CopilotEnvState().readProfileSlot(WORK).integrationIdentity).toBe(
    "copilot-developer-cli",
  );
  // Claude: the header rides ANTHROPIC_CUSTOM_HEADERS in the profile's settings overlay.
  const settings = JSON.parse(readFileSync(settingsPathFor(claudeHome, WORK), "utf8"));
  expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toContain(
    "Copilot-Integration-Id: copilot-developer-cli",
  );
  // Codex: the same identity in the profile provider's http_headers.
  const doc = readToml(join(codexHome, "config.toml"));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  const headers = providers[codexProviderId(WORK)]?.http_headers as Record<string, string>;
  expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
});

test("profile add/del keeps the Claude Desktop entry in lockstep when Desktop is present", async () => {
  tmpProxyHome();
  // Opt this test into "Desktop installed": the seam dir exists.
  const dataDir = join(dir, "claude-desktop");
  mkdirSync(dataDir, { recursive: true });
  process.env[CLAUDE_DESKTOP_DIR_ENV] = dataDir;
  const library = desktopLibraryDirUnder(dataDir);

  await runProfile({ add: "work", mode: "proxy", set: "ghp_worktoken" });
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
    entries: { id: string; name: string }[];
  };
  const entry = meta.entries.find((e) => e.name === "copilot-env: work");
  expect(entry).toBeDefined();
  const doc = JSON.parse(readFileSync(join(library, `${entry?.id}.json`), "utf8")) as Record<
    string,
    unknown
  >;
  // Proxy wiring: loopback gateway + discovery on (the daemon serves /v1/models).
  expect(doc.inferenceGatewayBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(doc.modelDiscoveryEnabled).toBe(true);

  await runProfile({ del: "work", mode: "auto" });
  const after = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
    entries: unknown[];
  };
  expect(after.entries).toEqual([]);
  expect(existsSync(join(library, `${entry?.id}.json`))).toBe(false);
});
