// Named credential/wiring profiles: the opt-in additions beside the default
// (settings-<name>.json, [profiles.<name>], per-profile credential slots and
// daemon homes). The default path must stay byte-identical throughout.
import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { setIntegrationProbeFetch } from "../src/copilot_api/integration_identity.ts";
import { CopilotApiPaths, profileHome, profileHomeNames } from "../src/copilot_api/paths.ts";
import { copilotApiResolvePort, reserveProfilePort } from "../src/copilot_api/port.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { isRecord } from "../src/utils/json.ts";

const WIN = process.platform === "win32";

// Branded fixture names: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");
const FAST = parseProfileName("fast");
const GH_ALT = parseProfileName("gh-alt");
const ALT = parseProfileName("alt");
const TYPO = parseProfileName("typo");

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

// A direct-profile add probes the Copilot integration identity over the network; stub it
// so every test resolves to the default identity (200 = first candidate accepted) offline.
beforeEach(() => {
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
  );
});

afterEach(() => {
  setIntegrationProbeFetch(null);
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

test("named credential slots are isolated and never fall back to the default", () => {
  tmpProxyHome();
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_default");
  const work = new Credential(state, WORK);

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
  const work = new Credential(state, WORK);
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
  new Credential(state, WORK).store("gh-token", "ghp_work");

  // Pre-existing default settings must stay byte-identical.
  configureClaudeConfig(home, "direct", { quiet: true });
  const defaultBefore = readFileSync(settingsPathFor(home), "utf8");

  configureClaudeConfig(home, "direct", { quiet: true, profile: WORK });

  expect(readFileSync(settingsPathFor(home), "utf8")).toBe(defaultBefore);
  const doc = JSON.parse(readFileSync(settingsPathFor(home, WORK), "utf8")) as Record<
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
  const helper = readFileSync(String(doc.apiKeyHelper), "utf8");
  expect(helper).toContain("--profile");
  expect(helper).toContain("fast");
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
  new Credential(state, WORK).store("gh-token", "ghp_work");

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
  new Credential(undefined, FAST).store("gh-token", "ghp_fast");
  new CopilotEnvState().setProfileMode(FAST, "proxy");
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
  tmpProxyHome();
  await runProfile({ check: "ghost", mode: "auto" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  const state = new CopilotEnvState();
  // Mode without credential is INCOMPLETE under the atomic model: never launchable.
  state.setProfileMode(FAST, "proxy");
  await runProfile({ check: "fast", mode: "auto" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  new Credential(state, FAST).store("gh-token", "ghp_fast");
  await runProfile({ check: "fast", mode: "auto" });
  expect(process.exitCode).toBe(2);
  process.exitCode = 0;
  state.setProfileMode(FAST, "direct");
  await runProfile({ check: "fast", mode: "auto" });
  expect(process.exitCode).toBe(0);
});

test("renderProfileTable aligns columns under a header and flags incomplete slots", () => {
  const table = renderProfileTable([
    { name: "fast", provider: "gh-cli", mode: "proxy", daemon: { up: true, port: 4142 } },
    { name: "idle", provider: "gh-cli", mode: "proxy", daemon: { up: false } },
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
  expect(state.readProfileSlot(WORK).mode).toBe("proxy");
  expect(state.readProfileSlot(WORK).authProvider).toBe("gh-token");
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
    githubToken: null,
    authProvider: null,
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

test("stop/record-event against a never-existing profile fabricate NOTHING", async () => {
  tmpProxyHome();
  await runStop({ profile: "typo" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  await runStart({ kind: "record-event", profile: "typo" });
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
