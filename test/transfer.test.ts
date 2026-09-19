// The `agent settings` bundle round-trips the two portable stores and re-derives everything else.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  applyImportPlan,
  buildExportBundle,
  type ImportDeps,
  type ImportOutcome,
  type ImportPlan,
  parseSettingsBundle,
  planImport,
  REDACTED_TOKEN,
  rollbackCommand,
  serializeSettingsBundle,
  SETTINGS_BACKUP_KEEP,
  settingsBackupDir,
  type SettingsBundle,
} from "../src/agents/transfer.ts";
import { runClaude, runCodex } from "../src/agents/configure_defaults.ts";
import { settingsPathFor } from "../src/claude/paths.ts";
import { getHostLocalCodexHome } from "../src/codex/host.ts";
import { codexConfigPath } from "../src/codex/paths.ts";
import { importRestartHints, runSettings } from "../src/commands/settings.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  CopilotEnvState,
  type ProfileSlot,
  type StoredCredential,
} from "../src/copilot_api/env_state.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { claudeDesktopStatus, reconcileClaudeDesktopWiring } from "../src/agents/claude_desktop.ts";
import { wireClaudeDesktopEntry } from "../src/claude/desktop.ts";
import { CLAUDE_DESKTOP_DIR_ENV, desktopLibraryDirUnder } from "../src/claude/desktop_library.ts";
import { resolveRootHome } from "../src/copilot_api/paths.ts";
import { parseProfileName, type ProfileName } from "../src/copilot_api/profile.ts";
import { afterEach, beforeEach, expect, test } from "./helpers/testing.ts";
import { type AgentHomes, envSnapshot, isolateAgentHomes, resetExitCode } from "./helpers/env.ts";
import { writeRunState } from "./helpers/fixtures.ts";
import { captureChannels } from "./helpers/output.ts";

const WIN = process.platform === "win32";
const WORK = parseProfileName("work");

const restoreEnv = envSnapshot();

// Direct wiring probes the Copilot integration identity over the network; the stub resolves
// the default identity offline. Tests that must prove NO probe ran install a counting stub.
beforeEach(() => {
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
});

afterEach(() => {
  setIntegrationProbeFetch(null);
  restoreEnv();
  resetExitCode();
});

function isolate(): AgentHomes {
  return isolateAgentHomes("copilot-transfer-");
}

/** Plan + apply in one call: these cases need no confirmation step between the two. */
function applyImportBundle(bundle: SettingsBundle, deps: ImportDeps = {}): Promise<ImportOutcome> {
  return applyImportPlan(planImport(bundle, deps));
}

/** stderr is the command's narration logger. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  return (await captureChannels(fn)).stderr;
}

/** claudeTokenMultiplier is a registry key newer than the bundle feature, so its round trip
 *  proves the schema reuse tracks the registry. */
async function seedStores(): Promise<void> {
  new CopilotEnvConfig().set({
    "daemon.auto-start": true,
    "daemon.port": 5050,
    "proxy.claude-token-multiplier": 2.5,
  });
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_default");
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
  state.set({ codexCatalogLastAttemptMs: 123, codexCatalogCodexVersion: "9.9.9" });
  new OwnershipLedger().record("webSearchDeny", "/some/other/machine/settings.json");
  // The default record is the landing's (`agent init`); each single-agent write re-renders it.
  state.recordDefaultMode("proxy");
  await runCodex({ kind: "configure", mode: "proxy" });
  await runClaude({ kind: "configure", mode: "proxy" });
}

/** The bundle's config section: the global map and the per-profile sections. */
function configOf(
  global: Record<string, unknown>,
  profiles: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  return { global, profiles };
}

/** A minimal VALID raw bundle; tests override sections to probe the parser. */
function rawBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 2,
    config: configOf({}),
    credential: { githubToken: null, authProvider: null },
    profiles: {},
    modes: { codex: "none", claude: "none" },
    ...overrides,
  };
}

// --- export -------------------------------------------------------------------

test("export redacts every token by default; withCredentials includes them", async () => {
  isolate();
  await seedStores();
  // A stored price-list URL may carry a credential in its query: without the tokens
  // it travels as the tokens' own redaction marker, never as its value.
  const secretUrl = "https://pricing.example/models?token=SECRET-PRICING-TOKEN";
  new CopilotEnvConfig().set({ "cost.pricing-url": secretUrl });

  const redacted = buildExportBundle();
  expect(redacted.credential.githubToken).toBe(REDACTED_TOKEN);
  expect(redacted.profiles.work?.githubToken).toBe(REDACTED_TOKEN);
  expect(redacted.config.global["cost.pricing-url"]).toBe(REDACTED_TOKEN);
  expect(redacted.config.global["daemon.port"]).toBe(5050);
  const redactedText = JSON.stringify(redacted);
  expect(redactedText).not.toContain("ghp_");
  expect(redactedText).not.toContain("SECRET-PRICING-TOKEN");
  expect(redactedText).not.toContain("pricing.example");
  // The parser admits the marker on this key alone; every other key keeps its own
  // domain, so a string is fine where the key takes one and junk where it does not.
  expect(parseSettingsBundle(JSON.parse(redactedText)).config.global["cost.pricing-url"]).toBe(
    REDACTED_TOKEN,
  );
  expect(() =>
    parseSettingsBundle(rawBundle({ config: configOf({ "daemon.version": REDACTED_TOKEN }) }))
  )
    .not.toThrow();
  expect(() =>
    parseSettingsBundle(rawBundle({ config: configOf({ "daemon.port": REDACTED_TOKEN }) }))
  )
    .toThrow(/config\.global\.daemon\.port is invalid/);

  const full = buildExportBundle({ withCredentials: true });
  expect(full.credential.githubToken).toBe("ghp_default");
  expect(full.profiles.work?.githubToken).toBe("ghp_work");
  expect(full.config.global["cost.pricing-url"]).toBe(secretUrl);
});

test("the per-profile settings section travels: export, then import on a fresh machine, restores it verbatim", async () => {
  isolate();
  await seedStores();
  const config = new CopilotEnvConfig();
  config.setProfile(null, { identity: "copilot-developer-cli" });
  config.setProfile(WORK, {
    host: "https://copilot-api.ghe.example",
    "proxy.small-model": "gpt-5",
  });
  const exported = buildExportBundle();
  expect(exported.config.profiles).toEqual({
    default: { identity: "copilot-developer-cli" },
    work: { host: "https://copilot-api.ghe.example", "proxy.small-model": "gpt-5" },
  });
  const bundle = parseSettingsBundle(JSON.parse(serializeSettingsBundle(exported)));

  isolate();
  await applyImportBundle(bundle);
  const imported = new CopilotEnvConfig();
  expect(imported.read().profiles).toEqual(exported.config.profiles);
  expect(imported.read().global).not.toHaveProperty("identity");
  // The readers see the section through the one precedence rule.
  expect(imported.pinnedIntegrationId(null)).toBe("copilot-developer-cli");
  expect(imported.pinnedIntegrationId(WORK)).toBeNull();
  expect(imported.copilotHost(WORK)).toBe("https://copilot-api.ghe.example");
});

test("export carries the stores + modes and never the machine-local state keys", async () => {
  isolate();
  await seedStores();

  const bundle = buildExportBundle({ withCredentials: true });
  expect(bundle.formatVersion).toBe(2);
  expect(bundle.config).toEqual({
    global: {
      "daemon.auto-start": true,
      "daemon.port": 5050,
      "proxy.claude-token-multiplier": 2.5,
    },
    profiles: {},
  });
  expect(bundle.modes).toEqual({ codex: "proxy", claude: "proxy" });
  expect(bundle.profiles.work?.mode).toBe("proxy");
  // The reserved default slot travels as the `credential` section, never as a
  // profiles entry (the bundle format is an external contract).
  expect(bundle.profiles.default).toBeUndefined();
  const text = JSON.stringify(bundle);
  expect(text).not.toContain("codexCatalog");
  expect(text).not.toContain("webSearchDeny");
});

// --- validation (strict parse boundary) ---------------------------------------

test("a bundle's codex-home from the other OS is left out with a warning; the rest imports, and a non-path is still a rejection", () => {
  isolate();
  // The one preference whose value is a machine path: a Linux export read on Windows, or the reverse.
  const foreign = process.platform === "win32" ? "/srv/codex" : "C:\\Codex";
  const line =
    `codex.home "${foreign}" is not a path on this OS; skipped, set it here with agent config`;
  const bundle = parseSettingsBundle(
    rawBundle({ config: configOf({ "codex.home": foreign, "daemon.port": 4242 }) }),
  );
  expect(bundle.config).toEqual({ global: { "daemon.port": 4242 }, profiles: {} });
  expect(bundle.skippedConfig).toEqual([line]);
  expect(planImport(bundle).skipped).toEqual([line]);
  expect(() =>
    parseSettingsBundle(rawBundle({ config: configOf({ "codex.home": "relative/dir" }) }))
  )
    .toThrow(/config\.global\.codex\.home is invalid/);
});

test("parseSettingsBundle rejects non-objects, unknown formatVersion, and missing sections", () => {
  expect(() => parseSettingsBundle("nope")).toThrow(/JSON object/);
  expect(() => parseSettingsBundle({})).toThrow(/formatVersion/);
  // The version value is not echoed (a mangled bundle can hold anything there).
  expect(() => parseSettingsBundle({ formatVersion: 3 })).toThrow(
    /unsupported settings bundle formatVersion - /,
  );
  // Right version, missing sections: rejected, never imported as empty stores.
  expect(() => parseSettingsBundle({ formatVersion: 2 })).toThrow(/invalid settings bundle/);
  expect(() => parseSettingsBundle(rawBundle({ extra: 1 }))).toThrow(
    /unknown key under the bundle root/,
  );
});

test("junk config keys and malformed values are rejections, never dropped or coerced", () => {
  // Unknown-key rejections name the PARENT only: the key text itself is
  // untrusted (a token can land as a key in a mangled bundle).
  let message = "";
  try {
    parseSettingsBundle(rawBundle({ config: configOf({ "ghp_leaked_as_key": true }) }));
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("unknown key under config.global");
  expect(message).not.toContain("ghp_leaked_as_key");
  // The store's lenient read schema would coerce these to "unset"; the bundle
  // parser must reject them instead (full-replace would silently reset a local
  // pref), naming the key but never echoing the received value.
  for (
    const bad of [
      { "proxy.claude-token-multiplier": "2" },
      { "daemon.auto-start": "yes" },
      { "daemon.port": 0 },
    ]
  ) {
    message = "";
    try {
      parseSettingsBundle(rawBundle({ config: configOf(bad) }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`config.global.${Object.keys(bad)[0]} is invalid`);
    expect(message).not.toContain("yes");
    expect(message).not.toContain('"2"');
  }
  // The identity pin WINS over probed identities and lands in HTTP headers, so a
  // header-splitting value is rejected by the shared shape (INTEGRATION_ID_RE in
  // config_registry.ts) -- and never echoed. It lives in a profile's section.
  message = "";
  try {
    parseSettingsBundle(
      rawBundle({ config: configOf({}, { default: { identity: "evil\r\nX-Injected: 1" } }) }),
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("config.profiles.default.identity is invalid");
  // A profile key in the global map, or a global key in a section, is an unknown key there.
  expect(() => parseSettingsBundle(rawBundle({ config: configOf({ identity: "x" }) }))).toThrow(
    /unknown key under config\.global/,
  );
  expect(() =>
    parseSettingsBundle(rawBundle({ config: configOf({}, { work: { "daemon.port": 4242 } }) }))
  ).toThrow(/unknown key under config\.profiles\.work/);
  // The default's proxy knobs live in the global map (no command writes or removes them in its
  // section), so a default-section override is refused; a named section takes it.
  expect(() =>
    parseSettingsBundle(
      rawBundle({ config: configOf({}, { default: { "proxy.small-model": "gpt-5" } }) }),
    )
  ).toThrow(/unknown key under config\.profiles\.default/);
  expect(
    parseSettingsBundle(
      rawBundle({ config: configOf({}, { work: { "proxy.small-model": "gpt-5" } }) }),
    ).config.profiles,
  ).toEqual({ work: { "proxy.small-model": "gpt-5" } });
  expect(message).not.toContain("evil");
});

test("invalid slots are rejections that never echo the token", () => {
  // A token without a provider could never resolve (provider-driven); importing
  // it would only wipe a working local credential -- reject at the boundary.
  let message = "";
  try {
    parseSettingsBundle(
      rawBundle({ credential: { githubToken: "ghp_secret_leak", authProvider: null } }),
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("credential carries a token without an authProvider");
  expect(message).not.toContain("ghp_secret_leak");

  // Same no-echo guarantee for a malformed profile slot that carries a token.
  message = "";
  try {
    parseSettingsBundle(
      rawBundle({
        profiles: {
          work: { githubToken: "ghp_secret_leak", authProvider: "gh-token", mode: "bogus" },
        },
      }),
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("profiles.work.mode");
  expect(message).not.toContain("ghp_secret_leak");

  // gh-cli holds no token of its own: a slot pairing both is contradictory
  // (the ignored token would sit in the store until an export exposed it).
  message = "";
  try {
    parseSettingsBundle(
      rawBundle({ credential: { githubToken: "ghp_secret_leak", authProvider: "gh-cli" } }),
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("pairs a token with the gh-cli provider");
  expect(message).not.toContain("ghp_secret_leak");

  // A gh account pin only means anything under gh-cli: paired with a token
  // provider it would sit dead in the store, so it is the same class of
  // contradiction as token+gh-cli.
  expect(() =>
    parseSettingsBundle(
      rawBundle({
        credential: { githubToken: "x", authProvider: "gh-token", ghUser: "work-bot" },
      }),
    )
  ).toThrow(/pairs a ghUser account pin with a non-gh-cli provider/);
  // Same login-shape gate as the store's write choke point (the pin becomes
  // `gh auth token --user` argv, crossing cmd.exe on Windows).
  expect(() =>
    parseSettingsBundle(
      rawBundle({ credential: { githubToken: null, authProvider: "gh-cli", ghUser: "%PATH%" } }),
    )
  ).toThrow(/ghUser must be a GitHub login/);

  expect(() => parseSettingsBundle(rawBundle({ modes: { codex: "bogus", claude: "direct" } })))
    .toThrow(/modes.codex/);
  expect(() => parseSettingsBundle(rawBundle({ profiles: { "NOT A NAME": {} } }))).toThrow(
    /invalid profile name/,
  );
  expect(() => parseSettingsBundle(rawBundle({ profiles: { work: { nope: 1 } } }))).toThrow(
    /unknown key under profiles.work/,
  );
});

// --- import -------------------------------------------------------------------

test("round trip: export -> wipe -> import restores stores and re-derives wiring", async () => {
  isolate();
  await seedStores();
  const bundle = buildExportBundle({ withCredentials: true });

  // A brand-new "machine": fresh temp homes, empty stores.
  const machine2 = isolate();

  const outcome = await applyImportBundle(bundle);
  expect(outcome.skipped).toEqual([]);
  expect(outcome.failures).toEqual([]);
  expect(outcome.modes).toEqual({ codex: "proxy", claude: "proxy" });
  expect(outcome.wiredProfiles).toEqual([WORK]);

  expect(new CopilotEnvConfig().read().global["daemon.auto-start"]).toBe(true);
  expect(new CopilotEnvConfig().read().global["daemon.port"]).toBe(5050);
  expect(new CopilotEnvConfig().read().global["proxy.claude-token-multiplier"]).toBe(2.5);
  const state = new CopilotEnvState().read();
  expect(state.githubToken).toBe("ghp_default");
  expect(state.authProvider).toBe("gh-token");
  expect(state.profiles.work).toMatchObject({ githubToken: "ghp_work", mode: "proxy" });
  // The default-wiring pass recorded the agreed mode into the reserved slot.
  expect(new CopilotEnvState().readProfileSlot(null).mode).toBe("proxy");
  // Machine-local state was re-derived (reset), never copied from the source.
  expect(state.codexCatalogLastAttemptMs).toBe(0);
  expect(state.codexCatalogCodexVersion).toBeNull();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).not.toContain(
    "/some/other/machine/settings.json",
  );
  expect(existsSync(settingsPathFor(machine2.claudeHome))).toBe(true);
  expect(existsSync(settingsPathFor(machine2.claudeHome, WORK))).toBe(true);
  expect(readFileSync(join(machine2.codexHome, "config.toml"), "utf8")).toContain(
    "copilot-env-work",
  );
});

// The stored pricing-url follows the tokens' import contract, not the prefs': a
// redacted marker keeps the local value, while a credentials-included bundle that
// lacks the key deletes it (full-replace) and one that carries it sets it.
for (
  const { name, bundleUrl, expected } of [
    { name: "redacted", bundleUrl: REDACTED_TOKEN, expected: "https://local.example/models" },
    { name: "absent", bundleUrl: undefined, expected: undefined },
    {
      name: "present",
      bundleUrl: "https://bundle.example/models",
      expected: "https://bundle.example/models",
    },
  ]
) {
  test(`importing a bundle whose pricing-url is ${name} over a stored one`, async () => {
    isolate();
    new CopilotEnvConfig().set({
      "cost.pricing-url": "https://local.example/models",
      "daemon.port": 5050,
    });
    const bundle = parseSettingsBundle(
      rawBundle({
        config: configOf({
          "daemon.auto-start": true,
          ...(bundleUrl === undefined ? {} : { "cost.pricing-url": bundleUrl }),
        }),
      }),
    );
    const plan = planImport(bundle);
    // The confirmation names the local keys the import rewrites: the redacted one is kept.
    const prefsLine = plan.writes.find((line) => line.startsWith("preferences (")) ?? "";
    expect(prefsLine).toContain("daemon.port");
    expect(prefsLine.includes("pricing-url")).toBe(name !== "redacted");

    await applyImportPlan(plan);
    const after = new CopilotEnvConfig().read();
    expect(after.global["cost.pricing-url"]).toBe(expected);
    // Every other preference still follows full-replace.
    expect(after.global["daemon.auto-start"]).toBe(true);
    expect(after.global["daemon.port"]).toBeUndefined();
  });
}

/** A redacted bundle carries no token: each slot lands only if the target machine already
 *  resolves a credential for it (the resulting-slot rule), and the marker never reaches the store.
 *  Proxy default wiring needs no credential (`agent start` resolves its own), so it re-derives
 *  regardless. */
const REDACTED_LANDINGS: {
  name: string;
  /** The bundle; an export is built on its own machine first. */
  bundle: () => Promise<SettingsBundle>;
  /** The target machine's stores before the import. */
  local: () => void;
  /** Substrings of the skip hints; none means nothing was skipped. */
  skipped: string[];
  modes: ImportOutcome["modes"];
  wiredProfiles: ProfileName[];
  /** The whole profile map after the import, by name. */
  profiles: ProfileName[];
  /** The imported prefs land whatever the slots did: the bundle's `daemon.auto-start` after. */
  autoStart: boolean | undefined;
  defaultCredential: StoredCredential;
  workSlot: ProfileSlot;
}[] = [
  {
    name: "a fresh machine imports prefs + proxy wiring, but no slot",
    bundle: async () => {
      isolate();
      await seedStores();
      return buildExportBundle(); // redacted; modes are proxy/proxy
    },
    local: () => {},
    skipped: ["run `agent auth`", "agent profile work add"],
    modes: { codex: "proxy", claude: "proxy" },
    wiredProfiles: [],
    profiles: [],
    autoStart: true,
    defaultCredential: { kind: "none", provider: null },
    // No artifacts, no placeholder token, no mode-only slot.
    workSlot: { kind: "partial", credential: { kind: "none", provider: null }, mode: null },
  },
  {
    name: "resolvable LOCAL credentials in both slots wire normally",
    bundle: async () => {
      isolate();
      await seedStores();
      return buildExportBundle();
    },
    local: () => {
      const state = new CopilotEnvState();
      new Credential(state).store("gh-token", "ghp_local_default");
      state.commitProfile(WORK, {
        credential: { kind: "stored", provider: "gh-token", token: "ghp_local_work" },
        mode: "direct",
      });
    },
    skipped: [],
    modes: { codex: "proxy", claude: "proxy" },
    wiredProfiles: [WORK],
    profiles: [WORK],
    autoStart: true,
    defaultCredential: { kind: "stored", provider: "gh-token", token: "ghp_local_default" },
    workSlot: {
      kind: "complete",
      credential: { kind: "stored", provider: "gh-token", token: "ghp_local_work" },
      mode: "proxy",
    },
  },
  {
    // The default slot is empty in the bundle, so the local one is KEPT, not cleared; the work
    // slot cannot resolve and lands nowhere.
    name: "an unresolvable slot leaves the existing state untouched",
    bundle: () =>
      Promise.resolve(parseSettingsBundle(
        rawBundle({
          profiles: {
            work: { githubToken: REDACTED_TOKEN, authProvider: "gh-token", mode: "proxy" },
          },
        }),
      )),
    local: () => new Credential().store("gh-token", "ghp_local_default"),
    skipped: ["agent profile work add"],
    modes: null,
    wiredProfiles: [],
    profiles: [],
    autoStart: undefined, // the bundle carries no prefs
    defaultCredential: { kind: "stored", provider: "gh-token", token: "ghp_local_default" },
    workSlot: { kind: "partial", credential: { kind: "none", provider: null }, mode: null },
  },
];

for (const row of REDACTED_LANDINGS) {
  test(`a redacted bundle over ${row.name}`, async () => {
    const bundle = await row.bundle();
    const machine = isolate();
    row.local();
    const before = new CopilotEnvState().read();

    const outcome = await applyImportBundle(bundle);

    if (row.skipped.length === 0) expect(outcome.skipped).toEqual([]);
    for (const hint of row.skipped) expect(outcome.skipped.join("\n")).toContain(hint);
    expect(outcome.modes).toEqual(row.modes);
    expect(outcome.wiredProfiles).toEqual(row.wiredProfiles);
    expect(new CopilotEnvState().profileNames()).toEqual(row.profiles);
    expect(new CopilotEnvConfig().read().global["daemon.auto-start"]).toBe(row.autoStart);
    expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(row.modes !== null);
    expect(existsSync(settingsPathFor(machine.claudeHome, WORK))).toBe(
      row.wiredProfiles.length > 0,
    );
    const state = new CopilotEnvState();
    expect(state.readCredential(null)).toEqual(row.defaultCredential);
    expect(state.readProfileSlot(WORK)).toEqual(row.workSlot);
    expect(JSON.stringify(state.read())).not.toContain(REDACTED_TOKEN);
    if (row.modes === null) expect(state.read()).toEqual(before);
  });
}

test("the import's credential gate is direct-only: proxy wires without one", async () => {
  const machine = isolate();
  // The default is one mode for both agents: a bundle naming two is refused before any write.
  expect(() => parseSettingsBundle(rawBundle({ modes: { codex: "direct", claude: "proxy" } })))
    .toThrow(/one mode for both agents/);

  const proxy = parseSettingsBundle(
    rawBundle({
      credential: { githubToken: REDACTED_TOKEN, authProvider: "gh-token" },
      modes: { codex: "none", claude: "proxy" },
    }),
  );
  const wired = await applyImportBundle(proxy);
  // Claude (proxy) was written despite the unresolvable credential; on a fresh default that one
  // write is the landing for BOTH agents (profiles are atomic units), so Codex is proxy-wired too.
  expect(wired.skipped.join("\n")).not.toContain("agent init");
  expect(wired.modes).toEqual({ codex: "proxy", claude: "proxy" });
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(true);
  const codexConfig = join(machine.codexHome, "config.toml");
  const proxyBytes = readFileSync(codexConfig, "utf8");

  const direct = parseSettingsBundle(
    rawBundle({
      credential: { githubToken: REDACTED_TOKEN, authProvider: "gh-token" },
      modes: { codex: "direct", claude: "none" },
    }),
  );
  const gated = await applyImportBundle(direct);
  const skipped = gated.skipped.join("\n");
  expect(skipped).toContain("agent init --direct");
  expect(skipped).not.toContain("agent init --proxy");
  // Codex (direct) was left untouched: the proxy wiring's bytes stand.
  expect(readFileSync(codexConfig, "utf8")).toBe(proxyBytes);
});

// The default is one mode for both agents, decided at PLAN time so the preview names every file
// the apply touches and the outcome reports both agents.
test("planImport decides the default's modes for both agents: record-less single mode lands both, mode-less credential rebakes Direct, skipped or unmanaged never", () => {
  const machine = isolate();
  const credential = { githubToken: "ghp_new", authProvider: "gh-token" };
  const plan = (modes: Record<string, string>) =>
    planImport(parseSettingsBundle(rawBundle({ credential, modes })));
  const state = new CopilotEnvState();
  const files = (p: ImportPlan) => ({
    modes: p.modes,
    codexFile: p.writes.join("\n").includes(codexConfigPath(machine.codexHome)),
    claudeFile: p.writes.join("\n").includes(settingsPathFor(machine.claudeHome)),
  });

  // No record: one managed mode is the first landing and wires both; an unmanaged mode for the
  // other agent is overridden, and its "left untouched" line says what lands instead.
  expect(files(plan({ codex: "direct", claude: "none" }))).toEqual({
    modes: { codex: "direct", claude: "direct" },
    codexFile: true,
    claudeFile: true,
  });
  const overridden = plan({ codex: "other", claude: "proxy" });
  expect(overridden.modes).toEqual({ codex: "proxy", claude: "proxy" });
  expect(overridden.skipped).toEqual([
    "Codex wiring: the default profile has no recorded mode, so the bundle's proxy wiring " +
    "lands for both agents (one mode for both)",
  ]);
  // A recorded Direct default: a bundle recording no default wiring rebakes both for the new
  // credential; a bundle whose Codex wiring is unmanaged (`other`, left untouched) does not.
  state.recordDefaultMode("direct");
  expect(files(plan({ codex: "none", claude: "none" }))).toEqual({
    modes: { codex: "direct", claude: "direct" },
    codexFile: true,
    claudeFile: true,
  });
  expect(files(plan({ codex: "other", claude: "none" }))).toEqual({
    modes: { codex: null, claude: null },
    codexFile: false,
    claudeFile: false,
  });
  // A recorded proxy default: a mode-less credential landing rebakes nothing (no pair to renew).
  state.recordDefaultMode("proxy");
  expect(plan({ codex: "none", claude: "none" }).modes).toEqual({ codex: null, claude: null });
});

// "Nothing hidden": the credential landing takes the default's pair, so even a bundle naming one
// agent lands both; the plan says so, names the other agent's file, and the outcome reports both.
test("a Direct default whose pair will not be stored at apply time rebakes both agents even when the bundle names one: the preview names Claude's file", async () => {
  const machine = isolate();
  const state = new CopilotEnvState();
  state.recordDefaultMode("direct");
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghp_old" });
  state.setProfileDirectPair(null, { integrationId: null, host: DEFAULT_COPILOT_API_BASE });
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
  const plan = planImport(parseSettingsBundle(rawBundle({
    credential: { githubToken: "ghp_new", authProvider: "gh-token" },
    modes: { codex: "direct", claude: "other" },
  })));
  expect(plan.modes).toEqual({ codex: "direct", claude: "direct" });
  expect(plan.writes.join("\n")).toContain(settingsPathFor(machine.claudeHome));
  expect(plan.skipped).toEqual([
    "Claude wiring: the default's Direct pair is not stored, so both agents are rebaked (one " +
    "mode for both)",
  ]);
  const outcome = await applyImportPlan(plan);
  expect({ failures: outcome.failures, modes: outcome.modes }).toEqual({
    failures: [],
    modes: { codex: "direct", claude: "direct" },
  });
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(true);
  expect(state.readProfileDirectPair(null).host).toBe(DEFAULT_COPILOT_API_BASE);

  // The pair dropped EARLIER (`agent auth` after the wiring) and a redacted bundle that keeps the
  // local credential: the apply's one-agent write would land both, so the plan says so too.
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghp_rotated" });
  expect(state.readProfileDirectPair(null)).toEqual({});
  rmSync(settingsPathFor(machine.claudeHome));
  const kept = planImport(parseSettingsBundle(rawBundle({
    credential: { githubToken: REDACTED_TOKEN, authProvider: "gh-token" },
    modes: { codex: "direct", claude: "none" },
  })));
  expect(kept.defaultSlot.action).toBe("keep");
  expect(kept.modes).toEqual({ codex: "direct", claude: "direct" });
  expect(kept.writes.join("\n")).toContain(settingsPathFor(machine.claudeHome));
  const rebaked = await applyImportPlan(kept);
  expect({ failures: rebaked.failures, modes: rebaked.modes }).toEqual({
    failures: [],
    modes: { codex: "direct", claude: "direct" },
  });
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(true);
  expect(state.readProfileDirectPair(null).host).toBe(DEFAULT_COPILOT_API_BASE);

  // The landing rule counts a half as present when it is stored OR pinned, judged from the same
  // snapshot the pair came from: the plan reads the BUNDLE's config (empty profile sections), not
  // the local pin and literal the apply is about to replace. The pair dropped again, so the plan
  // and the apply must both say "both agents".
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghp_rotated_twice" });
  new CopilotEnvConfig().setProfile(null, {
    identity: "copilot-developer-cli",
    host: DEFAULT_COPILOT_API_BASE,
  });
  rmSync(settingsPathFor(machine.claudeHome));
  const overlaid = planImport(parseSettingsBundle(rawBundle({
    credential: { githubToken: REDACTED_TOKEN, authProvider: "gh-token" },
    config: configOf({}),
    modes: { codex: "direct", claude: "none" },
  })));
  expect(overlaid.defaultSlot.action).toBe("keep");
  expect(overlaid.modes).toEqual({ codex: "direct", claude: "direct" });
  expect(overlaid.writes.join("\n")).toContain(settingsPathFor(machine.claudeHome));
  const landed = await applyImportPlan(overlaid);
  expect({ failures: landed.failures, modes: landed.modes }).toEqual({
    failures: [],
    modes: { codex: "direct", claude: "direct" },
  });
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(true);
  // The control the rule protects: the apply replaced the preferences, so the local pin and literal
  // are gone; the render-keyed rule, judged under the BUNDLE's overlay at plan time, agrees with
  // what the apply found here.
  expect(new CopilotEnvConfig().read().profiles).toEqual({});
});

test("gh-cli slots probe gh ONCE end to end: a failed probe skips them unless the local slot resolves, a pinned slot probes ITS account, and gh-cli wiring re-derives the identity", async () => {
  const machine = isolate();
  const bundle = parseSettingsBundle(
    rawBundle({
      credential: { githubToken: null, authProvider: "gh-cli" },
      modes: { codex: "none", claude: "direct" },
      profiles: {
        work: {
          githubToken: null,
          authProvider: "gh-cli",
          mode: "direct",
        },
        alt: { githubToken: null, authProvider: "gh-cli", mode: null },
      },
    }),
  );

  // gh does not resolve: nothing written anywhere, skip messages say how to fix.
  let probeCount = 0;
  const noGh = await applyImportBundle(bundle, {
    ghAuthToken: () => {
      probeCount++;
      return null;
    },
  });
  expect(noGh.skipped.join("\n")).toContain("gh auth login");
  expect(probeCount).toBe(1); // memoized: one probe for three gh-cli slots
  expect(new CopilotEnvState().read().authProvider).toBeNull();
  expect(new CopilotEnvState().read().profiles).toEqual({});
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(false);

  // gh resolves: REAL direct wiring runs for the default AND the profile, with still exactly
  // one gh probe (the wiring consumes the plan's resolved token) and no subprocess (the
  // identity probe is the stubbed fetch).
  probeCount = 0;
  const withGh = await applyImportBundle(bundle, {
    ghAuthToken: () => {
      probeCount++;
      return "gho_live";
    },
  });
  // The mode-less alt slot can only re-auth an existing profile; none exists
  // here, so it is skipped whole instead of landing as a half profile.
  expect(withGh.skipped.join("\n")).toContain("profile 'alt'");
  expect(withGh.skipped.join("\n")).toContain("agent profile alt add");
  expect(withGh.modes?.claude).toBe("direct");
  expect(withGh.wiredProfiles).toEqual([WORK]);
  expect(probeCount).toBe(1);
  const state = new CopilotEnvState().read();
  expect(state.authProvider).toBe("gh-cli");
  expect(state.githubToken).toBeNull();
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(true);
  expect(existsSync(settingsPathFor(machine.claudeHome, WORK))).toBe(true);
  expect(new CopilotEnvState().readProfileSlot(WORK).credential).toEqual({
    kind: "gh-cli",
    ghUser: null,
  });
  expect(new CopilotEnvState().profileNames()).toEqual([WORK]); // alt never landed

  // A pinned slot probes ITS account, and the pin lands with the credential.
  isolate();
  const asked: Array<string | null> = [];
  await applyImportBundle(
    parseSettingsBundle(
      rawBundle({
        credential: { githubToken: null, authProvider: "gh-cli", ghUser: "work-bot" },
        modes: { codex: "none", claude: "none" },
      }),
    ),
    {
      ghAuthToken: (ghUser) => {
        asked.push(ghUser ?? null);
        return "gho_live";
      },
    },
  );
  expect(asked).toEqual(["work-bot"]);
  expect(new CopilotEnvState().readCredential(null)).toEqual({
    kind: "gh-cli",
    ghUser: "work-bot",
  });

  // gh failing only rules out the BUNDLE's credential: over a working local token the
  // default falls through to the kept slot, so wiring proceeds and the local credential
  // survives untouched.
  const local = isolate();
  new Credential().store("gh-token", "github_pat_local");
  const keptLocal = await applyImportBundle(
    parseSettingsBundle(
      rawBundle({
        credential: { githubToken: null, authProvider: "gh-cli" },
        modes: { codex: "none", claude: "direct" },
      }),
    ),
    { ghAuthToken: () => null },
  );
  expect(keptLocal.skipped).toEqual([]);
  expect(keptLocal.modes?.claude).toBe("direct");
  expect(existsSync(settingsPathFor(local.claudeHome))).toBe(true);
  expect(new CopilotEnvState().read().authProvider).toBe("gh-token");
  expect(new Credential().resolve()).toBe("github_pat_local");
});

test("a mode-less bundle slot landing a new credential on a Direct profile probes and rebakes, and the preview names its files", async () => {
  const machine = isolate();
  const probes: (string | null)[] = [];
  // The first token is accepted under the CLI id alone, the second under the sandbox id alone:
  // a re-render of the first credential's files would bake the wrong identity for the second.
  const accepting = (id: string, token: string): void =>
    setIntegrationProbeFetch((_input, init) => {
      const headers = new Headers(init?.headers);
      probes.push(headers.get("Copilot-Integration-Id"));
      const ok = headers.get("authorization") === `Bearer ${token}` &&
        headers.get("Copilot-Integration-Id") === id;
      return Promise.resolve(
        ok
          ? new Response(JSON.stringify({ data: [] }), { status: 200 })
          : new Response("Personal Access Tokens are not supported", { status: 400 }),
      );
    });
  accepting("copilot-developer-cli", "github_pat_first");
  await applyImportBundle(
    parseSettingsBundle(rawBundle({
      profiles: {
        work: { githubToken: "github_pat_first", authProvider: "gh-token", mode: "direct" },
      },
    })),
  );
  const bakedId = (): string | undefined =>
    (JSON.parse(readFileSync(settingsPathFor(machine.claudeHome, WORK), "utf8")) as {
      env: Record<string, string>;
    }).env.ANTHROPIC_CUSTOM_HEADERS?.match(/Copilot-Integration-Id: (\S+)/)?.[1];
  expect(bakedId()).toBe("copilot-developer-cli");

  accepting("copilot-developer-sandbox", "github_pat_second");
  probes.length = 0;
  const reauth = parseSettingsBundle(rawBundle({
    profiles: { work: { githubToken: "github_pat_second", authProvider: "gh-token", mode: null } },
  }));
  // The overwrite preview names the profile's agent files: the apply rewrites them.
  const plan = planImport(reauth);
  expect(plan.writes.join("\n")).toContain(settingsPathFor(machine.claudeHome, WORK));
  const outcome = await applyImportPlan(plan);
  expect(outcome.failures).toEqual([]);
  expect(outcome.wiredProfiles).toEqual([WORK]);
  expect(probes.length).toBeGreaterThan(0);
  expect(bakedId()).toBe("copilot-developer-sandbox");
  expect(new Credential(undefined, WORK).resolve()).toBe("github_pat_second");
});

test("a profile wiring failure lands in failures and the command exits non-zero", async () => {
  const machine = isolate();
  // A foreign settings-work.json makes the Claude profile writer refuse.
  mkdirSync(machine.claudeHome, { recursive: true });
  writeFileSync(
    settingsPathFor(machine.claudeHome, WORK),
    JSON.stringify({ apiKeyHelper: "/somewhere/else.sh" }),
  );
  const file = join(machine.dir, "bundle.json");
  writeFileSync(
    file,
    JSON.stringify(
      rawBundle({
        profiles: { work: { githubToken: "ghp_work", authProvider: "gh-token", mode: "proxy" } },
      }),
    ),
  );

  const err = await captureStderr(() => runSettings({ importFrom: file, force: true }));

  expect(process.exitCode).toBe(1);
  // The summary covers BOTH failure kinds outcome.failures carries (a profile
  // whose commit failed and a wiring failure), not just "wiring".
  expect(err).toContain("but some profiles or wiring could not be applied (see above).");
  // The slot committed atomically (credential + mode) BEFORE the wiring, so the
  // failure leaves a COMPLETE-but-unwired slot -- never a half profile -- and
  // `agent sync` re-derives the artifacts from it.
  expect(new CopilotEnvState().readProfileSlot(WORK)).toEqual({
    kind: "complete",
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
});

/** One writer fails: the failure is one outcome.failures entry naming what failed, and the rest
 *  of the import proceeds. */
const FAILING_WRITERS: {
  name: string;
  /** Stages the plan on a fresh machine with the failure planted. */
  plan: (machine: AgentHomes) => ImportPlan;
  /** A substring of the one failures entry. */
  failure: string;
  wiredProfiles: ProfileName[];
  /** The profiles in the store afterwards. */
  profiles: ProfileName[];
}[] = [
  {
    // A whitespace token travels fine in the plan's types but rawCredentialPatch (inside
    // commitProfile) rejects it, so the FIRST slot's commit itself throws. The commit sits
    // INSIDE the per-profile containment: the slot is skipped whole, lands NOWHERE (no half
    // profile in the store), and never blocks the profiles after it.
    name: "a throwing profile COMMIT is contained per-slot",
    plan: () => {
      const plan = planImport(parseSettingsBundle(
        rawBundle({
          profiles: {
            bad: { githubToken: "ghp_bad", authProvider: "gh-token", mode: "proxy" },
            work: { githubToken: "ghp_work", authProvider: "gh-token", mode: "proxy" },
          },
        }),
      ));
      const bad = plan.profiles.find((p) => p.name === parseProfileName("bad"));
      if (
        bad === undefined || bad.landing.action !== "write" ||
        bad.landing.credential.kind !== "stored"
      ) {
        throw new Error("plan did not stage the bad profile as a token write");
      }
      bad.landing.credential.token = "   ";
      return plan;
    },
    failure: "profile 'bad'",
    wiredProfiles: [WORK],
    profiles: [WORK],
  },
  {
    // CLAUDE_CONFIG_DIR pointing at a FILE makes the Claude writer throw.
    name: "a default-wiring failure surfaces",
    plan: (machine) => {
      writeFileSync(join(machine.dir, "not-a-dir"), "");
      process.env.CLAUDE_CONFIG_DIR = join(machine.dir, "not-a-dir");
      return planImport(parseSettingsBundle(
        rawBundle({
          credential: { githubToken: "ghp_default", authProvider: "gh-token" },
          modes: { codex: "none", claude: "proxy" },
        }),
      ));
    },
    failure: "Claude:",
    wiredProfiles: [],
    profiles: [],
  },
];

for (const { name, plan, failure, wiredProfiles, profiles } of FAILING_WRITERS) {
  test(`${name} into outcome.failures; the profiles after it land as planned`, async () => {
    const machine = isolate();

    const outcome = await applyImportPlan(plan(machine));

    expect(outcome.failures.length).toBe(1);
    expect(outcome.failures[0]).toContain(failure);
    expect(outcome.wiredProfiles).toEqual(wiredProfiles);
    expect(new CopilotEnvState().profileNames()).toEqual(profiles);
  });
}

// --- the command layer ----------------------------------------------------------

test("settings requires exactly one of --export/--import and gates the modifier flags", async () => {
  await expect(runSettings({})).rejects.toThrow(/exactly one/);
  await expect(runSettings({ exportTo: true, importFrom: "x" })).rejects.toThrow(/exactly one/);
  await expect(runSettings({ importFrom: "x", withCredentials: true })).rejects.toThrow(
    /--with-credentials only applies/,
  );
  await expect(runSettings({ exportTo: true, force: true })).rejects.toThrow(
    /only apply to --import/,
  );
  await expect(runSettings({ exportTo: true, noBackup: true })).rejects.toThrow(
    /only apply to --import/,
  );
});

async function runSettingsCaptured(
  args: Parameters<typeof runSettings>[0],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await captureChannels(() => runSettings(args));
  return { stdout, stderr };
}

test("bare --export writes the redacted bundle to stdout; --with-credentials warns and includes the pricing-url", async () => {
  isolate();
  await seedStores();
  new CopilotEnvConfig().set({
    "cost.pricing-url": "https://pricing.example/models?token=SECRET-URL",
  });

  const redacted = await runSettingsCaptured({ exportTo: true });
  const doc = JSON.parse(redacted.stdout) as {
    formatVersion: number;
    credential: Record<string, unknown>;
    config: { global: Record<string, unknown> };
  };
  expect(doc.formatVersion).toBe(2);
  expect(doc.credential.githubToken).toBe(REDACTED_TOKEN);
  expect(doc.config.global["cost.pricing-url"]).toBe(REDACTED_TOKEN);
  expect(redacted.stdout).not.toContain("SECRET-URL");
  expect(redacted.stderr).not.toContain("REAL tokens");

  const full = await runSettingsCaptured({ exportTo: true, withCredentials: true });
  expect(full.stderr).toContain("REAL tokens (and any stored pricing-url)");
  expect(full.stderr).not.toContain("SECRET-URL");
  expect(JSON.parse(full.stdout).config.global["cost.pricing-url"]).toBe(
    "https://pricing.example/models?token=SECRET-URL",
  );
});

test("--export --with-credentials warns about the tokens even for a target inside our homes", async () => {
  isolate();
  await seedStores();
  // Inside the data home the write itself is silent bookkeeping; the warning is not a
  // write report and must still reach the user.
  const target = join(resolveRootHome(), "export.json");
  const { stderr } = await runSettingsCaptured({ exportTo: target, withCredentials: true });
  expect(stderr).not.toContain(" -> ");
  expect(stderr).toContain(
    `${target} contains your REAL tokens (and any stored pricing-url) - treat it like a password file.`,
  );
  expect(JSON.parse(readFileSync(target, "utf8")).credential.githubToken).toBe("ghp_default");
});

test("--export --with-credentials ends 0600 even over a pre-existing looser file", async () => {
  const machine = isolate();
  await seedStores();

  const redacted = join(machine.dir, "bundle.json");
  await runSettings({ exportTo: redacted });
  expect(JSON.parse(readFileSync(redacted, "utf8")).credential.githubToken).toBe(REDACTED_TOKEN);

  const full = join(machine.dir, "full.json");
  // Pre-seed a world-readable target: the overwrite must not inherit its mode.
  writeFileSync(full, "seed");
  if (!WIN) chmodSync(full, 0o644);
  await runSettings({ exportTo: full, withCredentials: true });
  expect(JSON.parse(readFileSync(full, "utf8")).credential.githubToken).toBe("ghp_default");
  if (!WIN) expect(statSync(full).mode & 0o777).toBe(0o600);
});

test("import rejects unreadable, non-JSON, and unknown-version files", async () => {
  const machine = isolate();
  await expect(runSettings({ importFrom: join(machine.dir, "missing.json") })).rejects.toThrow(
    /could not read/,
  );
  const notJson = join(machine.dir, "not.json");
  writeFileSync(notJson, "{nope");
  await expect(runSettings({ importFrom: notJson })).rejects.toThrow(/not valid JSON/);
  const wrongVersion = join(machine.dir, "v99.json");
  writeFileSync(wrongVersion, JSON.stringify({ formatVersion: 99 }));
  await expect(runSettings({ importFrom: wrongVersion })).rejects.toThrow(/formatVersion/);
});

test("import confirms only for actual overwrites: stores with content, or wiring writes", async () => {
  const machine1 = isolate();
  await seedStores();
  const file = join(machine1.dir, "bundle.json");
  await runSettings({ exportTo: file, withCredentials: true });

  // Non-empty stores, non-TTY (deno test): the guard fires before the prompt.
  await expect(runSettings({ importFrom: file })).rejects.toThrow(/--force/);

  // Fresh machine, EMPTY stores -- but the bundle rewrites both agents'
  // configs, so wiring alone still demands the confirmation.
  isolate();
  await expect(runSettings({ importFrom: file })).rejects.toThrow(/--force/);

  // A fresh-empty target importing ONLY store content (no wiring change)
  // overwrites nothing, so no prompt -- and no backup (nothing to roll back).
  const machine3 = isolate();
  const storesOnly = join(machine3.dir, "stores-only.json");
  writeFileSync(
    storesOnly,
    JSON.stringify(
      rawBundle({
        config: configOf({ "daemon.auto-start": true }),
        credential: { githubToken: "ghp_new", authProvider: "gh-token" },
      }),
    ),
  );
  await runSettings({ importFrom: storesOnly });
  expect(new Credential().resolve()).toBe("ghp_new");
  expect(new CopilotEnvConfig().read().global["daemon.auto-start"]).toBe(true);
  expect(existsSync(settingsBackupDir())).toBe(false);

  // A redacted profile WITH a mode plans as a skip on a fresh target, so it
  // demands no --force to write nothing (the prompt models the plan's writes).
  const machine4 = isolate();
  const skippedOnly = join(machine4.dir, "skipped-only.json");
  writeFileSync(
    skippedOnly,
    JSON.stringify(
      rawBundle({
        profiles: {
          work: { githubToken: REDACTED_TOKEN, authProvider: "gh-token", mode: "proxy" },
        },
      }),
    ),
  );
  await runSettings({ importFrom: skippedOnly });
  expect(new CopilotEnvState().read().profiles).toEqual({});
});

test("the MCP registration write line reflects the POST-import wire-mcp value", () => {
  isolate();
  new Credential().store("gh-token", "ghp_default");
  const directBundle = (config: Record<string, unknown>): Record<string, unknown> =>
    rawBundle({
      config: configOf(config),
      credential: { githubToken: "ghp_default", authProvider: "gh-token" },
      modes: { codex: "none", claude: "direct" },
    });

  // Local false, bundle silent (-> built-in default true): the apply replaces
  // the store before the Claude writer reads the flag, so the write HAPPENS
  // and must be listed.
  new CopilotEnvConfig().set({ "claude.wire-mcp": false });
  const listed = planImport(parseSettingsBundle(directBundle({})));
  expect(listed.writes.join("\n")).toContain("MCP registration");

  // Local true, bundle false: the write will NOT happen, so no line.
  new CopilotEnvConfig().set({ "claude.wire-mcp": true });
  const unlisted = planImport(parseSettingsBundle(directBundle({ "claude.wire-mcp": false })));
  expect(unlisted.writes.join("\n")).not.toContain("MCP registration");
});

test.skipIf(process.platform === "win32")(
  "import names the post-import Codex home and the farm action the bundle's codex-host implies",
  () => {
    const homes = isolate();
    new Credential().store("gh-token", "ghp_default");
    const proxyBundle = (config: Record<string, unknown>): Record<string, unknown> =>
      rawBundle({
        config: configOf(config),
        credential: { githubToken: "ghp_default", authProvider: "gh-token" },
        modes: { codex: "proxy", claude: "none" },
      });
    const writesOf = (config: Record<string, unknown>): string =>
      planImport(parseSettingsBundle(proxyBundle(config)))
        .writes.join("\n");
    const hostHome = getHostLocalCodexHome();
    const farmConfig = join(hostHome, "config.toml");

    // The bundle turns the farm on where none exists: the apply builds it and the
    // config lands there, not at the current effective home.
    const on = writesOf({ "codex.host": true });
    expect(on).toContain(`Per-host CODEX_HOME farm (built): ${hostHome}`);
    expect(on).toContain(`Codex config: ${farmConfig}`);
    expect(on).not.toContain(join(homes.codexHome, "config.toml"));

    // A wired farm with the bundle off OR silent (the key's default is off): the farm
    // goes and the config lands at the default home, even while the shell still exports
    // the (existing) farm and run state records it.
    mkdirSync(hostHome, { recursive: true });
    writeFileSync(farmConfig, 'model_provider = "copilot-env"\n');
    process.env.CODEX_HOME = hostHome;
    writeRunState({ codexHome: hostHome });
    for (const config of [{ "codex.host": false }, {}]) {
      const off = writesOf(config);
      expect(off).toContain(`Per-host CODEX_HOME farm (removed): ${hostHome}`);
      expect(off).toContain(`Codex config: ${join(homes.codexHome, "config.toml")}`);
      expect(off).not.toContain(farmConfig);
    }

    // Profile-only wiring resolves the home under the BUNDLE's value, not the current
    // store: locally off (record retired), bundle on -> the record is live again.
    new CopilotEnvConfig().set({ "codex.host": false });
    const profileOnly = (config: Record<string, unknown>): string =>
      planImport(
        parseSettingsBundle(rawBundle({
          config: configOf(config),
          credential: { githubToken: "ghp_default", authProvider: "gh-token" },
          profiles: { work: { githubToken: "ghp_work", authProvider: "gh-token", mode: "proxy" } },
        })),
      ).writes.join("\n");
    // Both Codex files the profile write touches are named, under the same home.
    expect(profileOnly({ "codex.host": true })).toContain(
      `Codex config: ${farmConfig}\nCodex profile config: ${join(hostHome, "work.config.toml")}`,
    );
    expect(profileOnly({})).toContain(
      `Codex config: ${join(homes.codexHome, "config.toml")}\n` +
        `Codex profile config: ${join(homes.codexHome, "work.config.toml")}`,
    );

    // A bundle codex-home is the root of it all: the farm builds under the path (the default farm
    // path is not the subject), and without the farm the path's own config.toml is the landing.
    const root = join(homes.dir, "bundle-root");
    const rootFarm = getHostLocalCodexHome(root);
    const rooted = writesOf({ "codex.home": root, "codex.host": true });
    expect(rooted).toContain(`Per-host CODEX_HOME farm (built): ${rootFarm}`);
    expect(rooted).toContain(`Codex config: ${join(rootFarm, "config.toml")}`);
    expect(rooted).not.toContain(hostHome);
    expect(writesOf({ "codex.home": root })).toContain(
      `Codex config: ${join(root, "config.toml")}`,
    );
    expect(profileOnly({ "codex.home": root })).toContain(
      `Codex config: ${join(root, "config.toml")}`,
    );

    // The shell's export is judged against the BUNDLE's root, as the apply will judge it: locally
    // rooted at `root` with its farm exported, a bundle with neither key honours that export
    // (it is not the default root's farm), so the line names it, not ~/.codex.
    new CopilotEnvConfig().set({ "codex.home": root, "codex.host": true });
    process.env.CODEX_HOME = rootFarm;
    expect(writesOf({})).toContain(`Codex config: ${join(rootFarm, "config.toml")}`);
  },
);

test("import surfaces the proxy restart hint when a projected key is set OR reset", () => {
  isolate();
  // small-model projects into the proxy's config.json at `agent start`, which a
  // running daemon will not re-read -- the import must say so.
  const prefs = (
    global: Record<string, unknown>,
    profiles: Record<string, Record<string, unknown>> = {},
  ) => parseSettingsBundle(rawBundle({ config: configOf(global, profiles) })).config;
  const hints = importRestartHints(prefs({ "proxy.small-model": "gpt-5-mini" }), prefs({}));
  expect(hints[0]).toContain("next proxy start");
  // Prefs are full-replace: a bundle that DROPS a stored projected key resets
  // it to default, which the daemon equally misses until a restart.
  const resetHints = importRestartHints(
    prefs({ "daemon.auto-start": true }),
    prefs({ "proxy.small-model": "gpt-5-codex" }),
  );
  expect(resetHints[0]).toContain("next proxy start");
  // A projected key set for ONE profile counts the same: that profile's daemon reads it.
  expect(
    importRestartHints(prefs({}, { work: { "proxy.small-model": "gpt-5" } }), prefs({}))[0],
  ).toContain("next proxy start");
  // A prefs-only bundle with no projected keys on either side stays silent.
  expect(
    importRestartHints(prefs({ "daemon.auto-start": true }), prefs({ "daemon.idle-timeout": 60 })),
  ).toEqual([]);
});

// --- pre-import backups -----------------------------------------------------------

test("import backs up the previous settings with credentials intact unless --no-backup, and the backup rolls back", async () => {
  const machine = isolate();
  await seedStores();
  const exported = join(machine.dir, "bundle.json");
  await runSettings({ exportTo: exported, withCredentials: true });

  // Diverge the machine from the exported state, so the import overwrites it.
  const diverge = (): void => {
    new CopilotEnvConfig().set({ "daemon.auto-start": false, "daemon.port": 6060 });
    new Credential().store("gh-token", "ghp_before_import");
  };

  // --no-backup skips the backup entirely: the import lands, no backup dir appears.
  diverge();
  await runSettings(
    { importFrom: exported, force: true, noBackup: true },
  );
  expect(new CopilotEnvConfig().read().global["daemon.port"]).toBe(5050);
  expect(existsSync(settingsBackupDir())).toBe(false);

  diverge();
  const imported = await captureStderr(() => runSettings({ importFrom: exported, force: true }));
  expect(new CopilotEnvConfig().read().global["daemon.port"]).toBe(5050);
  expect(new Credential().resolve()).toBe("ghp_default");

  // The backup captured the PRE-import state, tokens included, dir 700 / file 600.
  const backups = readdirSync(settingsBackupDir());
  expect(backups.length).toBe(1);
  const backupFile = join(settingsBackupDir(), backups[0] ?? "");
  // The backup is inside the data home (its write is silent), so the import must say the
  // rollback command itself, path included.
  expect(imported).toContain(`Roll back with: ${rollbackCommand(backupFile)}`);
  const backupDoc = JSON.parse(readFileSync(backupFile, "utf8"));
  expect(backupDoc.credential.githubToken).toBe("ghp_before_import");
  expect(backupDoc.config).toEqual({
    global: {
      "daemon.auto-start": false,
      "daemon.port": 6060,
      "proxy.claude-token-multiplier": 2.5,
    },
    profiles: {},
  });
  if (!WIN) {
    expect(statSync(settingsBackupDir()).mode & 0o777).toBe(0o700);
    expect(statSync(backupFile).mode & 0o777).toBe(0o600);
  }

  // Rolling back IS an import of the backup file.
  await runSettings(
    { importFrom: backupFile, force: true, noBackup: true },
  );
  expect(new CopilotEnvConfig().read().global["daemon.port"]).toBe(6060);
  expect(new CopilotEnvConfig().read().global["daemon.auto-start"]).toBe(false);
  expect(new Credential().resolve()).toBe("ghp_before_import");
  // --no-backup left the pile untouched.
  expect(readdirSync(settingsBackupDir()).length).toBe(1);
});

test("a mid-import failure still reports the backup and the rollback command", async () => {
  const machine = isolate();
  await seedStores();
  const exported = join(machine.dir, "bundle.json");
  await runSettings({ exportTo: exported, withCredentials: true });

  let message = "";
  try {
    await runSettings(
      { importFrom: exported, force: true },
      { applyPlan: () => Promise.reject(new Error("mid-import failure")) },
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("mid-import failure");
  expect(message).toContain("roll back with: agent settings --import ");
  expect(message).toContain(settingsBackupDir());
});

test("the backup pile is pruned to the newest 5", async () => {
  const machine = isolate();
  await seedStores();
  const exported = join(machine.dir, "bundle.json");
  await runSettings({ exportTo: exported, withCredentials: true });

  let firstBackup = "";
  for (let i = 0; i < SETTINGS_BACKUP_KEEP + 1; i++) {
    await runSettings({ importFrom: exported, force: true });
    if (i === 0) firstBackup = readdirSync(settingsBackupDir())[0] ?? "";
  }
  const names = readdirSync(settingsBackupDir());
  expect(names.length).toBe(SETTINGS_BACKUP_KEEP);
  expect(firstBackup).not.toBe("");
  expect(names).not.toContain(firstBackup);
});

test("a config-only import of claude-desktop false sweeps a PROMISED Desktop entry", async () => {
  const homes = isolate();
  const dataDir = join(homes.dir, "claude-desktop");
  mkdirSync(join(dataDir, "configLibrary"), { recursive: true });
  process.env[CLAUDE_DESKTOP_DIR_ENV] = dataDir;
  const library = desktopLibraryDirUnder(dataDir);
  // A complete proxy profile with its Desktop entry wired: a currently promised entry.
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
  await wireClaudeDesktopEntry({
    profile: WORK,
    mode: "proxy",
    credential: { kind: "command" },
    fetchImpl: () => Promise.reject(new Error("offline")),
  });
  const entryPath = () => {
    const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
      entries: { id: string; name: string }[];
    };
    const entry = meta.entries.find((e) => e.name === "copilot-env: work");
    return entry === undefined ? null : join(library, `${entry.id}.json`);
  };
  const wired = entryPath();
  expect(wired).not.toBeNull();
  // Control: with the key still on, a whole-library reconcile keeps the promised entry
  // (its upsert re-runs proxy model discovery, so the fetch is stubbed offline).
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("offline"));
  try {
    await captureStderr(() => reconcileClaudeDesktopWiring());
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(entryPath()).toBe(wired);

  // The import carries only the preference (no profiles, no modes): the imported false
  // must be what removes the entry, so the reconcile has to run AFTER the prefs land.
  const bundle = parseSettingsBundle(rawBundle({ config: configOf({ "claude.desktop": false }) }));
  await applyImportBundle(bundle);
  expect(new CopilotEnvConfig().claudeDesktopEnabled()).toBe(false);
  expect(entryPath()).toBeNull();
  expect(existsSync(wired ?? "")).toBe(false);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
});

test("a config-only import of claude-desktop true restores the DEFAULT Desktop entry", async () => {
  const homes = isolate();
  const dataDir = join(homes.dir, "claude-desktop");
  mkdirSync(join(dataDir, "configLibrary"), { recursive: true });
  process.env[CLAUDE_DESKTOP_DIR_ENV] = dataDir;
  const library = desktopLibraryDirUnder(dataDir);
  const names = () =>
    existsSync(join(library, "_meta.json"))
      ? (JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
        entries: { name: string }[];
      }).entries.map((e) => e.name)
      : [];
  // A managed proxy default (settings.json) written while the key was off: no entry.
  new CopilotEnvConfig().set({ "claude.desktop": false });
  new CopilotEnvState().recordDefaultMode("proxy"); // the default this re-render renders
  await runClaude({ kind: "configure", mode: "proxy" });
  expect(names()).toEqual([]);

  // The import carries only the preference: no adapter write runs, so the reconcile
  // itself must upsert the default entry (fetch stubbed: proxy discovery is offline).
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("offline"));
  try {
    const bundle = parseSettingsBundle(rawBundle({ config: configOf({ "claude.desktop": true }) }));
    await captureStderr(async () => {
      await applyImportBundle(bundle);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(new CopilotEnvConfig().claudeDesktopEnabled()).toBe(true);
  expect(names()).toEqual(["copilot-env"]);
  // Restored means owned and judged wired, not merely listed.
  const status = claudeDesktopStatus();
  expect(status.kind).toBe("inspected");
  if (status.kind === "inspected") {
    expect(status.owned).toHaveLength(1);
    expect(status.entries.map((e) => e.verdict.kind)).toEqual(["wired"]);
  }
});
