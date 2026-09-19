// Every profile write must leave the default path byte-identical.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { configureClaudeConfig, inspectClaudeWiring } from "../src/claude/config.ts";
import { desktopHelperPath } from "../src/claude/desktop_helper_scripts.ts";
import { CLAUDE_DESKTOP_DIR_ENV, desktopLibraryDirUnder } from "../src/claude/desktop_library.ts";
import { settingsPathFor } from "../src/claude/paths.ts";
import { configureCodexConfig } from "../src/codex/config.ts";
import { codexProfileConfigPath, codexProviderId } from "../src/codex/paths.ts";
import {
  addProfile,
  checkProfile,
  deleteProfileEverywhere,
  delProfile,
  renderProfileTable,
  syncNamedProfiles,
} from "../src/commands/profile.ts";
import { runAuth } from "../src/commands/auth.ts";
import { commandDeps } from "../src/commands/launch.ts";
import { runStart } from "../src/commands/start.ts";
import { parseStopAction, runStop } from "../src/commands/stop.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState, partialSlotGap } from "../src/copilot_api/env_state.ts";
import { setGithubLoginFetch } from "../src/copilot_api/github_login.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  resetIntegrationIdentityCache,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import {
  CopilotApiPaths,
  profileHome,
  profileHomeNames,
  resolveRootHome,
} from "../src/copilot_api/paths.ts";
import {
  copilotApiFallbackPort,
  copilotApiResolvePort,
  reserveProfilePort,
} from "../src/copilot_api/port.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/run_state.ts";
import { isRecord } from "../src/utils/json.ts";
import { afterEach, beforeEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, resetExitCode } from "./helpers/env.ts";
import { stubGithubLogins } from "./helpers/fixtures.ts";
import { stageRefusedStop } from "./helpers/daemon.ts";
import { captureAllWrites } from "./helpers/output.ts";

// Branded fixture names: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");

/** What `cl --profile work` runs in-process before it launches: the launcher's own hook
 *  (src/commands/launch.ts), so these sites fail if the real hook changes. */
async function launcherHook(): Promise<void> {
  const slot = new CopilotEnvState().readProfileSlot(WORK);
  if (slot.kind !== "complete") throw new Error("launcherHook: the work slot is not complete");
  await commandDeps().writeClaudeProfileSettings(WORK, slot.mode);
}

/** A named profile lands in two commands: `add` records the mode, `auth` lands the credential and
 *  wires both agents. */
async function addWork(mode: "direct" | "proxy", token: string): Promise<void> {
  await addProfile(WORK, { mode, noAuth: true });
  await runAuth({ set: token, profile: "work" });
}
const FAST = parseProfileName("fast");
const GH_ALT = parseProfileName("gh-alt");
const ALT = parseProfileName("alt");
const TYPO = parseProfileName("typo");
const COMMAND = { kind: "command" } as const;

const restoreEnv = envSnapshot();
/** The process's real fetch: a case that stubs the global for model discovery is reset here. */
const REAL_FETCH = globalThis.fetch;
let dir = "";

// A direct-profile add probes the Copilot integration identity over the network; stub it
// so every test resolves to the default identity (200 = first candidate accepted) offline.
beforeEach(() => {
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
  stubGithubLogins({ ghp_worktoken: "work-bot" });
});

afterEach(() => {
  setIntegrationProbeFetch(null);
  setGithubLoginFetch(null);
  globalThis.fetch = REAL_FETCH;
  restoreEnv();
  // A check test's exit 1/2 must never leak into the whole `deno test` run.
  resetExitCode();
  dir = removeDir(dir);
});

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

  // Profiles are created ONLY by the atomic commit, so the write is a rejection, never a half profile.
  expect(() => work.store("gh-token", "ghp_work")).toThrow(/no such profile 'work'/);
  expect(state.profileNames()).toEqual([]);
  expect(new Credential(state).resolve()).toBe("ghp_default"); // default untouched
});

test("a home-only half profile gets the half-created repair message on re-auth", () => {
  tmpProxyHome();
  mkdirSync(profileHome(WORK), { recursive: true });
  // The home makes the profile KNOWN (env/models/health address it), but the
  // credential write still needs a store slot: only `add` creates one.
  expect(() => new Credential(undefined, WORK).store("gh-token", "ghp_x")).toThrow(
    /half-created.*agent profile work add/,
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

test("the default credential lives in the reserved default slot on disk", () => {
  tmpProxyHome();
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_default");
  const raw = JSON.parse(readFileSync(new CopilotApiPaths().stateStoreFile, "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  // No legacy top-level pair: the write landed in profiles.default whole.
  expect(Object.keys(raw)).toEqual(["profiles"]);
  expect(raw.profiles).toEqual({
    default: { "authProvider": "gh-token", "githubToken": "ghp_default" },
  });

  // Creating then deleting a named profile drops ITS key again; the reserved
  // default slot stays (it is the default credential's home, not a profile).
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
  state.deleteProfile(WORK);
  const raw2 = JSON.parse(readFileSync(new CopilotApiPaths().stateStoreFile, "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  expect(Object.keys(raw2.profiles ?? {})).toEqual(["default"]);
});

// --- profile homes + ports ------------------------------------------------------

test("profile paths isolate the daemon home but share the account-wide files, however the home is addressed", () => {
  const root = tmpProxyHome();
  const def = new CopilotApiPaths();
  // Addressed by name from the root, or from inside the profile daemon (COPILOT_API_HOME is its
  // own home; COPILOT_ENV_ROOT_HOME re-anchors the shared files).
  const routes: { name: string; paths: () => CopilotApiPaths }[] = [
    { name: "by profile", paths: () => new CopilotApiPaths(WORK) },
    {
      name: "inside the profile daemon",
      paths: () => {
        process.env.COPILOT_API_HOME = join(root, "profiles", "work");
        process.env.COPILOT_ENV_ROOT_HOME = root;
        return new CopilotApiPaths();
      },
    },
  ];
  for (const a of routes) {
    const work = a.paths();
    expect(work.home, a.name).toBe(join(root, "profiles", "work"));
    expect(work.home, a.name).toBe(profileHome(WORK));
    expect(work.configFile.startsWith(work.home), a.name).toBe(true);
    expect(work.sqliteDb.startsWith(work.home), a.name).toBe(true);
    expect(work.stateFile.startsWith(work.home), a.name).toBe(true);
    // Account-wide files anchor at the ROOT home for every profile.
    expect(work.stateStoreFile, a.name).toBe(join(root, "state.json"));
    expect(work.stateStoreFile, a.name).toBe(def.stateStoreFile);
    expect(work.codexModelCatalogFile, a.name).toBe(def.codexModelCatalogFile);
  }
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

  // A caller that snapshotted WORK's state before the reservation must get a fallback the write
  // cannot steer.
  //   WORK's own record  -> excluded, fallback stays default+1
  //   another profile    -> the scan avoids it, lands on default+2
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
  configureClaudeConfig(home, { credential: COMMAND, mode: "direct", direct: null });
  const defaultBefore = readFileSync(settingsPathFor(home), "utf8");

  configureClaudeConfig(home, { credential: COMMAND, mode: "direct", direct: null, profile: WORK });

  expect(readFileSync(settingsPathFor(home), "utf8")).toBe(defaultBefore);
  const doc = JSON.parse(readFileSync(settingsPathFor(home, WORK), "utf8")) as Record<
    string,
    unknown
  >;
  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain("profile work auth --get");
  expect(helperCommand).not.toContain("ghp_work"); // never baked

  const status = inspectClaudeWiring(
    JSON.stringify(doc),
    Number(copilotApiResolvePort(WORK)),
    WORK,
  );
  expect(status.providerMode).toBe("direct");
  // The default inspector must NOT recognize the profile file as managed.
  expect(inspectClaudeWiring(JSON.stringify(doc), 0).providerMode).toBe("other");
});

test("a direct Claude profile without its own credential is refused", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  new Credential().store("gh-token", "ghp_default"); // default cred must NOT satisfy it
  expect(() =>
    configureClaudeConfig(home, {
      credential: COMMAND,
      mode: "direct",
      direct: null,
      profile: WORK,
    })
  )
    .toThrow(
      /no credential of its own/,
    );
  expect(existsSync(settingsPathFor(home, WORK))).toBe(false);
});

test("a proxy Claude profile bakes ITS reserved port and blanks the direct-only env keys", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  configureClaudeConfig(home, { credential: COMMAND, mode: "proxy", profile: FAST });
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
  expect(helperCommand).toContain("profile fast proxy-token --yes");
});

test("a foreign settings-<name>.json is never taken over", () => {
  tmpProxyHome();
  const home = tmpClaudeHome();
  configureClaudeConfig(home, { credential: COMMAND, mode: "proxy" }); // creates the home
  writeFileSync(
    settingsPathFor(home, WORK),
    JSON.stringify({ apiKeyHelper: "/somewhere/else.sh" }),
  );
  expect(() => configureClaudeConfig(home, { credential: COMMAND, mode: "proxy", profile: WORK }))
    .toThrow(
      /refusing to overwrite/,
    );
  // A custom base URL ALONE (no apiKeyHelper) is also foreign wiring.
  writeFileSync(
    settingsPathFor(home, ALT),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://my-gateway.example" } }),
  );
  expect(() => configureClaudeConfig(home, { credential: COMMAND, mode: "proxy", profile: ALT }))
    .toThrow(
      /refusing to overwrite/,
    );
});

// --- Codex profile artifacts ------------------------------------------------------

function readToml(path: string): Record<string, unknown> {
  return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("a Codex profile writes <name>.config.toml + its provider table, leaving the default selection untouched", () => {
  tmpProxyHome();
  const codexHome = tmpCodexHome();
  const state = new CopilotEnvState();
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });

  configureCodexConfig(codexHome, { credential: COMMAND, mode: "direct", direct: null });
  const before = readToml(join(codexHome, "config.toml"));
  expect(before.model_provider).toBe("copilot-env");

  configureCodexConfig(codexHome, {
    credential: COMMAND,
    mode: "direct",
    direct: null,
    profile: WORK,
  });
  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBe("copilot-env"); // untouched
  expect(doc.profiles).toBeUndefined();
  expect(readToml(codexProfileConfigPath(codexHome, WORK))).toEqual({
    model_provider: codexProviderId(WORK),
  });
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  const table = providers[codexProviderId(WORK)];
  expect(table).toBeDefined();
  const auth = table?.auth as Record<string, unknown>;
  expect(JSON.stringify(auth.args)).toContain('"profile","work","auth","--get"');
  // The default table is still the unsuffixed contract.
  expect(providers["copilot-env"]).toBeDefined();
});

test("a Codex profile write on a FRESH or whitespace-only config lands whole and leaves no dangling default model_provider", () => {
  const cases: {
    name: string;
    seed: string | null;
    write: Parameters<typeof configureCodexConfig>[1];
  }[] = [
    {
      name: "absent config.toml, proxy",
      seed: null,
      write: { credential: COMMAND, mode: "proxy", profile: FAST, baseUrl: "" },
    },
    {
      name: "whitespace-only config.toml, direct",
      seed: "   \n",
      write: { credential: COMMAND, mode: "direct", direct: null, profile: FAST },
    },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    tmpProxyHome();
    const codexHome = tmpCodexHome();
    if (c.seed !== null) {
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), c.seed);
    }
    const write = c.write.mode === "proxy"
      ? { ...c.write, baseUrl: `http://127.0.0.1:${copilotApiResolvePort(FAST)}/v1` }
      : c.write;
    configureCodexConfig(codexHome, write);
    const doc = readToml(join(codexHome, "config.toml"));
    expect(doc.model_provider, c.name).toBeUndefined();
    // The write LANDED: the profile wiring arrives whole -- selection plus its provider table.
    expect(readToml(codexProfileConfigPath(codexHome, FAST)).model_provider, c.name).toBe(
      codexProviderId(FAST),
    );
    const providers = doc.model_providers as Record<string, Record<string, unknown>>;
    expect(providers[codexProviderId(FAST)], c.name).toBeDefined();
    // Proxy profiles force the global sandbox loopback exemption (auth.command needs it).
    if (c.write.mode === "proxy") {
      const sandbox = doc.sandbox_workspace_write as Record<string, unknown>;
      expect(sandbox.network_access, c.name).toBe(true);
    }
  }
});

test("agent sync refreshes wiring from the STORE mode and never touches model_provider", async () => {
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
    credential: COMMAND,
    mode: "proxy",
    profile: FAST,
    baseUrl: "http://127.0.0.1:1/v1",
  });
  expect(readToml(join(codexHome, "config.toml")).model_provider).toBeUndefined();

  await syncNamedProfiles();

  const doc = readToml(join(codexHome, "config.toml"));
  expect(doc.model_provider).toBeUndefined(); // still untouched
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId(FAST)]?.base_url).toBe(`http://127.0.0.1:${port}/v1`);
  // The Claude side was (re)written too -- one sync covers both agents.
  expect(existsSync(settingsPathFor(claudeHome, FAST))).toBe(true);
});

test("profile <name> check is store-driven: exit 1 unknown/incomplete, 2 proxy, 0 direct", async () => {
  const proxyHome = tmpProxyHome();
  await checkProfile(parseProfileName("ghost"), null);
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  // Mode without credential is INCOMPLETE under the atomic model: never
  // launchable. The atomic commit cannot create this state, so seed it the way
  // it really arises -- a pre-atomic install's interrupted add / a hand edit.
  mkdirSync(proxyHome, { recursive: true });
  writeFileSync(
    new CopilotApiPaths().stateStoreFile,
    `${JSON.stringify({ profiles: { fast: { mode: "proxy" } } })}\n`,
  );
  await checkProfile(FAST, null);
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  const state = new CopilotEnvState();
  // Re-auth of the (now existing) partial slot completes it.
  new Credential(state, FAST).store("gh-token", "ghp_fast");
  await checkProfile(FAST, null);
  expect(process.exitCode).toBe(2);
  process.exitCode = 0;
  state.commitProfile(FAST, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_fast" },
    mode: "direct",
  });
  await checkProfile(FAST, null);
  expect(process.exitCode).toBe(0);
});

test("partialSlotGap: the ONE spelling of a partial slot's repair line (output contract)", () => {
  // Rendered at three sites (`profile <name> check`, the `cl --profile` launcher, `agent profile launch`); pinned once here,
  // byte for byte (launch.test.ts matches both lines end to end, but only as substrings).
  expect(
    partialSlotGap(WORK, {
      kind: "partial",
      credential: { kind: "none", provider: null },
      mode: null,
    }),
  ).toBe(
    "profile 'work' does not exist - create it with `agent profile work add --direct|--proxy`",
  );
  expect(
    partialSlotGap(WORK, {
      kind: "partial",
      credential: { kind: "none", provider: null },
      mode: "proxy",
    }),
  ).toBe(
    "profile 'work' has no credential - repair it with `agent profile work auth` " +
      "or `agent profile work add`",
  );
});

test("renderProfileTable aligns columns under a header and flags incomplete slots", () => {
  // Rows carry branded names (every real row is built from branded sources).
  const table = renderProfileTable([
    { name: FAST, provider: "gh-cli", mode: "proxy", daemon: { up: true, port: 4142 } },
    { name: parseProfileName("idle"), provider: "gh-cli", mode: "proxy", daemon: { up: false } },
    { name: WORK, provider: "gh-token", mode: "direct", daemon: null },
    { name: parseProfileName("broken"), provider: null, mode: null, daemon: null },
  ], null);
  // Strip ANSI styling (the local run may have color enabled) so the
  // plain-text assertions hold everywhere. The escape byte is built with
  // fromCharCode: a literal control character in a regex is a lint error.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
  const lines = table.split("\n").map((l) => l.replace(ansi, ""));
  expect(lines).toEqual([
    "     NAME    MODE        PROVIDER       DAEMON",
    "     ------  ----------  -------------  --------------",
    "     fast    proxy       gh-cli         up (port 4142)",
    "     idle    proxy       gh-cli         down",
    // A direct profile has no daemon: "-", never a blank that reads as missing data.
    "     work    direct      gh-token       -",
    // Missing mode/credential surface as repairable gaps, not blanks.
    "     broken  incomplete  no credential  -",
  ]);
});

test("profile <name> add then auth wires both agents; del removes everything", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  await addWork("proxy", "ghp_worktoken");

  const state = new CopilotEnvState();
  expect(state.readProfileSlot(WORK)).toEqual({
    kind: "complete",
    credential: { kind: "stored", provider: "gh-token", token: "ghp_worktoken" },
    mode: "proxy",
  });
  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(true);
  const doc = readToml(join(codexHome, "config.toml"));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId(WORK)]).toBeDefined();
  expect(readToml(codexProfileConfigPath(codexHome, WORK)).model_provider).toBe(
    codexProviderId(WORK),
  );

  // A profile-scoped setting lives in the profile's section of the preference store.
  new CopilotEnvConfig().setProfile(WORK, { identity: "copilot-developer-cli" });
  expect(new CopilotEnvConfig().pinnedIntegrationId(WORK)).toBe("copilot-developer-cli");

  // Mode switch: re-add with the other flag flips BOTH agents (one mode, never both).
  await addProfile(WORK, { mode: "direct", noAuth: true });
  expect(state.readProfileSlot(WORK).mode).toBe("direct");
  const flipped = readToml(join(codexHome, "config.toml"));
  const flippedTable = (flipped.model_providers as Record<string, Record<string, unknown>>)[
    codexProviderId(WORK)
  ];
  expect(flippedTable?.base_url).toBe("https://api.githubcopilot.com");

  await delProfile(WORK, false);
  expect(state.readProfileSlot(WORK)).toEqual({
    kind: "partial",
    credential: { kind: "none", provider: null },
    mode: null,
  });
  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(false);
  const after = readToml(join(codexHome, "config.toml"));
  expect(
    (after.model_providers as Record<string, unknown> | undefined)?.[codexProviderId(WORK)],
  ).toBeUndefined();
  expect(existsSync(codexProfileConfigPath(codexHome, WORK))).toBe(false);
  expect(existsSync(profileHome(WORK))).toBe(false);
  // ... and the settings section, so a later profile of the same name inherits nothing.
  expect(new CopilotEnvConfig().read().profiles).not.toHaveProperty("work");
  // A profile that exists ONLY as a settings section (a settings-only import) is still deletable.
  new CopilotEnvConfig().setProfile(WORK, { host: "https://copilot-api.ghe.example" });
  await delProfile(WORK, false);
  expect(new CopilotEnvConfig().read().profiles).not.toHaveProperty("work");
});

test("a wiring failure after the atomic commit leaves a complete slot that agent sync heals", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  // A foreign settings-work.json makes the Claude profile writer refuse, so the credential
  // landing fails AFTER the slot committed (the mode from `add`, the credential from `auth`).
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(
    settingsPathFor(claudeHome, WORK),
    JSON.stringify({ apiKeyHelper: "/somewhere/else.sh" }),
  );

  await addProfile(WORK, { mode: "proxy", noAuth: true });
  await expect(runAuth({ set: "ghp_worktoken", profile: "work" })).rejects.toThrow(
    /could not wire/,
  );

  // Never a half profile: the slot is COMPLETE (both halves), only unwired.
  const state = new CopilotEnvState();
  expect(state.readProfileSlot(WORK)).toEqual({
    kind: "complete",
    credential: { kind: "stored", provider: "gh-token", token: "ghp_worktoken" },
    mode: "proxy",
  });

  rmSync(settingsPathFor(claudeHome, WORK));
  await syncNamedProfiles();
  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(true);
  const doc = readToml(join(codexHome, "config.toml"));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  expect(providers[codexProviderId(WORK)]).toBeDefined();
});

test("profile <name> add requires a mode for a new profile", async () => {
  tmpProxyHome();
  tmpClaudeHome();
  tmpCodexHome();
  await expect(addProfile(WORK, { mode: "auto", noAuth: true })).rejects.toThrow(
    /--direct or --proxy/,
  );
  // --direct --proxy is rejected at the CLI boundary (provider_mode.test.ts), never here.
});

test("parseStopAction: all/profile/default arms; --all on a named profile is a rejection", () => {
  expect(parseStopAction({})).toEqual({ kind: "default" });
  expect(parseStopAction({ all: true })).toEqual({ kind: "all" });
  expect(parseStopAction({ profile: "work" })).toEqual({ kind: "profile", name: WORK });
  expect(() => parseStopAction({ all: true, profile: "work" })).toThrow(
    "--all stops every daemon; it takes no profile name",
  );
});

// --- the refused stop's consumers (guard + summary line) ---------------------------------

test(
  "profile delete: a REFUSED stop aborts the deletion; home, slot, and tracking survive",
  async () => {
    tmpProxyHome();
    new CopilotEnvState().commitProfile(WORK, {
      credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
      mode: "proxy",
    });
    const fx = stageRefusedStop(profileHome(WORK), WORK);
    try {
      // The uncorroborated lock holder cannot be stopped, so nothing may be deleted
      // under it: the daemon -- wherever it runs -- is still writing into this home.
      await expect(deleteProfileEverywhere(WORK)).rejects.toThrow("did not stop");
      expect(existsSync(profileHome(WORK))).toBe(true);
      expect(new Credential(undefined, WORK).resolve()).toBe("ghp_work");
      expect(CopilotEnvRunState.forProfile(WORK).read().pid).toBe(fx.bystanderPid);
    } finally {
      await fx.teardown();
    }
  },
  30_000,
);

test(
  "stop: a REFUSED stop reports the daemon left running -- never 'cleared stale tracking'",
  async () => {
    tmpProxyHome();
    const fx = stageRefusedStop(new CopilotApiPaths().home);
    try {
      const out = await captureAllWrites(() => runStop({}));
      // stopTrackedProxy's warning explains the refusal; the summary line must agree
      // that nothing changed instead of claiming cleared tracking over a kept one.
      expect(out).toContain("was left running; tracking kept");
      expect(out).not.toContain("cleared stale tracking");
      expect(process.exitCode).toBe(1); // nothing was stopped
      resetExitCode();
      expect(new CopilotEnvRunState().read().pid).toBe(fx.bystanderPid);
    } finally {
      await fx.teardown();
    }
  },
  30_000,
);

test("stop/record-event against a never-existing profile fabricate NOTHING", async () => {
  tmpProxyHome();
  await runStop({ profile: "typo" });
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  // The heartbeat is the resolver's, wired for a profile that exists: an unknown name is the
  // refusal every named verb gives, never a heartbeat landed somewhere.
  await expect(runStart({ kind: "record-event", profile: TYPO })).rejects.toThrow(
    "no such profile 'typo'",
  );
  // Neither command may materialize a phantom profile home (agent list,
  // stop --all, and the proxy float all enumerate profile homes).
  expect(existsSync(profileHome(TYPO))).toBe(false);
  expect(profileHomeNames()).toEqual([]);
});

test("a direct profile probes ONCE and bakes the accepted identity into BOTH agents; a rewire re-renders the baked pair with no probe", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  // Only copilot-developer-cli is accepted -- the PAT case this feature exists for.
  let probes = 0;
  setIntegrationProbeFetch((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    probes++;
    const id = new Headers(init?.headers).get("Copilot-Integration-Id");
    return Promise.resolve(
      id === "copilot-developer-cli"
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("PATs not supported", { status: 400 }),
    );
  });
  const baked = (): {
    claude: string;
    claudeHost: string;
    codex: string | undefined;
    codexHost: unknown;
  } => {
    const settings = JSON.parse(readFileSync(settingsPathFor(claudeHome, WORK), "utf8"));
    const doc = readToml(join(codexHome, "config.toml"));
    const providers = doc.model_providers as Record<string, Record<string, unknown>>;
    const table = providers[codexProviderId(WORK)];
    const headers = table?.http_headers as Record<string, string>;
    return {
      claude: settings.env.ANTHROPIC_CUSTOM_HEADERS,
      claudeHost: settings.env.ANTHROPIC_BASE_URL,
      codex: headers["Copilot-Integration-Id"],
      codexHost: table?.base_url,
    };
  };

  await addWork("direct", "github_pat_worktoken");
  const first = baked();
  expect(first.claude).toContain("Copilot-Integration-Id: copilot-developer-cli");
  expect(first.codex).toBe("copilot-developer-cli");
  expect(probes).toBeGreaterThan(0);

  // the `cl --profile` launcher and `agent sync` re-render what the files already bake: no request, same bytes.
  // The stub now rejects everything, so a probe would both count and change the verdict.
  probes = 0;
  setIntegrationProbeFetch(() => {
    probes++;
    return Promise.resolve(new Response("PATs not supported", { status: 400 }));
  });
  await launcherHook();
  await syncNamedProfiles();
  expect(probes).toBe(0);
  expect(baked()).toEqual(first);

  // A re-add is a probing wiring (the credential may have changed): the files are overwritten
  // with the fresh selection, here the one identity the stub now accepts.
  setIntegrationProbeFetch((_input, init) => {
    probes++;
    const id = new Headers(init?.headers).get("Copilot-Integration-Id");
    return Promise.resolve(
      id === "copilot-developer-sandbox"
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("PATs not supported", { status: 400 }),
    );
  });
  await addProfile(WORK, { mode: "direct", noAuth: true });
  expect(probes).toBeGreaterThan(0);
  expect(baked().codex).toBe("copilot-developer-sandbox");
  expect(baked().claude).toContain("Copilot-Integration-Id: copilot-developer-sandbox");

  // A `copilot-host` literal overlays the stored host at the next re-render: no request, and both
  // files move to the literal while the slot keeps the probed host.
  probes = 0;
  const ghe = "https://copilot-api.ghe.example";
  new CopilotEnvConfig().setProfile(WORK, { host: ghe });
  resetIntegrationIdentityCache();
  await syncNamedProfiles();
  expect(probes).toBe(0);
  expect(baked().claudeHost).toBe(ghe);
  expect(baked().codexHost).toBe(ghe);
  expect(new CopilotEnvState().readProfileDirectPair(WORK)).toEqual({
    integrationId: "copilot-developer-sandbox",
    host: DEFAULT_COPILOT_API_BASE,
  });
  // Cleared, the slot's own host returns at the next re-render, again with no request.
  new CopilotEnvConfig().delProfile(WORK, "host");
  resetIntegrationIdentityCache();
  await syncNamedProfiles();
  expect(probes).toBe(0);
  expect(baked().claudeHost).toBe(DEFAULT_COPILOT_API_BASE);
});

test("a Claude-only launch write wires BOTH agents from the slot: a pin change is rendered with no request, and a slot never probed is probed once", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  let probes = 0;
  setIntegrationProbeFetch(() => {
    probes++;
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });
  await addWork("direct", "github_pat_worktoken");
  const bakedIds = (): [string | undefined, string | undefined] => {
    const settings = JSON.parse(readFileSync(settingsPathFor(claudeHome, WORK), "utf8")) as {
      env: Record<string, string>;
    };
    const doc = readToml(join(codexHome, "config.toml"));
    const providers = doc.model_providers as Record<string, Record<string, unknown>>;
    const headers = providers[codexProviderId(WORK)]?.http_headers as Record<string, string>;
    return [
      settings.env.ANTHROPIC_CUSTOM_HEADERS?.match(/Copilot-Integration-Id: (\S+)/)?.[1],
      headers?.["Copilot-Integration-Id"],
    ];
  };
  expect(bakedIds()).toEqual([undefined, undefined]);

  // The pin overlays the slot's identity: the Claude launcher's write (`cl --profile`) renders
  // it into BOTH files with no request, so the two never disagree and nothing is re-derived.
  new CopilotEnvConfig().setProfile(WORK, { identity: "copilot-developer-sandbox" });
  resetIntegrationIdentityCache();
  probes = 0;
  await launcherHook();
  expect(probes).toBe(0);
  expect(bakedIds()).toEqual(["copilot-developer-sandbox", "copilot-developer-sandbox"]);
  // Cleared, the slot's probed identity (the default) returns, still with no request.
  new CopilotEnvConfig().delProfile(WORK, "identity");
  resetIntegrationIdentityCache();
  await launcherHook();
  expect(probes).toBe(0);
  expect(bakedIds()).toEqual([undefined, undefined]);

  // A slot never probed (a hand edit dropped the pair) is the one gap: the re-render probes once,
  // stores the pair, and the next re-render is quiet again.
  const state = new CopilotEnvState();
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "github_pat_worktoken" },
    mode: "direct",
  });
  const raw = JSON.parse(readFileSync(new CopilotApiPaths().stateStoreFile, "utf8")) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  delete raw.profiles.work?.integrationIdentity;
  delete raw.profiles.work?.copilotHost;
  writeFileSync(new CopilotApiPaths().stateStoreFile, `${JSON.stringify(raw)}\n`);
  expect(state.readProfileDirectPair(WORK)).toEqual({});
  resetIntegrationIdentityCache();
  await launcherHook();
  expect(probes).toBeGreaterThan(0);
  expect(state.readProfileDirectPair(WORK)).toEqual({
    integrationId: null,
    host: DEFAULT_COPILOT_API_BASE,
  });
  probes = 0;
  resetIntegrationIdentityCache();
  await launcherHook();
  expect(probes).toBe(0);
});

test("the cl --profile launch hook re-renders a Direct profile from the slot: no request, both agent files byte-identical", async () => {
  tmpProxyHome();
  const claudeHome = tmpClaudeHome();
  const codexHome = tmpCodexHome();
  await addWork("direct", "github_pat_worktoken");
  const bytes = (): [string, string] => [
    readFileSync(settingsPathFor(claudeHome, WORK), "utf8"),
    readFileSync(join(codexHome, "config.toml"), "utf8"),
  ];
  const before = bytes();
  // Every /models answer is a rejection: a probe here would count AND change the verdict.
  let probes = 0;
  setIntegrationProbeFetch(() => {
    probes++;
    return Promise.resolve(new Response("PATs not supported", { status: 400 }));
  });
  resetIntegrationIdentityCache();
  const path = await commandDeps().writeClaudeProfileSettings(WORK, "direct");
  expect(path).toBe(settingsPathFor(claudeHome, WORK));
  expect(probes).toBe(0);
  expect(bytes()).toEqual(before);
});

test("profile add/del keeps the Claude Desktop entry in lockstep when Desktop is present", async () => {
  tmpProxyHome();
  // Opt this test into "Desktop installed": the seam dir exists.
  const dataDir = join(dir, "claude-desktop");
  mkdirSync(dataDir, { recursive: true });
  process.env[CLAUDE_DESKTOP_DIR_ENV] = dataDir;
  const library = desktopLibraryDirUnder(dataDir);
  // The proxy entry's model discovery falls back to Copilot's catalog while the daemon is down:
  // stub the global fetch it reaches (nothing leaves for the network) and pin what it asked.
  const seen: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    seen.push(String(input));
    return String(input).startsWith("https://")
      ? Promise.resolve(Response.json({ data: [{ id: "claude-fable-5" }] }))
      : Promise.reject(new Error("offline"));
  }) as typeof fetch;

  await addWork("proxy", "ghp_worktoken");
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
  expect(seen.filter((url) => url.startsWith("https://"))).toEqual([
    "https://api.githubcopilot.com/models",
  ]);

  await delProfile(WORK, false);
  const after = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
    entries: unknown[];
  };
  expect(after.entries).toEqual([]);
  expect(existsSync(join(library, `${entry?.id}.json`))).toBe(false);
});

test("claude-desktop false: profile add wires no Desktop entry and --sync removes a stale one", async () => {
  tmpProxyHome();
  const dataDir = join(dir, "claude-desktop");
  mkdirSync(dataDir, { recursive: true });
  process.env[CLAUDE_DESKTOP_DIR_ENV] = dataDir;
  const library = desktopLibraryDirUnder(dataDir);
  const entryNames = (): string[] => {
    if (!existsSync(join(library, "_meta.json"))) return [];
    const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
      entries: { name: string }[];
    };
    return meta.entries.map((e) => e.name);
  };
  // The entry wires below fall back to Copilot's catalog while the daemon is down: stub the
  // global fetch they reach (nothing leaves for the network) and pin what they asked.
  const seen: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    seen.push(String(input));
    return String(input).startsWith("https://")
      ? Promise.resolve(Response.json({ data: [{ id: "claude-fable-5" }] }))
      : Promise.reject(new Error("offline"));
  }) as typeof fetch;

  // Key on (the default): the add wires the entry.
  await addWork("proxy", "ghp_worktoken");
  expect(entryNames()).toEqual(["copilot-env: work"]);
  const helper = desktopHelperPath(resolveRootHome(), "proxy", WORK);
  expect(existsSync(helper)).toBe(true);

  // Key off: the launcher-style re-render (the Claude adapter's profile write, the
  // same path `cl --profile` takes) sweeps the entry -- no sync or re-add needed.
  new CopilotEnvConfig().set({ "claude.desktop": false });
  await captureAllWrites(() => launcherHook());
  expect(entryNames()).toEqual([]);
  expect(existsSync(helper)).toBe(false);
  // --sync (both agents) is a reconcile point too: idempotent on the swept library.
  await syncNamedProfiles();
  expect(entryNames()).toEqual([]);

  await addProfile(WORK, { mode: "auto", noAuth: true });
  expect(entryNames()).toEqual([]);
  new CopilotEnvConfig().del("claude.desktop");
  await syncNamedProfiles();
  expect(entryNames()).toEqual(["copilot-env: work"]);
  expect(existsSync(helper)).toBe(true);
  // The add asked Copilot's generic host for its catalog once; the quiet --sync re-wire
  // discovers nothing. Nothing else left the stub.
  expect(seen.filter((url) => url.startsWith("https://"))).toEqual([
    "https://api.githubcopilot.com/models",
  ]);
});
