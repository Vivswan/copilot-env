// The `agent settings` bundle: export/import round-trips the two portable
// stores and re-derives everything else. Every test runs against isolated temp
// homes (isolateAgentHomes) and a stubbed integration-identity probe, so no
// real config, credential, or network is ever touched.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  applyImportBundle,
  applyImportPlan,
  buildExportBundle,
  parseSettingsBundle,
  planImport,
  REDACTED_TOKEN,
  SETTINGS_BACKUP_KEEP,
  settingsBackupDir,
} from "../src/agents/transfer.ts";
import { runClaude } from "../src/claude/config.ts";
import { settingsPathFor } from "../src/claude/paths.ts";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { runCodex } from "../src/codex/config.ts";
import { getHostLocalCodexHome } from "../src/codex/host.ts";
import { importRestartHints, parseSettingsAction, runSettings } from "../src/commands/settings.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { setIntegrationProbeFetch } from "../src/copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { reconcileClaudeDesktopWiring } from "../src/agents/claude_desktop.ts";
import {
  CLAUDE_DESKTOP_DIR_ENV,
  desktopLibraryDirUnder,
  wireClaudeDesktopEntry,
} from "../src/claude/desktop.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { afterEach, beforeEach, expect, test } from "./helpers/testing.ts";
import {
  type AgentHomes,
  envSnapshot,
  isolateAgentHomes,
  removeDir,
  resetExitCode,
  writeRunState,
} from "./helpers.ts";

const WIN = process.platform === "win32";
const WORK = parseProfileName("work");

const restoreEnv = envSnapshot();
// Round-trip tests isolate twice ("export machine", then a fresh "import
// machine"), so cleanup tracks every temp dir created in a test.
let dirs: string[] = [];

// Direct wiring probes the Copilot integration identity over the network; stub it
// so every test resolves to the default identity (200 = first candidate accepted)
// offline. Direct tests that must prove NO probe ran install a counting stub.
beforeEach(() => {
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
});

afterEach(() => {
  setIntegrationProbeFetch(null);
  restoreEnv();
  resetExitCode();
  for (const dir of dirs) removeDir(dir);
  dirs = [];
});

function isolate(): AgentHomes {
  const homes = isolateAgentHomes("copilot-transfer-");
  dirs.push(homes.dir);
  return homes;
}

/** Capture process.stderr.write output (the command's narration logger) while
 *  awaiting `fn`. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

/** Seed a representative setup: prefs (including a registry key newer than the
 *  bundle feature itself, proving the schema reuse tracks the registry), a
 *  default credential, a proxy profile, both agents wired proxy, plus the
 *  machine-local state fields and an ownership-ledger record. */
async function seedStores(): Promise<void> {
  new CopilotEnvConfig().set({ autoStart: true, port: 5050, claudeTokenMultiplier: 2.5 });
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_default");
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
  state.set({ codexCatalogLastAttemptMs: 123, codexCatalogCodexVersion: "9.9.9" });
  new OwnershipLedger().record("webSearchDeny", "/some/other/machine/settings.json");
  await runCodex({ kind: "configure", mode: "proxy" }, NOOP_CATALOG_DEPS);
  await runClaude({ kind: "configure", mode: "proxy" });
}

/** A minimal VALID raw bundle; tests override sections to probe the parser. */
function rawBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    config: {},
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

  const redacted = buildExportBundle();
  expect(redacted.credential.githubToken).toBe(REDACTED_TOKEN);
  expect(redacted.profiles.work?.githubToken).toBe(REDACTED_TOKEN);
  expect(JSON.stringify(redacted)).not.toContain("ghp_");

  const full = buildExportBundle({ withCredentials: true });
  expect(full.credential.githubToken).toBe("ghp_default");
  expect(full.profiles.work?.githubToken).toBe("ghp_work");
});

test("export carries the stores + modes and never the machine-local state keys", async () => {
  isolate();
  await seedStores();

  const bundle = buildExportBundle({ withCredentials: true });
  expect(bundle.formatVersion).toBe(1);
  expect(bundle.config).toEqual({ autoStart: true, port: 5050, claudeTokenMultiplier: 2.5 });
  expect(bundle.modes).toEqual({ codex: "proxy", claude: "proxy" });
  expect(bundle.profiles.work?.mode).toBe("proxy");
  // The reserved default slot travels as the `credential` section, never as a
  // profiles entry (the bundle format is an external contract).
  expect(bundle.profiles.default).toBeUndefined();
  const text = JSON.stringify(bundle);
  expect(text).not.toContain("codexCatalog");
  expect(text).not.toContain("webSearchDeny");
});

test("export reads the default credential from an unmigrated (top-level pair) store", () => {
  isolate();
  // A store a pre-slot release wrote and no new write/migration has touched yet.
  const stateFile = new CopilotApiPaths().sharedStateFile;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    `${JSON.stringify({ githubToken: "ghp_legacy", authProvider: "gh-token" })}\n`,
  );
  const bundle = buildExportBundle({ withCredentials: true });
  expect(bundle.credential).toEqual({ githubToken: "ghp_legacy", authProvider: "gh-token" });
});

// --- validation (strict parse boundary) ---------------------------------------

test("parseSettingsBundle rejects non-objects, unknown formatVersion, and missing sections", () => {
  expect(() => parseSettingsBundle("nope")).toThrow(/JSON object/);
  expect(() => parseSettingsBundle({})).toThrow(/formatVersion/);
  // The version value is not echoed (a mangled bundle can hold anything there).
  expect(() => parseSettingsBundle({ formatVersion: 2 })).toThrow(
    /unsupported settings bundle formatVersion - /,
  );
  // Right version, missing sections: rejected, never imported as empty stores.
  expect(() => parseSettingsBundle({ formatVersion: 1 })).toThrow(/invalid settings bundle/);
  expect(() => parseSettingsBundle(rawBundle({ extra: 1 }))).toThrow(
    /unknown key under the bundle root/,
  );
});

test("junk config keys and malformed values are rejections, never dropped or coerced", () => {
  // Unknown-key rejections name the PARENT only: the key text itself is
  // untrusted (a token can land as a key in a mangled bundle).
  let message = "";
  try {
    parseSettingsBundle(rawBundle({ config: { "ghp_leaked_as_key": true } }));
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("unknown key under config");
  expect(message).not.toContain("ghp_leaked_as_key");
  // The store's lenient read schema would coerce these to "unset"; the bundle
  // parser must reject them instead (full-replace would silently reset a local
  // pref), naming the key but never echoing the received value.
  for (const bad of [{ claudeTokenMultiplier: "2" }, { autoStart: "yes" }, { port: 0 }]) {
    message = "";
    try {
      parseSettingsBundle(rawBundle({ config: bad }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`config.${Object.keys(bad)[0]} is invalid`);
    expect(message).not.toContain("yes");
    expect(message).not.toContain('"2"');
  }
  // The integration-id pin WINS over probed identities and lands in HTTP
  // headers, so a header-splitting value is rejected by the shared shape
  // (INTEGRATION_ID_RE in env_config.ts) -- and never echoed.
  message = "";
  try {
    parseSettingsBundle(rawBundle({ config: { integrationId: "evil\r\nX-Injected: 1" } }));
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("config.integrationId is invalid");
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

  expect(() => parseSettingsBundle(rawBundle({ modes: { codex: "bogus", claude: "direct" } })))
    .toThrow(/modes.codex/);
  expect(() => parseSettingsBundle(rawBundle({ profiles: { "NOT A NAME": {} } }))).toThrow(
    /invalid profile name/,
  );
  expect(() => parseSettingsBundle(rawBundle({ profiles: { work: { nope: 1 } } }))).toThrow(
    /unknown key under profiles.work/,
  );

  // The identity is interpolated into an HTTP header: header-splitting shapes
  // are rejected, and (no-echo rule) the value never appears in the error.
  message = "";
  try {
    parseSettingsBundle(
      rawBundle({
        profiles: { work: { integrationIdentity: "evil\r\nX-Injected: ghp_secret_leak" } },
      }),
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("profiles.work.integrationIdentity");
  expect(message).toContain("header-safe");
  expect(message).not.toContain("ghp_secret_leak");
  expect(message).not.toContain("evil");
});

// --- import -------------------------------------------------------------------

test("round trip: export -> wipe -> import restores stores and re-derives wiring", async () => {
  isolate();
  await seedStores();
  const bundle = buildExportBundle({ withCredentials: true });

  // A brand-new "machine": fresh temp homes, empty stores.
  const machine2 = isolate();

  const outcome = await applyImportBundle(bundle, { catalogDeps: NOOP_CATALOG_DEPS });
  expect(outcome.skipped).toEqual([]);
  expect(outcome.failures).toEqual([]);
  expect(outcome.modes).toEqual({ codex: "proxy", claude: "proxy" });
  expect(outcome.wiredProfiles).toEqual([WORK]);

  expect(new CopilotEnvConfig().read().autoStart).toBe(true);
  expect(new CopilotEnvConfig().read().port).toBe(5050);
  expect(new CopilotEnvConfig().read().claudeTokenMultiplier).toBe(2.5);
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
  // The wiring artifacts exist on the new machine (default + profile, both agents).
  expect(existsSync(settingsPathFor(machine2.claudeHome))).toBe(true);
  expect(existsSync(settingsPathFor(machine2.claudeHome, WORK))).toBe(true);
  expect(readFileSync(join(machine2.codexHome, "config.toml"), "utf8")).toContain(
    "copilot-env-work",
  );
});

test("a redacted bundle on a fresh machine imports prefs + proxy wiring, but no slot", async () => {
  isolate();
  await seedStores();
  const bundle = buildExportBundle(); // redacted; modes are proxy/proxy

  const machine2 = isolate();
  const outcome = await applyImportBundle(bundle, { catalogDeps: NOOP_CATALOG_DEPS });

  const skipped = outcome.skipped.join("\n");
  expect(skipped).toContain("run `agent auth`");
  expect(skipped).toContain("agent profile --add work");
  expect(outcome.wiredProfiles).toEqual([]);
  // Proxy default wiring is credential-independent (like `agent init --proxy`),
  // so it re-derived even though no credential resolved.
  expect(outcome.modes).toEqual({ codex: "proxy", claude: "proxy" });
  expect(existsSync(settingsPathFor(machine2.claudeHome))).toBe(true);
  // The profile slot stayed untouched: no artifacts, no placeholder token,
  // no mode-only slot.
  expect(existsSync(settingsPathFor(machine2.claudeHome, WORK))).toBe(false);
  expect(new CopilotEnvConfig().read().autoStart).toBe(true);
  const state = new CopilotEnvState().read();
  expect(state.githubToken).toBeNull();
  expect(state.authProvider).toBeNull();
  expect(state.profiles).toEqual({});
  expect(JSON.stringify(state)).not.toContain(REDACTED_TOKEN);
});

test("a redacted bundle over resolvable LOCAL credentials wires normally (resulting-slot rule)", async () => {
  isolate();
  await seedStores();
  const bundle = buildExportBundle(); // redacted
  // An identity travelling with a KEPT (redacted) slot belongs to the bundle's
  // credential, not the local one that will actually be used -- it must be
  // dropped, not baked.
  const workSlot = bundle.profiles.work;
  if (workSlot === undefined) throw new Error("seed produced no work profile");
  workSlot.integrationIdentity = "evil-injected";

  // The target machine has its own working credentials for both slots.
  isolate();
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_local_default");
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_local_work" },
    mode: "direct",
  });

  const outcome = await applyImportBundle(bundle, { catalogDeps: NOOP_CATALOG_DEPS });

  expect(outcome.skipped).toEqual([]);
  expect(outcome.modes).toEqual({ codex: "proxy", claude: "proxy" });
  expect(outcome.wiredProfiles).toEqual([WORK]);
  // The local tokens survived; the placeholder never landed anywhere.
  expect(new Credential().resolve()).toBe("ghp_local_default");
  expect(new Credential(undefined, WORK).resolve()).toBe("ghp_local_work");
  const slot = new CopilotEnvState().readProfileSlot(WORK);
  expect(slot.mode).toBe("proxy");
  expect(slot.integrationIdentity).toBeNull();
  expect(JSON.stringify(new CopilotEnvState().read())).not.toContain(REDACTED_TOKEN);
});

test("an unresolvable slot leaves the existing store byte-identical", async () => {
  isolate();
  new Credential().store("gh-token", "ghp_local_default");
  const stateFile = new CopilotApiPaths().sharedStateFile;
  const before = readFileSync(stateFile, "utf8");

  const bundle = parseSettingsBundle(
    rawBundle({
      // Default slot: empty in the bundle -> the local one is KEPT, not cleared.
      profiles: {
        work: { githubToken: REDACTED_TOKEN, authProvider: "gh-token", mode: "proxy" },
      },
    }),
  );
  const outcome = await applyImportBundle(bundle, { catalogDeps: NOOP_CATALOG_DEPS });

  expect(outcome.skipped.join("\n")).toContain("agent profile --add work");
  expect(readFileSync(stateFile, "utf8")).toBe(before);
});

test("the credential gate is direct-only: proxy wires without one (like `agent init --proxy`)", async () => {
  const machine = isolate();
  const bundle = parseSettingsBundle(
    rawBundle({
      credential: { githubToken: REDACTED_TOKEN, authProvider: "gh-token" },
      modes: { codex: "direct", claude: "proxy" },
    }),
  );

  const outcome = await applyImportBundle(bundle, { catalogDeps: NOOP_CATALOG_DEPS });

  const skipped = outcome.skipped.join("\n");
  expect(skipped).toContain("agent init --direct");
  expect(skipped).not.toContain("agent init --proxy");
  // Claude (proxy) was written despite the unresolvable credential; Codex
  // (direct) was left untouched.
  expect(outcome.modes?.claude).toBe("proxy");
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(true);
  expect(existsSync(join(machine.codexHome, "config.toml"))).toBe(false);
});

test("gh-cli slots probe gh ONCE end to end, and gh-cli wiring re-derives the identity", async () => {
  const machine = isolate();
  const bundle = parseSettingsBundle(
    rawBundle({
      credential: { githubToken: null, authProvider: "gh-cli" },
      modes: { codex: "none", claude: "direct" },
      profiles: {
        // The bundled identity belongs to the SOURCE machine's gh login; the
        // target must re-derive its own at wire time, so it is dropped.
        work: {
          githubToken: null,
          authProvider: "gh-cli",
          mode: "direct",
          integrationIdentity: "copilot-developer-cli",
        },
        alt: { githubToken: null, authProvider: "gh-cli", mode: null },
      },
    }),
  );

  // gh does not resolve: nothing written anywhere, skip messages say how to fix.
  let probeCount = 0;
  const noGh = await applyImportBundle(bundle, {
    catalogDeps: NOOP_CATALOG_DEPS,
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

  // gh resolves: the provider is recorded (no token -- gh-cli holds none) and
  // REAL direct wiring runs for the default AND the profile -- still exactly
  // one gh probe (the wiring consumes the plan's resolved token) and no
  // subprocess (the identity probe is the stubbed fetch).
  probeCount = 0;
  const withGh = await applyImportBundle(bundle, {
    catalogDeps: NOOP_CATALOG_DEPS,
    ghAuthToken: () => {
      probeCount++;
      return "gho_live";
    },
  });
  // The mode-less alt slot can only re-auth an existing profile; none exists
  // here, so it is skipped whole instead of landing as a half profile.
  expect(withGh.skipped.join("\n")).toContain("profile 'alt'");
  expect(withGh.skipped.join("\n")).toContain("agent profile --add alt");
  expect(withGh.modes?.claude).toBe("direct");
  expect(withGh.wiredProfiles).toEqual([WORK]);
  expect(probeCount).toBe(1);
  const state = new CopilotEnvState().read();
  expect(state.authProvider).toBe("gh-cli");
  expect(state.githubToken).toBeNull();
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(true);
  expect(existsSync(settingsPathFor(machine.claudeHome, WORK))).toBe(true);
  // The bundled identity was dropped; the wire-time probe re-derived the
  // default identity ("codex" = probed, the default won).
  expect(new CopilotEnvState().readProfileSlot(WORK).credential).toEqual({ kind: "gh-cli" });
  expect(new CopilotEnvState().readProfileSlot(WORK).integrationIdentity).toBe("codex");
  expect(new CopilotEnvState().profileNames()).toEqual([WORK]); // alt never landed
});

test("a gh-cli default over a working local token falls through to the kept slot", async () => {
  const machine = isolate();
  new Credential().store("gh-token", "github_pat_local");
  const bundle = parseSettingsBundle(
    rawBundle({
      credential: { githubToken: null, authProvider: "gh-cli" },
      modes: { codex: "none", claude: "direct" },
    }),
  );

  const outcome = await applyImportBundle(bundle, {
    catalogDeps: NOOP_CATALOG_DEPS,
    ghAuthToken: () => null,
  });

  // gh failing only rules out the BUNDLE's credential: the local slot resolves,
  // so wiring proceeds and the local credential survives untouched.
  expect(outcome.skipped).toEqual([]);
  expect(outcome.modes?.claude).toBe("direct");
  expect(existsSync(settingsPathFor(machine.claudeHome))).toBe(true);
  expect(new CopilotEnvState().read().authProvider).toBe("gh-token");
  expect(new Credential().resolve()).toBe("github_pat_local");
});

test("a direct profile with a persisted identity wires offline (no re-probe)", async () => {
  const machine = isolate();
  let probes = 0;
  setIntegrationProbeFetch(() => {
    probes++;
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });
  const bundle = parseSettingsBundle(
    rawBundle({
      profiles: {
        work: {
          githubToken: "github_pat_work",
          authProvider: "gh-token",
          mode: "direct",
          integrationIdentity: "copilot-developer-cli",
        },
      },
    }),
  );

  const outcome = await applyImportBundle(bundle, { catalogDeps: NOOP_CATALOG_DEPS });

  expect(outcome.wiredProfiles).toEqual([WORK]);
  expect(probes).toBe(0);
  const settings = JSON.parse(readFileSync(settingsPathFor(machine.claudeHome, WORK), "utf8"));
  expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toContain(
    "Copilot-Integration-Id: copilot-developer-cli",
  );
  expect(new CopilotEnvState().readProfileSlot(WORK).integrationIdentity).toBe(
    "copilot-developer-cli",
  );
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

  const err = await captureStderr(() =>
    runSettings({ importFrom: file, force: true }, { catalogDeps: NOOP_CATALOG_DEPS })
  );

  expect(process.exitCode).toBe(1);
  // The summary covers BOTH failure kinds outcome.failures carries (a profile
  // whose commit failed and a wiring failure), not just "wiring".
  expect(err).toContain("but some profiles or wiring could not be applied (see above).");
  // The slot committed atomically (credential + mode) BEFORE the wiring, so the
  // failure leaves a COMPLETE-but-unwired slot -- never a half profile -- and
  // `agent profile --sync` re-derives the artifacts from it.
  expect(new CopilotEnvState().readProfileSlot(WORK)).toEqual({
    kind: "complete",
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
    integrationIdentity: null,
  });
});

test("a throwing profile COMMIT is contained per-slot: the rest of the import proceeds", async () => {
  isolate();
  const bundle = parseSettingsBundle(
    rawBundle({
      profiles: {
        bad: { githubToken: "ghp_bad", authProvider: "gh-token", mode: "proxy" },
        work: { githubToken: "ghp_work", authProvider: "gh-token", mode: "proxy" },
      },
    }),
  );
  const plan = planImport(bundle, { catalogDeps: NOOP_CATALOG_DEPS });
  // Make the FIRST slot's commit itself throw: a whitespace token travels fine
  // in the plan's types but rawCredentialPatch (inside commitProfile) rejects
  // it. The commit sits INSIDE the per-profile containment -- a slot whose
  // commit throws is skipped whole ("ask, never break", same posture as a
  // credential that fails to resolve) and never blocks the profiles after it.
  const bad = plan.profiles.find((p) => p.name === parseProfileName("bad"));
  if (
    bad === undefined || bad.landing.action !== "write" || bad.landing.credential.kind !== "stored"
  ) {
    throw new Error("plan did not stage the bad profile as a token write");
  }
  bad.landing.credential.token = "   ";

  const outcome = await applyImportPlan(plan, { catalogDeps: NOOP_CATALOG_DEPS });

  expect(outcome.failures.length).toBe(1);
  expect(outcome.failures[0]).toContain("profile 'bad'");
  expect(outcome.wiredProfiles).toEqual([WORK]);
  // The throwing slot landed NOWHERE: no half profile in the store.
  expect(new CopilotEnvState().profileNames()).toEqual([WORK]);
});

test("a default-wiring failure surfaces into outcome.failures", async () => {
  const machine = isolate();
  // CLAUDE_CONFIG_DIR pointing at a FILE makes the Claude writer throw.
  writeFileSync(join(machine.dir, "not-a-dir"), "");
  process.env.CLAUDE_CONFIG_DIR = join(machine.dir, "not-a-dir");
  const bundle = parseSettingsBundle(
    rawBundle({
      credential: { githubToken: "ghp_default", authProvider: "gh-token" },
      modes: { codex: "none", claude: "proxy" },
    }),
  );

  const outcome = await applyImportBundle(bundle, { catalogDeps: NOOP_CATALOG_DEPS });

  expect(outcome.failures.length).toBe(1);
  expect(outcome.failures[0]).toContain("Claude:");
});

// --- the command layer ----------------------------------------------------------

test("settings requires exactly one of --export/--import and gates the modifier flags", async () => {
  expect(runSettings({})).rejects.toThrow(/exactly one/);
  expect(runSettings({ exportTo: true, importFrom: "x" })).rejects.toThrow(/exactly one/);
  expect(runSettings({ importFrom: "x", withCredentials: true })).rejects.toThrow(
    /--with-credentials only applies/,
  );
  expect(runSettings({ exportTo: true, force: true })).rejects.toThrow(/only apply to --import/);
  expect(runSettings({ exportTo: true, noBackup: true })).rejects.toThrow(/only apply to --import/);
});

test("parseSettingsAction: each arm carries only its own knobs", () => {
  expect(parseSettingsAction({ exportTo: true })).toEqual({
    kind: "export",
    target: true,
    withCredentials: false,
  });
  expect(parseSettingsAction({ exportTo: "out.json", withCredentials: true })).toEqual({
    kind: "export",
    target: "out.json",
    withCredentials: true,
  });
  expect(parseSettingsAction({ importFrom: "in.json", force: true })).toEqual({
    kind: "import",
    file: "in.json",
    force: true,
    noBackup: false,
  });
  expect(parseSettingsAction({ importFrom: "in.json", noBackup: true })).toEqual({
    kind: "import",
    file: "in.json",
    force: false,
    noBackup: true,
  });
});

test("bare --export writes the redacted bundle to stdout", async () => {
  isolate();
  await seedStores();
  let out = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out += String(chunk);
    return true;
  };
  try {
    await runSettings({ exportTo: true });
  } finally {
    process.stdout.write = original;
  }
  const doc = JSON.parse(out) as { formatVersion: number; credential: Record<string, unknown> };
  expect(doc.formatVersion).toBe(1);
  expect(doc.credential.githubToken).toBe(REDACTED_TOKEN);
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
  expect(runSettings({ importFrom: join(machine.dir, "missing.json") })).rejects.toThrow(
    /could not read/,
  );
  const notJson = join(machine.dir, "not.json");
  writeFileSync(notJson, "{nope");
  expect(runSettings({ importFrom: notJson })).rejects.toThrow(/not valid JSON/);
  const wrongVersion = join(machine.dir, "v99.json");
  writeFileSync(wrongVersion, JSON.stringify({ formatVersion: 99 }));
  expect(runSettings({ importFrom: wrongVersion })).rejects.toThrow(/formatVersion/);
});

test("import confirms only for actual overwrites: stores with content, or wiring writes", async () => {
  const machine1 = isolate();
  await seedStores();
  const file = join(machine1.dir, "bundle.json");
  await runSettings({ exportTo: file, withCredentials: true });

  // Non-empty stores, non-TTY (deno test): the guard fires before the prompt.
  expect(runSettings({ importFrom: file })).rejects.toThrow(/--force/);

  // Fresh machine, EMPTY stores -- but the bundle rewrites both agents'
  // configs, so wiring alone still demands the confirmation.
  isolate();
  expect(runSettings({ importFrom: file })).rejects.toThrow(/--force/);

  // A fresh-empty target importing ONLY store content (no wiring change)
  // overwrites nothing, so no prompt -- and no backup (nothing to roll back).
  const machine3 = isolate();
  const storesOnly = join(machine3.dir, "stores-only.json");
  writeFileSync(
    storesOnly,
    JSON.stringify(
      rawBundle({
        config: { autoStart: true },
        credential: { githubToken: "ghp_new", authProvider: "gh-token" },
      }),
    ),
  );
  await runSettings({ importFrom: storesOnly }, { catalogDeps: NOOP_CATALOG_DEPS });
  expect(new Credential().resolve()).toBe("ghp_new");
  expect(new CopilotEnvConfig().read().autoStart).toBe(true);
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
  await runSettings({ importFrom: skippedOnly }, { catalogDeps: NOOP_CATALOG_DEPS });
  expect(new CopilotEnvState().read().profiles).toEqual({});
});

test("the MCP registration write line reflects the POST-import wire-mcp value", () => {
  isolate();
  new Credential().store("gh-token", "ghp_default");
  const directBundle = (config: Record<string, unknown>): Record<string, unknown> =>
    rawBundle({
      config,
      credential: { githubToken: "ghp_default", authProvider: "gh-token" },
      modes: { codex: "none", claude: "direct" },
    });

  // Local false, bundle silent (-> built-in default true): the apply replaces
  // the store before the Claude writer reads the flag, so the write HAPPENS
  // and must be listed.
  new CopilotEnvConfig().set({ wireMcp: false });
  const listed = planImport(parseSettingsBundle(directBundle({})));
  expect(listed.writes.join("\n")).toContain("MCP registration");

  // Local true, bundle false: the write will NOT happen, so no line.
  new CopilotEnvConfig().set({ wireMcp: true });
  const unlisted = planImport(parseSettingsBundle(directBundle({ wireMcp: false })));
  expect(unlisted.writes.join("\n")).not.toContain("MCP registration");
});

test.skipIf(process.platform === "win32")(
  "import names the post-import Codex home and the farm action the bundle's codex-host implies",
  () => {
    const homes = isolate();
    new Credential().store("gh-token", "ghp_default");
    const proxyBundle = (config: Record<string, unknown>): Record<string, unknown> =>
      rawBundle({
        config,
        credential: { githubToken: "ghp_default", authProvider: "gh-token" },
        modes: { codex: "proxy", claude: "none" },
      });
    const writesOf = (config: Record<string, unknown>): string =>
      planImport(parseSettingsBundle(proxyBundle(config)), { catalogDeps: NOOP_CATALOG_DEPS })
        .writes.join("\n");
    const hostHome = getHostLocalCodexHome();
    const farmConfig = join(hostHome, "config.toml");

    // The bundle turns the farm on where none exists: the apply builds it and the
    // config lands there, not at the current effective home.
    const on = writesOf({ codexHost: true });
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
    for (const config of [{ codexHost: false }, {}]) {
      const off = writesOf(config);
      expect(off).toContain(`Per-host CODEX_HOME farm (removed): ${hostHome}`);
      expect(off).toContain(`Codex config: ${join(homes.codexHome, "config.toml")}`);
      expect(off).not.toContain(farmConfig);
    }

    // Profile-only wiring resolves the home under the BUNDLE's value, not the current
    // store: locally off (record retired), bundle on -> the record is live again.
    new CopilotEnvConfig().set({ codexHost: false });
    const profileOnly = (config: Record<string, unknown>): string =>
      planImport(
        parseSettingsBundle(rawBundle({
          config,
          credential: { githubToken: "ghp_default", authProvider: "gh-token" },
          profiles: { work: { githubToken: "ghp_work", authProvider: "gh-token", mode: "proxy" } },
        })),
        { catalogDeps: NOOP_CATALOG_DEPS },
      ).writes.join("\n");
    expect(profileOnly({ codexHost: true })).toContain(
      `Codex config: ${farmConfig} (may also clean its .env)`,
    );
    expect(profileOnly({})).toContain(
      `Codex config: ${join(homes.codexHome, "config.toml")} (may also clean its .env)`,
    );
  },
);

test("import surfaces the proxy restart hint when a projected key is set OR reset", () => {
  isolate();
  // small-model projects into the proxy's config.json at `agent start`, which a
  // running daemon will not re-read -- the import must say so.
  const hints = importRestartHints({ smallModel: "gpt-5-mini" }, {});
  expect(hints[0]).toContain("next proxy start");
  // Prefs are full-replace: a bundle that DROPS a stored projected key resets
  // it to default, which the daemon equally misses until a restart.
  const resetHints = importRestartHints({ autoStart: true }, { smallModel: "gpt-5-codex" });
  expect(resetHints[0]).toContain("next proxy start");
  // A prefs-only bundle with no projected keys on either side stays silent.
  expect(importRestartHints({ autoStart: true }, { idleTimeout: 60 })).toEqual([]);
});

// --- pre-import backups -----------------------------------------------------------

test("import backs up the previous settings with credentials intact, and the backup rolls back", async () => {
  const machine = isolate();
  await seedStores();
  const exported = join(machine.dir, "bundle.json");
  await runSettings({ exportTo: exported, withCredentials: true });

  // Diverge the machine from the exported state, so the import overwrites it.
  new CopilotEnvConfig().set({ autoStart: false, port: 6060 });
  new Credential().store("gh-token", "ghp_before_import");

  await runSettings({ importFrom: exported, force: true }, { catalogDeps: NOOP_CATALOG_DEPS });
  expect(new CopilotEnvConfig().read().port).toBe(5050);
  expect(new Credential().resolve()).toBe("ghp_default");

  // The backup captured the PRE-import state, tokens included, dir 700 / file 600.
  const backups = readdirSync(settingsBackupDir());
  expect(backups.length).toBe(1);
  const backupFile = join(settingsBackupDir(), backups[0] ?? "");
  const backupDoc = JSON.parse(readFileSync(backupFile, "utf8"));
  expect(backupDoc.credential.githubToken).toBe("ghp_before_import");
  expect(backupDoc.config).toEqual({ autoStart: false, port: 6060, claudeTokenMultiplier: 2.5 });
  if (!WIN) {
    expect(statSync(settingsBackupDir()).mode & 0o777).toBe(0o700);
    expect(statSync(backupFile).mode & 0o777).toBe(0o600);
  }

  // Rolling back IS an import of the backup file.
  await runSettings(
    { importFrom: backupFile, force: true, noBackup: true },
    { catalogDeps: NOOP_CATALOG_DEPS },
  );
  expect(new CopilotEnvConfig().read().port).toBe(6060);
  expect(new CopilotEnvConfig().read().autoStart).toBe(false);
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

test("--no-backup skips the backup entirely", async () => {
  const machine = isolate();
  await seedStores();
  const exported = join(machine.dir, "bundle.json");
  await runSettings({ exportTo: exported, withCredentials: true });

  await runSettings(
    { importFrom: exported, force: true, noBackup: true },
    { catalogDeps: NOOP_CATALOG_DEPS },
  );
  expect(existsSync(settingsBackupDir())).toBe(false);
});

test("the backup pile is pruned to the newest 5", async () => {
  const machine = isolate();
  await seedStores();
  const exported = join(machine.dir, "bundle.json");
  await runSettings({ exportTo: exported, withCredentials: true });

  let firstBackup = "";
  for (let i = 0; i < SETTINGS_BACKUP_KEEP + 1; i++) {
    await runSettings({ importFrom: exported, force: true }, { catalogDeps: NOOP_CATALOG_DEPS });
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
  const bundle = parseSettingsBundle(rawBundle({ config: { claudeDesktop: false } }));
  await applyImportBundle(bundle, { catalogDeps: NOOP_CATALOG_DEPS });
  expect(new CopilotEnvConfig().claudeDesktopEnabled()).toBe(false);
  expect(entryPath()).toBeNull();
  expect(existsSync(wired ?? "")).toBe(false);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
});
