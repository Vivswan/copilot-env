// Claude Desktop config-library wiring (src/claude/desktop.ts): the managed entries,
// the never-clobber posture toward the app's own files, and the ownership record.
// Isolation: the suite floor points CLAUDE_DESKTOP_DIR_ENV at a NON-created dir, so
// nothing here can reach a real library; each test that wants Desktop "installed"
// creates its own data dir and re-points the seam at it.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  CLAUDE_DESKTOP_DIR_ENV,
  claudeDesktopInstalled,
  DESKTOP_DISPLAY_NAME,
  desktopAppInstalledFor,
  desktopConfigPayload,
  desktopDataDirFor,
  desktopEntryName,
  desktopHelperPath,
  desktopLibraryDirUnder,
  desktopModelLabel,
  desktopModelsFromPicks,
  type DesktopTarget,
  type DesktopWireOptions,
  inspectClaudeDesktopWiring,
  listClaudeDesktopOwnedArtifacts,
  parseDesktopMeta,
  removeAllClaudeDesktopWiring,
  removeClaudeDesktopEntry,
  removeUnmanagedClaudeDesktopWiring,
  renderClaudeDesktopStatus,
  resolveDesktopLibraryDir,
  retireDesktopHelperScript,
  syncClaudeDesktopWiring,
  wireClaudeDesktopEntry,
  writeDesktopHelperScript,
} from "../src/claude/desktop.ts";
import { resolveClaudeHome } from "../src/claude/paths.ts";
import {
  claudeDesktopStatus,
  reconcileClaudeDesktopWiring,
  resolveClaudeDesktopTargets,
} from "../src/agents/claude_desktop.ts";
import { printClaudeDesktopCheck } from "../src/commands/claude.ts";
import { runInit } from "../src/commands/init.ts";
import { runClaude } from "../src/claude/config.ts";
import { commandDeps } from "../src/commands/launch.ts";
import { runProfile } from "../src/commands/profile.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { setIntegrationProbeFetch } from "../src/copilot_api/integration_identity.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import type { Profile } from "../src/copilot_api/profile.ts";
import { DEFAULT_COPILOT_API_BASE } from "../src/copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { resolveRootHome } from "../src/copilot_api/paths.ts";
import { agentLauncherCommand } from "../src/utils/root.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { expect, test } from "./helpers/testing.ts";
import { afterEach } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, removeDir, resetExitCode } from "./helpers.ts";

const restoreEnv = envSnapshot();
const WORK = parseProfileName("work");
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
  dir = removeDir(dir);
});

/** chmod-based fault injection needs POSIX permissions that bind (not root). */
const NO_CHMOD_FAULTS = process.platform === "win32" || process.getuid?.() === 0;

/** Isolated homes + an EXISTING Desktop data dir the seam points at (opt-in). */
function isolateWithDesktop(): { library: string } {
  dir = isolateAgentHomes("copilot-desktop-").dir;
  const dataDir = join(dir, "claude-desktop");
  mkdirSync(dataDir, { recursive: true });
  process.env[CLAUDE_DESKTOP_DIR_ENV] = dataDir;
  return { library: desktopLibraryDirUnder(dataDir) };
}

/** A fetchImpl serving a fixed /models catalog body. */
function catalogFetch(ids: { id: string; window?: number; name?: string }[]): typeof fetch {
  const body = {
    data: ids.map((m) => ({
      id: m.id,
      name: m.name,
      capabilities: {
        limits: { max_context_window_tokens: m.window ?? 200_000, max_prompt_tokens: 100_000 },
      },
    })),
  };
  return () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

const CATALOG = [
  { id: "claude-fable-5", window: 1_000_000 },
  { id: "claude-opus-4-8" },
  { id: "claude-opus-5", window: 1_000_000, name: "Claude Opus 5 (Upstream)" },
  { id: "gpt-5.6-sol" },
];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function metaOf(library: string): Record<string, unknown> {
  return readJson(join(library, "_meta.json"));
}

// --- pure paths + detection ----------------------------------------------------

test("desktopDataDirFor: the per-platform Claude-3p locations, null where no app exists", () => {
  expect(desktopDataDirFor("darwin", "/Users/x", undefined)).toBe(
    join("/Users/x", "Library", "Application Support", "Claude-3p"),
  );
  expect(desktopDataDirFor("win32", "C:\\Users\\x", "C:\\Users\\x\\AppData\\Local")).toBe(
    join("C:\\Users\\x\\AppData\\Local", "Claude-3p"),
  );
  expect(desktopDataDirFor("win32", "C:\\Users\\x", undefined)).toBeNull();
  expect(desktopDataDirFor("linux", "/home/x", undefined)).toBeNull();
});

test("desktopAppInstalledFor: app locations OR an existing data dir; never on linux", () => {
  const dataDir = desktopDataDirFor("darwin", "/Users/x", undefined) as string;
  expect(
    desktopAppInstalledFor(
      "darwin",
      (p) => p === "/Applications/Claude.app",
      "/Users/x",
      undefined,
    ),
  ).toBe(true);
  expect(
    desktopAppInstalledFor(
      "darwin",
      (p) => p === join("/Users/x", "Applications", "Claude.app"),
      "/Users/x",
      undefined,
    ),
  ).toBe(true);
  expect(desktopAppInstalledFor("darwin", (p) => p === dataDir, "/Users/x", undefined)).toBe(true);
  expect(desktopAppInstalledFor("darwin", () => false, "/Users/x", undefined)).toBe(false);
  const lad = "C:\\Users\\x\\AppData\\Local";
  expect(
    desktopAppInstalledFor(
      "win32",
      (p) => p === join(lad, "AnthropicClaude", "claude.exe"),
      "C:\\Users\\x",
      lad,
    ),
  ).toBe(true);
  expect(desktopAppInstalledFor("linux", () => true, "/home/x", undefined)).toBe(false);
});

test("the desktop seam is absolute-or-throw and governs detection; the floor sets it", () => {
  // The floor self-check: constant pinned to its literal, seam live in this process.
  expect(CLAUDE_DESKTOP_DIR_ENV).toBe("COPILOT_ENV_CI_CLAUDE_DESKTOP_DIR");
  expect(Deno.env.get(CLAUDE_DESKTOP_DIR_ENV)).toBeDefined();
  // The floor's dir is never created => the whole suite sees "not installed".
  expect(claudeDesktopInstalled()).toBe(false);
  process.env[CLAUDE_DESKTOP_DIR_ENV] = "relative/dir";
  expect(() => resolveDesktopLibraryDir()).toThrow("must be an absolute path");
  expect(() => claudeDesktopInstalled()).toThrow("must be an absolute path");
});

test("desktopModelLabel: human labels from ids, dot and dash version forms alike", () => {
  expect(desktopModelLabel("claude-fable-5")).toBe("Claude Fable 5");
  expect(desktopModelLabel("claude-opus-4.8")).toBe("Claude Opus 4.8");
  expect(desktopModelLabel("claude-opus-4-8")).toBe("Claude Opus 4.8");
  expect(desktopModelLabel("claude-haiku-4.5")).toBe("Claude Haiku 4.5");
  // Qualifiers stay words, never folded into the version -- including dated
  // snapshots, which the model-id grammar's 2-digit minor cap keeps out.
  expect(desktopModelLabel("claude-fable-5-1m")).toBe("Claude Fable 5 1m");
  expect(desktopModelLabel("claude-fable-5-20251001")).toBe("Claude Fable 5 20251001");
});

test("desktopEntryName: default vs profile naming", () => {
  expect(desktopEntryName(null)).toBe("copilot-env");
  expect(desktopEntryName(WORK)).toBe("copilot-env: work");
});

// --- payload ---------------------------------------------------------------------

test("payload: direct shape (headers + models + no discovery), proxy shape (discovery + annotations)", () => {
  const models = desktopModelsFromPicks([
    { family: "fable", id: "claude-fable-5", is1m: true, familyDefault: true },
  ]);
  const direct = desktopConfigPayload({
    mode: "direct",
    profile: null,
    baseUrl: DEFAULT_COPILOT_API_BASE,
    helperPath: "/x/helper.sh",
    directIntegrationId: "copilot-developer-cli",
    models,
  });
  expect(direct["inferenceGatewayBaseUrl"]).toBe(DEFAULT_COPILOT_API_BASE);
  expect(direct["inferenceCredentialHelper"]).toBe("/x/helper.sh");
  expect(direct["inferenceCredentialHelperTimeoutSec"]).toBe(30);
  expect(direct["deploymentDisplayName"]).toBe(DESKTOP_DISPLAY_NAME);
  const headers = direct["inferenceCustomHeaders"] as Record<string, string>;
  expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
  expect(headers["Openai-Intent"]).toBe("conversation-edits");
  expect(direct["modelDiscoveryEnabled"]).toBeUndefined(); // Copilot Direct 404s /v1/models
  expect(direct["inferenceModels"]).toEqual([{
    "name": "claude-fable-5",
    "labelOverride": "Claude Fable 5",
    "supports1m": true,
    "prefer1m": true,
    "anthropicFamilyTier": "fable",
    "isFamilyDefault": true,
  }]);
  // All capability switches on, cost display on, all telemetry off (incl. essential).
  for (
    const key of [
      "chatTabEnabled",
      "coworkTabEnabled",
      "isClaudeCodeForDesktopEnabled",
      "isDesktopExtensionEnabled",
      "chatAdvancedFileAnalysisEnabled",
      "skillCreationEnabled",
      "autoModeEnabled",
      "userPluginMarketplacesEnabled",
      "userPluginUploadsEnabled",
      "inferenceModelPricingEnabled",
      "modelPrefer1mContext",
      "disableEssentialTelemetry",
      "disableNonessentialTelemetry",
      "disableNonessentialServices",
    ]
  ) {
    expect(direct[key]).toBe(true);
  }
  expect(isRecordLike(direct["managedMcpServers"])).toBe(true);
  // Import/export all on; a hand-set sibling field would survive the merge.
  expect(direct["claudeAiImport"]).toEqual({
    "enabled": true,
    "automatic3pImport": true,
    "exportEnabled": true,
  });

  const proxy = desktopConfigPayload({
    mode: "proxy",
    profile: null,
    baseUrl: "http://127.0.0.1:4141",
    helperPath: "/x/helper.sh",
    models,
    existing: direct, // mode switch: direct-only keys must be scrubbed
  });
  expect(proxy["modelDiscoveryEnabled"]).toBe(true);
  expect(proxy["inferenceCustomHeaders"]).toBeUndefined();
  expect(proxy["inferenceCredentialHelperTimeoutSec"]).toBe(120);
  // The 1m annotations stay even with discovery on (claude-code#88345: discovery
  // alone carries no capability metadata): the proxy payload keeps the direct
  // payload's rows byte-for-byte, annotations included.
  expect(proxy["inferenceModels"]).toEqual(direct["inferenceModels"]);
});

function isRecordLike(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

test("payload: foreign keys in the existing document survive the surgical merge", () => {
  const merged = desktopConfigPayload({
    mode: "direct",
    profile: null,
    baseUrl: DEFAULT_COPILOT_API_BASE,
    helperPath: "/x/h.sh",
    existing: {
      "banner": { "enabled": true, "text": "keep me" },
      "userKey": 42,
      // A hand-set import field survives; managed fields win on conflict.
      "claudeAiImport": { "bannerBehavior": "detect", "enabled": false },
    },
  });
  expect(merged["banner"]).toEqual({ "enabled": true, "text": "keep me" });
  expect(merged["userKey"]).toBe(42);
  expect(merged["claudeAiImport"]).toEqual({
    "bannerBehavior": "detect", // hand-set sibling field kept
    "enabled": true, // managed value wins over the stale hand-set one
    "automatic3pImport": true,
    "exportEnabled": true,
  });
});

test("payload: a rotation to a null integration id drops the stale header; foreign extras survive", () => {
  const withId = desktopConfigPayload({
    mode: "direct",
    profile: null,
    baseUrl: DEFAULT_COPILOT_API_BASE,
    helperPath: "/x/h.sh",
    directIntegrationId: "copilot-developer-cli",
    existing: { "inferenceCustomHeaders": { "X-Custom": "keep" } },
  });
  const before = withId["inferenceCustomHeaders"] as Record<string, string>;
  expect(before["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
  expect(before["X-Custom"]).toBe("keep");

  // PAT -> non-PAT rotation: directClientHeaders omits the id when it is null,
  // so the direct branch's own strip is what removes the stale header.
  const rotated = desktopConfigPayload({
    mode: "direct",
    profile: null,
    baseUrl: DEFAULT_COPILOT_API_BASE,
    helperPath: "/x/h.sh",
    directIntegrationId: null,
    existing: withId,
  });
  const headers = rotated["inferenceCustomHeaders"] as Record<string, string>;
  expect(headers["Copilot-Integration-Id"]).toBeUndefined();
  expect(headers["X-Custom"]).toBe("keep");
  expect(headers["Openai-Intent"]).toBe("conversation-edits");
});

// --- helper scripts ----------------------------------------------------------------

test("helper scripts: written 0755, regenerated when tampered, other mode removed", () => {
  isolateWithDesktop();
  const rootHome = resolveRootHome();
  const direct = writeDesktopHelperScript("direct", null);
  expect(direct).toBe(desktopHelperPath(rootHome, "direct", null));
  expect(readFileSync(direct, "utf8")).toContain("auth");
  if (process.platform !== "win32") {
    expect(statSync(direct).mode & 0o755).toBe(0o755);
  }
  // Tampering heals on the next wire.
  chmodSync(direct, 0o644);
  writeFileSync(direct, "#!/bin/sh\nexec echo tampered\n");
  const again = writeDesktopHelperScript("direct", null);
  expect(readFileSync(again, "utf8")).not.toContain("tampered");
  if (process.platform !== "win32") {
    // A byte-correct body with a chmod'd-away +x is healed too.
    chmodSync(again, 0o644);
    writeDesktopHelperScript("direct", null);
    expect(statSync(again).mode & 0o111).not.toBe(0);
  }
  // A mode switch retires the stale twin (post-save, via retireDesktopHelperScript).
  const proxy = writeDesktopHelperScript("proxy", null);
  expect(readFileSync(proxy, "utf8")).toContain("proxy-token");
  retireDesktopHelperScript("proxy", null);
  expect(existsSync(direct)).toBe(false);
});

// --- upsert ---------------------------------------------------------------------

test("fresh upsert: config + meta entry + appliedId only when the library had none", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry({
    profile: null,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  });
  const meta = metaOf(library);
  const entries = meta.entries as { id: string; name: string }[];
  expect(entries).toHaveLength(1);
  expect(entries[0]?.name).toBe("copilot-env");
  expect(meta.appliedId).toBe(entries[0]?.id); // empty library: ours becomes applied
  const configPath = join(library, `${entries[0]?.id}.json`);
  const doc = readJson(configPath);
  expect(doc["inferenceGatewayBaseUrl"]).toBe(DEFAULT_COPILOT_API_BASE);
  // Catalog-derived picks: newest per family, 1m-marked; gpt ignored.
  const models = doc["inferenceModels"] as {
    name: string;
    labelOverride: string;
    supports1m: boolean;
    isFamilyDefault: boolean;
  }[];
  expect(models.map((m) => m.name).sort()).toEqual([
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-5",
  ]);
  // Labels come from the upstream catalog name when present (the `agent models`
  // pipeline), synthesized from the id otherwise.
  expect(models.find((m) => m.name === "claude-opus-5")?.labelOverride).toBe(
    "Claude Opus 5 (Upstream)",
  );
  expect(models.find((m) => m.name === "claude-fable-5")?.labelOverride).toBe("Claude Fable 5");
  // Family defaults: the newest per family; opus-4-8 is not.
  expect(models.find((m) => m.name === "claude-opus-4-8")?.isFamilyDefault).toBe(false);
  expect(models.find((m) => m.name === "claude-opus-5")?.isFamilyDefault).toBe(true);
  // Ownership recorded AFTER save.
  expect(new OwnershipLedger().owns("claudeDesktop", configPath)).toBe(true);

  // Byte-idempotence: a second wire rewrites nothing.
  const configM = statSync(configPath).mtimeMs;
  const metaM = statSync(join(library, "_meta.json")).mtimeMs;
  await wireClaudeDesktopEntry({
    profile: null,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  });
  expect(statSync(configPath).mtimeMs).toBe(configM);
  expect(statSync(join(library, "_meta.json")).mtimeMs).toBe(metaM);
});

test("offline direct: a FRESH entry is never created; an owned entry keeps its rows", async () => {
  const { library } = isolateWithDesktop();
  mkdirSync(library, { recursive: true });
  writeFileSync(
    join(library, "user-1.json"),
    `${JSON.stringify({ "inferenceGatewayBaseUrl": "https://elsewhere.example" })}\n`,
  );
  writeFileSync(
    join(library, "_meta.json"),
    `${JSON.stringify({ appliedId: "user-1", entries: [{ id: "user-1", name: "Mine" }] })}\n`,
  );
  const offline = {
    profile: null,
    mode: "direct" as const,
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: () => Promise.reject(new Error("offline")),
  };
  // Fresh + no model data: a direct entry would have neither discovery nor a
  // picker -- nothing is created, the user's applied entry is never displaced.
  await wireClaudeDesktopEntry(offline);
  let meta = metaOf(library);
  expect(meta.appliedId).toBe("user-1");
  expect(meta.entries as unknown[]).toHaveLength(1);

  // An OWNED entry wired online first keeps its recorded rows through an
  // offline re-wire (no hardcoded fallback list exists to clobber them).
  await wireClaudeDesktopEntry({ ...offline, fetchImpl: catalogFetch(CATALOG) });
  meta = metaOf(library);
  const ours = (meta.entries as { id: string; name: string }[]).find(
    (e) => e.name === "copilot-env",
  );
  const wired = readJson(join(library, `${ours?.id}.json`))["inferenceModels"];
  expect(wired).toHaveLength(3); // catalog-derived, so the survival check below is non-vacuous

  await wireClaudeDesktopEntry(offline);
  // The WHOLE rows survive -- a clobber that keeps the names but blanks the
  // labels or flips the 1m flags must fail here, not just an emptied list.
  expect(readJson(join(library, `${ours?.id}.json`))["inferenceModels"]).toEqual(wired);
  // The foreign entry is untouched (different gateway: not adoptable).
  expect(readJson(join(library, "user-1.json"))).toEqual({
    "inferenceGatewayBaseUrl": "https://elsewhere.example",
  });
});

test("a quiet wire never discovers: fresh direct entries are skipped outright", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry({
    profile: null,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: true,
    fetchImpl: () => Promise.reject(new Error("quiet must not fetch")),
  });
  // No files at all: the quiet path may not pay discovery, and a fresh direct
  // entry without model data is unusable, so nothing was written.
  expect(existsSync(join(library, "_meta.json"))).toBe(false);
});

test("a blocked removal (malformed _meta.json) keeps the helper scripts", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry({
    profile: null,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  });
  const helper = desktopHelperPath(resolveRootHome(), "direct", null);
  expect(existsSync(helper)).toBe(true);
  writeFileSync(join(library, "_meta.json"), "{ mangled");
  removeAllClaudeDesktopWiring(library);
  // The surviving (unprocessable) entry may still reference the script.
  expect(existsSync(helper)).toBe(true);
});

test("adopt-and-replace: same-gateway foreign entry is taken over in place, name kept", async () => {
  const { library } = isolateWithDesktop();
  mkdirSync(library, { recursive: true });
  const handMadeHelper = join(resolveClaudeHome(), "copilot-token.sh");
  mkdirSync(resolveClaudeHome(), { recursive: true });
  writeFileSync(handMadeHelper, "#!/bin/sh\nexec agent auth --get\n");
  writeFileSync(
    join(library, "hand-1.json"),
    `${
      JSON.stringify({
        "inferenceGatewayBaseUrl": `${DEFAULT_COPILOT_API_BASE}/`, // trailing slash tolerated
        "inferenceCredentialHelper": handMadeHelper,
        "userKey": "keep",
      })
    }\n`,
  );
  writeFileSync(
    join(library, "_meta.json"),
    `${JSON.stringify({ appliedId: "hand-1", entries: [{ id: "hand-1", name: "Default" }] })}\n`,
  );
  await wireClaudeDesktopEntry({
    profile: null,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  });
  const meta = metaOf(library);
  const entries = meta.entries as { id: string; name: string }[];
  expect(entries).toEqual([{ id: "hand-1", name: "Default" }]); // same uuid, the user's name
  expect(meta.appliedId).toBe("hand-1"); // stays applied naturally
  const doc = readJson(join(library, "hand-1.json"));
  expect(doc["userKey"]).toBe("keep"); // surgical merge
  expect(doc["inferenceCredentialHelper"]).not.toBe(handMadeHelper); // managed helper now
  expect(existsSync(handMadeHelper)).toBe(false); // referenced hand-made helper retired
  expect(new OwnershipLedger().owns("claudeDesktop", join(library, "hand-1.json"))).toBe(true);
});

test("adoption keeps the hand-made helper while ANY other consumer references it", async () => {
  const scenarios: {
    name: string;
    settings?: boolean;
    otherEntryRaw?: (handMade: string) => string;
  }[] = [
    // Claude Code's own settings.json still points at it (the legacy file wiring).
    { name: "claude-code-settings", settings: true },
    // Another Desktop entry still points at it.
    {
      name: "another-desktop-entry",
      otherEntryRaw: (h) =>
        JSON.stringify({
          "inferenceGatewayBaseUrl": "https://elsewhere.example",
          "inferenceCredentialHelper": h,
        }),
    },
    // Parse doubt answers "keep": an unreadable sibling MIGHT reference it.
    { name: "malformed-sibling-entry", otherEntryRaw: () => "{ mangled" },
  ];
  for (const scenario of scenarios) {
    const { library } = isolateWithDesktop();
    mkdirSync(library, { recursive: true });
    mkdirSync(resolveClaudeHome(), { recursive: true });
    const handMade = join(resolveClaudeHome(), "copilot-token.sh");
    writeFileSync(handMade, "#!/bin/sh\nexec gh auth token\n");
    writeFileSync(
      join(library, "hand-1.json"),
      `${
        JSON.stringify({
          "inferenceGatewayBaseUrl": DEFAULT_COPILOT_API_BASE,
          "inferenceCredentialHelper": handMade,
        })
      }\n`,
    );
    const entries = [{ id: "hand-1", name: "Default" }];
    if (scenario.otherEntryRaw !== undefined) {
      writeFileSync(join(library, "other-2.json"), scenario.otherEntryRaw(handMade));
      entries.push({ id: "other-2", name: "Other" });
    }
    writeFileSync(
      join(library, "_meta.json"),
      `${JSON.stringify({ appliedId: "hand-1", entries })}\n`,
    );
    if (scenario.settings) {
      writeFileSync(
        join(resolveClaudeHome(), "settings.json"),
        JSON.stringify({ "apiKeyHelper": handMade }),
      );
    }
    await wireClaudeDesktopEntry({
      profile: null,
      mode: "direct",
      directIntegrationId: null,
      directToken: "ghu_x",
      quiet: false,
      fetchImpl: catalogFetch(CATALOG),
    });
    // The adoption itself proceeds; only the retirement is gated.
    const doc = readJson(join(library, "hand-1.json"));
    expect(doc["inferenceCredentialHelper"], scenario.name).not.toBe(handMade);
    expect(existsSync(handMade), scenario.name).toBe(true); // still referenced: kept
    dir = removeDir(dir);
  }
});

test("never-clobber: a foreign entry carrying our name, or a malformed _meta.json, stops the write", async () => {
  const { library } = isolateWithDesktop();
  mkdirSync(library, { recursive: true });
  writeFileSync(
    join(library, "f-1.json"),
    `${JSON.stringify({ "inferenceGatewayBaseUrl": "https://elsewhere.example" })}\n`,
  );
  writeFileSync(
    join(library, "_meta.json"),
    `${JSON.stringify({ appliedId: "f-1", entries: [{ id: "f-1", name: "copilot-env" }] })}\n`,
  );
  const opts = {
    profile: null,
    mode: "direct" as const,
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  };
  await wireClaudeDesktopEntry(opts);
  // Nothing written, nothing owned.
  expect(readJson(join(library, "f-1.json"))["inferenceGatewayBaseUrl"]).toBe(
    "https://elsewhere.example",
  );
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);

  writeFileSync(join(library, "_meta.json"), "{ not json");
  await wireClaudeDesktopEntry(opts);
  expect(readFileSync(join(library, "_meta.json"), "utf8")).toBe("{ not json");
});

// POSIX only: creating symlinks on Windows needs elevation/dev-mode.
test.skipIf(process.platform === "win32")(
  "a dangling _meta.json symlink is could-not-read, never an empty library to rebuild",
  async () => {
    const { library } = isolateWithDesktop();
    mkdirSync(library, { recursive: true });
    // A link whose target existed and was removed: the entry AT the path
    // remains (lstat), but readFileSync follows it and reads ENOENT.
    const target = join(library, "real-meta.json");
    writeFileSync(target, `${JSON.stringify({ appliedId: null, entries: [] })}\n`);
    symlinkSync(target, join(library, "_meta.json"));
    rmSync(target);
    await expect(
      wireClaudeDesktopEntry({
        profile: null,
        mode: "direct",
        directIntegrationId: null,
        directToken: "ghu_x",
        quiet: false,
        fetchImpl: catalogFetch(CATALOG),
      }),
    ).rejects.toThrow("could not read");
    // Never clobbered: the link survives as a link, nothing materialized at its
    // target, no entry config or ownership record was minted.
    expect(lstatSync(join(library, "_meta.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(library)).toEqual(["_meta.json"]);
    expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "an owned entry whose config is a dangling symlink is unreadable, not rebuilt from empty",
  async () => {
    const { library } = isolateWithDesktop();
    const opts = {
      profile: null,
      mode: "direct" as const,
      directIntegrationId: null,
      directToken: "ghu_x",
      quiet: false,
      fetchImpl: catalogFetch(CATALOG),
    };
    await wireClaudeDesktopEntry(opts);
    const entries = metaOf(library).entries as { id: string }[];
    const configPath = join(library, `${entries[0]?.id}.json`);
    const target = join(library, "moved-away.json");
    writeFileSync(target, "{}\n");
    rmSync(configPath);
    symlinkSync(target, configPath);
    rmSync(target);
    // Re-wire: the owned entry's config cannot be read -- refuse, never rebuild
    // the document from {} over the user's link.
    await expect(wireClaudeDesktopEntry(opts)).rejects.toThrow("could not read");
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    // The same failed look leaves the status unjudged: nothing is swept as an orphan.
    const status = inspectClaudeDesktopWiring([{ profile: null, mode: "direct" }]);
    expect(status.kind).toBe("unjudged");
    if (status.kind === "unjudged") expect(status.reason).toContain("could not read");
  },
);

test("parseDesktopMeta: empty/missing is an empty library; anything not understood is null", () => {
  expect(parseDesktopMeta(null)).toEqual({ appliedId: null, entries: [], extra: {} });
  // Present-but-blank is damage, not a fresh library: only a MISSING file is empty.
  expect(parseDesktopMeta("")).toBeNull();
  expect(parseDesktopMeta("{ nope")).toBeNull();
  expect(parseDesktopMeta(JSON.stringify({ entries: [{ id: 1 }] }))).toBeNull();
  // Fail-closed: non-string appliedId, non-array entries, and ids that are not
  // filename-safe (path traversal, a _meta collision) all reject the whole document.
  expect(parseDesktopMeta(JSON.stringify({ appliedId: 7, entries: [] }))).toBeNull();
  expect(parseDesktopMeta(JSON.stringify({ entries: {} }))).toBeNull();
  expect(parseDesktopMeta(JSON.stringify({ entries: [{ id: "../../victim", name: "N" }] })))
    .toBeNull();
  expect(parseDesktopMeta(JSON.stringify({ entries: [{ id: "_meta", name: "N" }] }))).toBeNull();
  // Windows reserved device names (with or without an extension) are rejected:
  // `CON.json` is a device path on Windows filesystems.
  expect(parseDesktopMeta(JSON.stringify({ entries: [{ id: "CON", name: "N" }] }))).toBeNull();
  expect(parseDesktopMeta(JSON.stringify({ entries: [{ id: "com1.cfg", name: "N" }] }))).toBeNull();
  expect(parseDesktopMeta(JSON.stringify({ appliedId: "../x", entries: [] }))).toBeNull();
  expect(
    parseDesktopMeta(
      JSON.stringify({ entries: [{ id: "dup", name: "A" }, { id: "dup", name: "B" }] }),
    ),
  ).toBeNull();
  // Case-insensitive: Windows and default macOS filesystems fold Foo.json/foo.json.
  expect(
    parseDesktopMeta(
      JSON.stringify({ entries: [{ id: "Dup", name: "A" }, { id: "dup", name: "B" }] }),
    ),
  ).toBeNull();
  expect(parseDesktopMeta(JSON.stringify({ appliedId: "x", entries: [{ id: "x", name: "N" }] })))
    .toEqual({ appliedId: "x", entries: [{ id: "x", name: "N", extra: {} }], extra: {} });
  // Fields beyond the understood ones ride through extra (and survive a save).
  expect(
    parseDesktopMeta(
      JSON.stringify({
        appliedId: "x",
        schemaHint: 3,
        entries: [{ id: "x", name: "N", pinned: true }],
      }),
    ),
  ).toEqual({
    appliedId: "x",
    entries: [{ id: "x", name: "N", extra: { pinned: true } }],
    extra: { schemaHint: 3 },
  });
});

// --- removal ----------------------------------------------------------------------

test("profile entries: named, removed owned-only, appliedId nulled when it was ours", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry({
    profile: WORK,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  });
  const before = metaOf(library);
  const entry = (before.entries as { id: string; name: string }[])[0];
  expect(entry?.name).toBe("copilot-env: work");
  expect(before.appliedId).toBe(entry?.id);
  // A foreign twin with the same name must survive removal (owned-only).
  writeFileSync(
    join(library, "twin.json"),
    `${JSON.stringify({ "inferenceGatewayBaseUrl": "https://elsewhere.example" })}\n`,
  );
  const meta = metaOf(library);
  (meta.entries as unknown[]).push({ id: "twin", name: "copilot-env: work" });
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify(meta)}\n`);

  removeClaudeDesktopEntry(WORK);
  const after = metaOf(library);
  expect(after.entries).toEqual([{ id: "twin", name: "copilot-env: work" }]);
  expect(after.appliedId).toBeUndefined(); // ours was applied; reference dropped
  expect(existsSync(join(library, `${entry?.id}.json`))).toBe(false);
  expect(existsSync(join(library, "twin.json"))).toBe(true);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
  expect(existsSync(desktopHelperPath(resolveRootHome(), "direct", WORK))).toBe(false);
});

test("removeAllClaudeDesktopWiring sweeps every owned entry via an injected dir", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry({
    profile: null,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  });
  writeFileSync(join(library, "user-9.json"), `${JSON.stringify({ "userKey": 1 })}\n`);
  const meta = metaOf(library);
  (meta.entries as unknown[]).push({ id: "user-9", name: "Mine" });
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify(meta)}\n`);

  removeAllClaudeDesktopWiring(library);
  const after = metaOf(library);
  expect(after.entries).toEqual([{ id: "user-9", name: "Mine" }]);
  expect(existsSync(join(library, "user-9.json"))).toBe(true);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
});

test("payload: MCP entry carries the profile selector and merges over foreign servers", () => {
  const doc = desktopConfigPayload({
    mode: "direct",
    profile: WORK,
    baseUrl: DEFAULT_COPILOT_API_BASE,
    helperPath: "/x/h.sh",
    existing: {
      "managedMcpServers": { "their-server": { "command": "x" } },
      "inferenceCustomHeaders": { "X-Custom": "keep" },
    },
  });
  const servers = doc["managedMcpServers"] as Record<string, { command: string; args: string[] }>;
  expect(Object.keys(servers).sort()).toEqual(["copilot-env", "their-server"]);
  // Derived from the same launcher-command builder the writer uses: on Windows the
  // args carry the PowerShell invocation ahead of the copilot-env subcommand, so a
  // hand-spelled POSIX shape would be wrong there.
  const launcher = agentLauncherCommand(["mcp", "--serve", "--profile", "work"]);
  expect(servers["copilot-env"]?.command).toBe(launcher.command);
  expect(servers["copilot-env"]?.args).toEqual(launcher.args);
  // Foreign header names survive; ours are (re)written.
  const headers = doc["inferenceCustomHeaders"] as Record<string, string>;
  expect(headers["X-Custom"]).toBe("keep");
  expect(headers["Openai-Intent"]).toBe("conversation-edits");

  // A switch to proxy strips only OUR header names; the foreign extra survives.
  const proxy = desktopConfigPayload({
    mode: "proxy",
    profile: WORK,
    baseUrl: "http://127.0.0.1:4141",
    helperPath: "/x/h.sh",
    existing: doc,
  });
  expect(proxy["inferenceCustomHeaders"]).toEqual({ "X-Custom": "keep" });
});

test("quiet re-wire heals rows recorded without labels (no catalog fetch)", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry({
    profile: null,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  });
  const meta = metaOf(library);
  const id = (meta.entries as { id: string }[])[0]?.id;
  const configPath = join(library, `${id}.json`);
  // Strip the labels, as a pre-label release would have recorded the rows.
  const doc = readJson(configPath);
  doc.inferenceModels = (doc.inferenceModels as Record<string, unknown>[]).map((m) => {
    const { labelOverride: _l, ...rest } = m;
    return rest;
  });
  writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`);
  // Quiet + owned: rows are reused (the fetchImpl would throw if fetched) and healed.
  await wireClaudeDesktopEntry({
    profile: null,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: true,
    fetchImpl: () => Promise.reject(new Error("must not fetch on the quiet path")),
  });
  const healed = readJson(configPath).inferenceModels as { name: string; labelOverride: string }[];
  expect(healed.find((m) => m.name === "claude-fable-5")?.labelOverride).toBe("Claude Fable 5");
  expect(healed.every((m) => typeof m.labelOverride === "string" && m.labelOverride !== "")).toBe(
    true,
  );
  // The recorded rows were REUSED, not refetched: opus-4-8 exists only in the
  // recorded catalog rows, and the fetchImpl would have rejected.
  expect(healed.some((m) => m.name === "claude-opus-4-8")).toBe(true);
});

// --- the `claude-desktop` key: reconcile, status, dry-run listing -----------------------

/** Capture BOTH process write streams (consola routes by level) while awaiting `fn`. */
async function captureAllWrites(fn: () => Promise<void> | void): Promise<string> {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  let out = "";
  const capture = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    await fn();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return out;
}

/** A direct wire with a fixed catalog (no network, no credential store). */
function directWire(profile: Profile = null): DesktopWireOptions {
  return {
    profile,
    mode: "direct",
    directIntegrationId: null,
    directToken: "ghu_x",
    quiet: false,
    fetchImpl: catalogFetch(CATALOG),
  };
}

function firstEntryPath(library: string): string {
  const entries = metaOf(library).entries as { id: string }[];
  return join(library, `${entries[0]?.id}.json`);
}

function entryPathNamed(library: string, name: string): string {
  const entries = metaOf(library).entries as { id: string; name: string }[];
  return join(library, `${entries.find((e) => e.name === name)?.id}.json`);
}

test("sync reconciles from the key: on wires (every write announced), off removes a profile's, keeps the default's", async () => {
  const { library } = isolateWithDesktop();
  const metaPath = join(library, "_meta.json");
  const helper = desktopHelperPath(resolveRootHome(), "direct", null);

  // Default on: the entry lands, and every file touched is named -- config, meta,
  // helper, and the ownership claim.
  const wired = await captureAllWrites(() => syncClaudeDesktopWiring(directWire()));
  const configPath = firstEntryPath(library);
  expect(existsSync(configPath)).toBe(true);
  expect(wired).toContain(`Claude Desktop: wrote ${helper}`);
  expect(wired).toContain(`Claude Desktop: updated ${metaPath}`);
  expect(wired).toContain(`Claude Desktop: recorded ownership of ${configPath} in `);
  expect(wired).toContain(`Claude Desktop: wired "copilot-env" (direct) at ${configPath}`);

  // A byte-identical re-sync states the wiring but announces no write.
  const again = await captureAllWrites(() => syncClaudeDesktopWiring(directWire()));
  expect(again).toContain(`wired "copilot-env" (direct) at ${configPath}`);
  expect(again).not.toContain("wrote");
  expect(again).not.toContain("updated");
  expect(again).not.toContain("recorded ownership");
  // ... and a QUIET re-sync (the launcher hot path) says nothing at all.
  expect(await captureAllWrites(() => syncClaudeDesktopWiring({ ...directWire(), quiet: true })))
    .toBe("");

  // Off: the default's write leaves ITS entry in place and says so (quiet: silently); a
  // profile's write removes ITS entry, naming each path -- another profile's entry is
  // the whole-library reconcile's business, not this write's.
  await wireClaudeDesktopEntry(directWire(WORK));
  const workHelper = desktopHelperPath(resolveRootHome(), "direct", WORK);
  const firstWork = entryPathNamed(library, "copilot-env: work");
  new CopilotEnvConfig().set({ claudeDesktop: false });
  const left = await captureAllWrites(() => syncClaudeDesktopWiring(directWire()));
  expect(left).toContain(
    `Claude Desktop: "copilot-env" at ${configPath} left in place, unmanaged (claude-desktop false)`,
  );
  expect(left).not.toContain("removed");
  expect(await captureAllWrites(() => syncClaudeDesktopWiring({ ...directWire(), quiet: true })))
    .toBe("");
  const removed = await captureAllWrites(() => syncClaudeDesktopWiring(directWire(WORK)));
  expect(existsSync(configPath)).toBe(true);
  expect(existsSync(helper)).toBe(true);
  expect(existsSync(firstWork)).toBe(false);
  expect(existsSync(workHelper)).toBe(false);
  expect((metaOf(library).entries as { name: string }[]).map((e) => e.name)).toEqual([
    "copilot-env",
  ]);
  expect(new OwnershipLedger().owns("claudeDesktop", firstWork)).toBe(false);
  expect(removed).toContain(`Claude Desktop: updated ${metaPath}`);
  expect(removed).toContain(`Claude Desktop: removed ${firstWork}`);
  expect(removed).toContain(`Claude Desktop: released ownership of ${firstWork} in `);
  expect(removed).toContain(`Claude Desktop: removed ${workHelper}`);

  // Off with a MALFORMED profile store: the per-write removal touches nothing (the same
  // guard as the whole-library sweep), and says why. Control: well-formed, it removes.
  await wireClaudeDesktopEntry(directWire(WORK));
  const workPath = entryPathNamed(library, "copilot-env: work");
  const storeFile = new CopilotApiPaths().sharedStateFile;
  const snapshot = () => ({
    meta: readFileSync(metaPath, "utf8"),
    config: readFileSync(workPath, "utf8"),
    helper: readFileSync(workHelper, "utf8"),
    owned: new OwnershipLedger().ownedPaths("claudeDesktop"),
  });
  const before = snapshot();
  writeFileSync(storeFile, "{ not json");
  const guarded = await captureAllWrites(() => syncClaudeDesktopWiring(directWire(WORK)));
  expect(guarded).toContain(
    `the profile store ${storeFile} is malformed; leaving the config library alone`,
  );
  expect(snapshot()).toEqual(before);
  writeFileSync(storeFile, "{}\n");
  await syncClaudeDesktopWiring(directWire(WORK));
  expect(existsSync(workPath)).toBe(false);

  // Off never creates: a library that does not exist stays that way.
  rmSync(library, { recursive: true, force: true });
  await syncClaudeDesktopWiring(directWire(WORK));
  expect(existsSync(library)).toBe(false);
});

test("a stale User-Agent is drift: the inspector judges with the writer's live UA", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry(directWire());
  const configPath = firstEntryPath(library);
  const targets: DesktopTarget[] = [{ profile: null, mode: "direct" }];
  expect(inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict.kind).toBe("wired");
  const doc = readJson(configPath);
  const headers = { ...(doc["inferenceCustomHeaders"] as Record<string, string>) };
  headers["User-Agent"] = `${headers["User-Agent"]}-stale`;
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...doc, "inferenceCustomHeaders": headers }, null, 2)}\n`,
  );
  // A Codex upgrade WOULD rewrite this entry, so it must not read wired.
  expect(inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict).toEqual({
    kind: "stale",
    path: configPath,
    reason: "the managed keys drifted (a rewire would change the entry)",
  });
});

test.skipIf(NO_CHMOD_FAULTS)(
  "the config write is announced the moment it lands, even when a later step fails",
  async () => {
    const { library } = isolateWithDesktop();
    // Pre-write the helper so the wire has nothing to write under the root home, then
    // make the root home read-only: the config + meta saves (in the library) succeed,
    // the ownership record (under the root home) fails.
    writeDesktopHelperScript("proxy", null);
    const rootHome = resolveRootHome();
    chmodSync(rootHome, 0o555);
    let out = "";
    try {
      out = await captureAllWrites(() =>
        syncClaudeDesktopWiring({ profile: null, mode: "proxy", fetchImpl: catalogFetch(CATALOG) })
      );
    } finally {
      chmodSync(rootHome, 0o755);
    }
    const configPath = firstEntryPath(library);
    expect(existsSync(configPath)).toBe(true);
    expect(out).toContain(`Claude Desktop: wired "copilot-env" (proxy) at ${configPath}`);
    expect(out).toContain("Could not wire Claude Desktop for default");
    expect(new OwnershipLedger().owns("claudeDesktop", configPath)).toBe(false);
  },
);

/** The inspected arm of a status, or a failed assertion (the tests below expect a readable library). */
function inspected(
  status: ReturnType<typeof inspectClaudeDesktopWiring>,
): Extract<ReturnType<typeof inspectClaudeDesktopWiring>, { kind: "inspected" }> {
  if (status.kind !== "inspected") {
    throw new Error(`expected an inspected status, got ${status.kind}`);
  }
  return status;
}

test("inspect + render: wired, missing, stale, orphaned, disabled-but-owned, absent", async () => {
  const { library } = isolateWithDesktop();
  const targets: DesktopTarget[] = [
    { profile: null, mode: "direct" },
    { profile: WORK, mode: "proxy" },
  ];

  // Nothing wired yet: both promised entries are missing, each with its own fix.
  let status = inspected(inspectClaudeDesktopWiring(targets));
  expect(status.entries.map((e) => e.verdict.kind)).toEqual(["missing", "missing"]);
  let rendered = renderClaudeDesktopStatus(status);
  expect(rendered.lines).toEqual([
    `"copilot-env" (direct) missing`,
    `"copilot-env: work" (proxy) missing`,
  ]);
  expect(rendered.fix).toBe("agent claude, then agent profile --add work");

  // Wire the default: wired at its path; the profile stays missing.
  await wireClaudeDesktopEntry(directWire());
  const configPath = firstEntryPath(library);
  status = inspected(inspectClaudeDesktopWiring(targets));
  expect(status.entries[0]?.verdict).toEqual({ kind: "wired", path: configPath });
  expect(status.owned).toEqual([{ name: "copilot-env", path: configPath, profile: null }]);
  expect(status.orphans).toEqual([]);
  rendered = renderClaudeDesktopStatus(status);
  expect(rendered.lines[0]).toBe(`"copilot-env" (direct) wired at ${configPath}`);
  expect(rendered.fix).toBe("agent profile --add work");

  // Stale: the target's mode moved to proxy while the entry still points at Direct.
  status = inspected(inspectClaudeDesktopWiring([{ profile: null, mode: "proxy" }]));
  const moved = status.entries[0]?.verdict;
  expect(moved?.kind).toBe("stale");
  if (moved?.kind === "stale") {
    expect(moved.path).toBe(configPath);
    expect(moved.reason).toContain(
      `gateway ${DEFAULT_COPILOT_API_BASE}, expected http://127.0.0.1:`,
    );
  }
  expect(renderClaudeDesktopStatus(status).fix).toBe("agent claude");

  // Orphaned: the default wiring left our management (no target promises the entry).
  status = inspected(inspectClaudeDesktopWiring([]));
  expect(status.entries).toEqual([]);
  expect(status.orphans).toEqual([{ name: "copilot-env", path: configPath, profile: null }]);
  rendered = renderClaudeDesktopStatus(status);
  expect(rendered.lines).toEqual([
    `"copilot-env" orphaned at ${configPath} (no current wiring promises it)`,
  ]);
  expect(rendered.fix).toBe("agent claude");

  // Unknowable targets outrank nothing but the library's own facts: with the key on and
  // the app present, the entries are simply not judged.
  const unjudged = inspectClaudeDesktopWiring({
    kind: "unresolvable",
    reason: "settings.json junk",
  });
  expect(unjudged.kind).toBe("unjudged");
  rendered = renderClaudeDesktopStatus(unjudged);
  expect(rendered.lines).toEqual(["settings.json junk; the Desktop entries were not judged"]);
  expect(rendered.fix).toBe("fix the cause named above, then re-run `agent claude`");

  // Stale: a managed key drifted, then the same bytes a quiet rewire would rewrite
  // (compact JSON), then a direct entry lost its model rows (an empty picker is not wired).
  const doc = readJson(configPath);
  const drifted = { ...doc, "deploymentDisplayName": "Mine" };
  writeFileSync(configPath, `${JSON.stringify(drifted, null, 2)}\n`);
  expect(inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict).toEqual({
    kind: "stale",
    path: configPath,
    reason: "the managed keys drifted (a rewire would change the entry)",
  });
  writeFileSync(configPath, `${JSON.stringify(doc)}\n`);
  expect(inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict.kind).toBe("stale");
  writeFileSync(configPath, `${JSON.stringify({ ...doc, "inferenceModels": [] }, null, 2)}\n`);
  expect(inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict).toEqual({
    kind: "stale",
    path: configPath,
    reason: "no model rows (re-run `agent claude` online)",
  });
  writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`);
  expect(inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict.kind).toBe("wired");
  // Header drift the writer WOULD apply is stale too: a pinned identity the entry lacks.
  new CopilotEnvConfig().set({ integrationId: "copilot-developer-cli" });
  expect(inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict).toEqual({
    kind: "stale",
    path: configPath,
    reason: "the managed keys drifted (a rewire would change the entry)",
  });
  new CopilotEnvConfig().del("integrationId");
  expect(inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict.kind).toBe("wired");

  // Stale: the helper body drifted, then lost its executable bit, then vanished --
  // each a distinct reason, none of them "wired".
  const helper = desktopHelperPath(resolveRootHome(), "direct", null);
  const verdict = () => inspected(inspectClaudeDesktopWiring(targets)).entries[0]?.verdict;
  writeFileSync(helper, "#!/bin/sh\nexit 1\n");
  expect(verdict()).toEqual({
    kind: "stale",
    path: configPath,
    reason: `credential helper ${helper} is missing or has a stale body`,
  });
  writeDesktopHelperScript("direct", null);
  expect(verdict()?.kind).toBe("wired");
  if (process.platform !== "win32") {
    chmodSync(helper, 0o644);
    expect(verdict()).toEqual({
      kind: "stale",
      path: configPath,
      reason: `credential helper ${helper} is not executable`,
    });
  }
  rmSync(helper);
  expect(verdict()).toEqual({
    kind: "stale",
    path: configPath,
    reason: `credential helper ${helper} is missing or has a stale body`,
  });

  // Key off: the default's entry is present and unmanaged, never drift -- whatever the
  // targets say (the library's facts come first). A profile's entry or helper script IS a
  // leftover (an interrupted sweep can leave either), and the sweep is its fix.
  new CopilotEnvConfig().set({ claudeDesktop: false });
  status = inspected(
    inspectClaudeDesktopWiring({ kind: "unresolvable", reason: "settings.json junk" }),
  );
  expect(status.entries).toEqual([]);
  expect(status.orphans).toEqual([]);
  expect(status.owned).toEqual([{ name: "copilot-env", path: configPath, profile: null }]);
  const unmanaged = `"copilot-env" present at ${configPath}, unmanaged (claude-desktop false)`;
  expect(renderClaudeDesktopStatus(status)).toEqual({
    lines: [unmanaged, "disabled (claude-desktop false); no copilot-env leftovers present"],
    fix: null,
  });
  await wireClaudeDesktopEntry(directWire(WORK));
  rendered = renderClaudeDesktopStatus(inspectClaudeDesktopWiring(targets));
  expect(rendered.lines).toEqual([
    unmanaged,
    "disabled (claude-desktop false), but 2 copilot-env leftovers remain (files or ownership claims)",
    entryPathNamed(library, "copilot-env: work"),
    desktopHelperPath(resolveRootHome(), "direct", WORK),
  ]);
  expect(rendered.fix).toBe("agent claude");
  removeUnmanagedClaudeDesktopWiring();
  expect(renderClaudeDesktopStatus(inspectClaudeDesktopWiring(targets))).toEqual({
    lines: [unmanaged, "disabled (claude-desktop false); no copilot-env leftovers present"],
    fix: null,
  });
  // Uninstall's sweep alone takes the default's entry too.
  removeAllClaudeDesktopWiring();
  expect(renderClaudeDesktopStatus(inspectClaudeDesktopWiring(targets))).toEqual({
    lines: ["disabled (claude-desktop false); no copilot-env leftovers present"],
    fix: null,
  });

  // No library on this machine (an injected null dir): nothing to wire, never drift.
  // No targets and nothing owned: idle.
  new CopilotEnvConfig().del("claudeDesktop");
  expect(inspectClaudeDesktopWiring(targets, null).kind).toBe("no-library");
  expect(renderClaudeDesktopStatus(inspectClaudeDesktopWiring(targets, null))).toEqual({
    lines: ["Claude Desktop not detected on this machine; nothing to wire"],
    fix: null,
  });
  expect(renderClaudeDesktopStatus(inspectClaudeDesktopWiring([])).fix).toBeNull();
});

test("an unreadable _meta.json is reported before anything else, the key off included", () => {
  const { library } = isolateWithDesktop();
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "_meta.json"), "junk\n");
  const metaPath = join(library, "_meta.json");
  for (const enabled of [true, false]) {
    new CopilotEnvConfig().set({ claudeDesktop: enabled });
    const status = inspectClaudeDesktopWiring([{ profile: null, mode: "direct" }]);
    expect(status).toEqual({
      kind: "unreadable",
      enabled,
      installed: true,
      helperPaths: [],
      metaPath,
    });
    const rendered = renderClaudeDesktopStatus(status);
    expect(rendered.lines[0]).toContain("has an unexpected shape");
    expect(rendered.fix).toBe(`repair ${metaPath}, then re-run \`agent claude\``);
  }
});

test.skipIf(process.platform === "win32")(
  "removal treats a dangling helper symlink as present: removed and announced, never skipped",
  async () => {
    isolateWithDesktop();
    await wireClaudeDesktopEntry(directWire());
    // Replace the helper with a dangling symlink -- the control: an existsSync-gated
    // removal would read it as absent and skip it.
    const helper = desktopHelperPath(resolveRootHome(), "direct", null);
    rmSync(helper);
    symlinkSync(join(dir, "nowhere"), helper);
    expect(existsSync(helper)).toBe(false);
    const out = await captureAllWrites(() => removeClaudeDesktopEntry(null));
    expect(out).toContain(`Claude Desktop: removed ${helper}`);
    expect(() => lstatSync(helper)).toThrow();
  },
);

test("reconcileClaudeDesktopWiring: orphans go when the key is on, the profiles' when it is off", async () => {
  const { library } = isolateWithDesktop();
  // Owned entries with NO managed Claude wiring (the isolated home has no settings.json)
  // and no profile slot (`work` was never added): nothing promises either, so the
  // reconcile removes both -- the default's and the named one's helpers included.
  await wireClaudeDesktopEntry(directWire());
  await wireClaudeDesktopEntry(directWire(WORK));
  const [configPath, workPath] = (metaOf(library).entries as { id: string }[]).map((e) =>
    join(library, `${e.id}.json`)
  );
  const helper = desktopHelperPath(resolveRootHome(), "direct", null);
  const workHelper = desktopHelperPath(resolveRootHome(), "direct", WORK);
  expect(resolveClaudeDesktopTargets()).toEqual({ kind: "resolved", targets: [] });
  const swept = await captureAllWrites(() => reconcileClaudeDesktopWiring());
  for (const path of [configPath, workPath, helper, workHelper]) {
    expect(swept).toContain(`Claude Desktop: removed ${path}`);
    expect(existsSync(path ?? "")).toBe(false);
  }
  expect(metaOf(library).entries).toEqual([]);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
  expect(renderClaudeDesktopStatus(claudeDesktopStatus()).fix).toBeNull();

  // An unreadable settings.json is NOT "the default promises nothing": the entry stays,
  // the status says it was not judged, and the reconcile warns instead of sweeping.
  await wireClaudeDesktopEntry(directWire());
  const kept = firstEntryPath(library);
  mkdirSync(resolveClaudeHome(), { recursive: true });
  writeFileSync(join(resolveClaudeHome(), "settings.json"), "{ not json");
  expect(resolveClaudeDesktopTargets().kind).toBe("unresolvable");
  const unjudged = claudeDesktopStatus();
  expect(unjudged.kind).toBe("unjudged");
  expect(renderClaudeDesktopStatus(unjudged).lines[0]).toContain("settings.json malformed");
  const warned = await captureAllWrites(() => reconcileClaudeDesktopWiring());
  expect(warned).toContain("leaving the config library alone");
  expect(existsSync(kept)).toBe(true);
  rmSync(join(resolveClaudeHome(), "settings.json"));
  await reconcileClaudeDesktopWiring();
  expect(existsSync(kept)).toBe(false);

  // Key off: the profile's entry and helper go, whatever promised them; the default's stay
  // in place, still owned, and the reconcile says so (once; the quiet hot path is silent).
  await wireClaudeDesktopEntry(directWire());
  await wireClaudeDesktopEntry(directWire(WORK));
  const defaultPath = firstEntryPath(library);
  new CopilotEnvConfig().set({ claudeDesktop: false });
  const off = await captureAllWrites(() => reconcileClaudeDesktopWiring());
  expect(off).toContain(
    `Claude Desktop: "copilot-env" at ${defaultPath} left in place, unmanaged (claude-desktop false).`,
  );
  expect((metaOf(library).entries as { name: string }[]).map((e) => e.name)).toEqual([
    "copilot-env",
  ]);
  expect(existsSync(helper)).toBe(true);
  expect(existsSync(desktopHelperPath(resolveRootHome(), "direct", WORK))).toBe(false);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([defaultPath]);
  expect(await captureAllWrites(() => reconcileClaudeDesktopWiring({ quiet: true }))).toBe("");
  expect(renderClaudeDesktopStatus(claudeDesktopStatus()).fix).toBeNull();

  // Best-effort: a library the reconcile cannot read warns and never throws.
  writeFileSync(join(library, "_meta.json"), "junk\n");
  new CopilotEnvConfig().del("claudeDesktop");
  const blocked = await captureAllWrites(() => reconcileClaudeDesktopWiring());
  expect(blocked).toContain("unexpected shape");
});

test("an interrupted removal's unlisted claim is reported, listed for the dry run, and swept", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry(directWire());
  const configPath = firstEntryPath(library);
  // Simulate the failure window: _meta.json pruned, the config file and its claim left.
  const meta = metaOf(library);
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify({ ...meta, entries: [] })}\n`);
  const status = inspected(inspectClaudeDesktopWiring([]));
  expect(status.owned).toEqual([]);
  expect(status.unlisted).toEqual([configPath]);
  const rendered = renderClaudeDesktopStatus(status);
  expect(rendered.lines).toEqual([
    `${configPath} is still claimed in the ownership ledger but no longer listed in _meta.json (an interrupted removal)`,
  ]);
  expect(rendered.fix).toBe("agent claude");
  expect(listClaudeDesktopOwnedArtifacts().entries).toEqual([configPath]);
  // A trailing separator on the injected dir changes nothing about which claims count.
  expect(inspected(inspectClaudeDesktopWiring([], `${library}/`)).unlisted).toEqual([configPath]);
  // The claim of a file already gone is still a leftover, and says so; the dry run lists
  // only files.
  rmSync(configPath);
  const gone = renderClaudeDesktopStatus(inspectClaudeDesktopWiring([]));
  expect(gone.lines[0]).toContain("and its file is gone");
  expect(listClaudeDesktopOwnedArtifacts().entries).toEqual([]);
  writeFileSync(configPath, "{}\n");
  // Key off shows it as a leftover too.
  new CopilotEnvConfig().set({ claudeDesktop: false });
  expect(renderClaudeDesktopStatus(inspectClaudeDesktopWiring([])).lines).toContain(configPath);
  new CopilotEnvConfig().del("claudeDesktop");
  // The reconcile deletes the file and releases the claim, announcing both.
  const out = await captureAllWrites(() => reconcileClaudeDesktopWiring());
  expect(out).toContain(`Claude Desktop: removed ${configPath}`);
  expect(out).toContain(`Claude Desktop: released ownership of ${configPath}`);
  expect(existsSync(configPath)).toBe(false);
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual([]);
  expect(inspected(inspectClaudeDesktopWiring([])).unlisted).toEqual([]);
});

test("duplicate owned entries serving one wiring are drift a rewire cannot repair", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry(directWire());
  const configPath = firstEntryPath(library);
  const dupPath = join(library, "dup.json");
  writeFileSync(dupPath, readFileSync(configPath, "utf8"));
  const meta = metaOf(library);
  (meta.entries as unknown[]).push({ id: "dup", name: "copilot-env" });
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify(meta)}\n`);
  new OwnershipLedger().record("claudeDesktop", dupPath);
  const status = inspected(inspectClaudeDesktopWiring([{ profile: null, mode: "direct" }]));
  const verdict = status.entries[0]?.verdict;
  expect(verdict?.kind).toBe("stale");
  if (verdict?.kind === "stale") {
    expect(verdict.reason).toBe("2 owned entries serve this wiring");
    expect(verdict.fix).toContain("duplicate");
  }
  expect(status.orphans).toEqual([]);
  expect(renderClaudeDesktopStatus(status).fix).toContain("delete the duplicate");
});

test("a renamed owned entry is ours by path: rewired in place, name kept, unmanaged on key off", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry(directWire());
  const configPath = firstEntryPath(library);
  const meta = metaOf(library);
  (meta.entries as { name: string }[])[0]!.name = "Mine now";
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify(meta)}\n`);
  const target: DesktopTarget = { profile: null, mode: "direct" };
  // Still the default's entry: judged against its target, never an orphan.
  expect(inspected(inspectClaudeDesktopWiring([target])).entries[0]?.verdict).toEqual({
    kind: "wired",
    path: configPath,
  });
  expect(inspected(inspectClaudeDesktopWiring([target])).orphans).toEqual([]);
  // Drift is healed IN PLACE (same uuid), and the user's name stays.
  rmSync(desktopHelperPath(resolveRootHome(), "direct", null));
  expect(inspected(inspectClaudeDesktopWiring([target])).entries[0]?.verdict.kind).toBe("stale");
  const out = await captureAllWrites(() => wireClaudeDesktopEntry(directWire()));
  expect(out).toContain(`Claude Desktop: wired "Mine now" (direct) at ${configPath}`);
  expect(metaOf(library).entries).toEqual([{
    id: basename(configPath, ".json"),
    name: "Mine now",
  }]);
  expect(inspected(inspectClaudeDesktopWiring([target])).entries[0]?.verdict.kind).toBe("wired");
  // Renamed to ANOTHER wiring's seed name, it is still the default's and no obstacle to
  // that wiring: the profile gets its own entry (the picker twin is the user's doing).
  const twin = metaOf(library);
  (twin.entries as { name: string }[])[0]!.name = "copilot-env: work";
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify(twin)}\n`);
  await wireClaudeDesktopEntry(directWire(WORK));
  expect((metaOf(library).entries as { name: string }[]).map((e) => e.name)).toEqual([
    "copilot-env: work",
    "copilot-env: work",
  ]);
  expect(
    inspected(inspectClaudeDesktopWiring([target, { profile: WORK, mode: "direct" }]))
      .entries.map((e) => e.verdict.kind),
  ).toEqual(["wired", "wired"]);
  removeClaudeDesktopEntry(WORK);
  // Key off leaves the default's entry in place under the user's name, and says so.
  new CopilotEnvConfig().set({ claudeDesktop: false });
  const off = await captureAllWrites(() => reconcileClaudeDesktopWiring());
  expect(off).toContain(`"copilot-env: work" at ${configPath} left in place, unmanaged`);
  expect(existsSync(configPath)).toBe(true);
  expect(renderClaudeDesktopStatus(claudeDesktopStatus()).lines[0]).toBe(
    `"copilot-env: work" present at ${configPath}, unmanaged (claude-desktop false)`,
  );
});

/** Every Desktop artifact's existence, for "nothing changed" comparisons. */
function artifactsOf(library: string): Record<string, boolean> {
  const rootHome = resolveRootHome();
  const paths = [
    ...(metaOf(library).entries as { id: string }[]).map((e) => join(library, `${e.id}.json`)),
    desktopHelperPath(rootHome, "direct", null),
    desktopHelperPath(rootHome, "direct", WORK),
  ];
  return Object.fromEntries(paths.map((p) => [p, existsSync(p)]));
}

test("a malformed profile store resolves nothing: no reconcile sweeps, key on or off", async () => {
  const { library } = isolateWithDesktop();
  await wireClaudeDesktopEntry(directWire());
  await wireClaudeDesktopEntry(directWire(WORK));
  const before = artifactsOf(library);
  expect(Object.values(before).every(Boolean)).toBe(true);
  const storeFile = new CopilotApiPaths().sharedStateFile;
  // Each shape the lenient store reader degrades to "no profiles" -- which would make
  // every named entry an orphan -- must instead leave every artifact untouched.
  writeFileSync(storeFile, "{ not json");
  const warned = await captureAllWrites(() => reconcileClaudeDesktopWiring());
  expect(warned).toContain(
    `the profile store ${storeFile} is malformed; leaving the config library alone`,
  );
  for (const junk of ["{ not json", "[]", `{"profiles": 5}`, `{"profiles": {"work": 7}}`]) {
    writeFileSync(storeFile, junk);
    expect(resolveClaudeDesktopTargets().kind).toBe("unresolvable");
    for (const enabled of [true, false]) {
      new CopilotEnvConfig().set({ claudeDesktop: enabled });
      await reconcileClaudeDesktopWiring();
      expect(artifactsOf(library)).toEqual(before);
    }
  }
  // Controls: an EMPTY store -- blank or whitespace, what the canonical reader accepts as
  // `{}` -- and a well-formed one with no slots ARE resolved, and the same sweep runs.
  for (const empty of ["", "  \n\t"]) {
    writeFileSync(storeFile, empty);
    expect(resolveClaudeDesktopTargets()).toEqual({ kind: "resolved", targets: [] });
  }
  writeFileSync(storeFile, "{}\n");
  new CopilotEnvConfig().del("claudeDesktop");
  await reconcileClaudeDesktopWiring();
  expect(Object.keys(before).filter(existsSync)).toEqual([]);
});

test.skipIf(NO_CHMOD_FAULTS)(
  "an unreadable ownership ledger leaves the --check tail unjudged and the exit code alone",
  async () => {
    isolateWithDesktop();
    await wireClaudeDesktopEntry(directWire());
    const ledgerFile = new CopilotApiPaths().ownershipFile;
    chmodSync(ledgerFile, 0o000);
    try {
      const status = claudeDesktopStatus();
      expect(status.kind).toBe("unjudged");
      // The preference actually read travels with the failed look (health publishes it).
      expect(status.enabled).toBe(true);
      new CopilotEnvConfig().set({ claudeDesktop: false });
      expect(claudeDesktopStatus()).toMatchObject({ kind: "unjudged", enabled: false });
      // The preference store itself unreadable: the registry default, and the reason says so.
      const prefsFile = new CopilotApiPaths().envConfigFile;
      chmodSync(prefsFile, 0o000);
      try {
        const noPrefs = claudeDesktopStatus();
        expect(noPrefs).toMatchObject({ kind: "unjudged", enabled: true });
        if (noPrefs.kind === "unjudged") {
          expect(noPrefs.reason).toContain("the claude-desktop preference could not be read");
        }
      } finally {
        chmodSync(prefsFile, 0o600);
      }
      new CopilotEnvConfig().del("claudeDesktop");
      const { lines, fix } = renderClaudeDesktopStatus(status);
      expect(lines[0]).toContain("the Desktop wiring could not be checked");
      expect(lines[0]).toContain(ledgerFile);
      expect(fix).not.toBeNull();
      // The tail prints and returns; the provider-mode verdict `--check` set stands.
      process.exitCode = 2;
      printClaudeDesktopCheck();
      expect(process.exitCode).toBe(2);
    } finally {
      chmodSync(ledgerFile, 0o600);
    }
    // Control: readable again, the same call judges the entry.
    expect(claudeDesktopStatus().kind).toBe("inspected");
  },
);

test("call sites reconcile the whole library: init, profile --sync, the launcher's profile write", async () => {
  const { library } = isolateWithDesktop();
  const names = () => (metaOf(library).entries as { name: string }[]).map((e) => e.name).sort();

  // `agent init --proxy`: the default entry is wired, and an owned entry whose profile
  // does not exist (an orphan) is removed in the same run.
  await wireClaudeDesktopEntry(directWire(WORK));
  await captureAllWrites(() => runInit({ mode: "proxy" }));
  expect(names()).toEqual(["copilot-env"]);

  // `agent profile --sync` with ZERO complete profiles and the key off: the sweep still
  // runs (nothing depends on a profile write happening), and keeps the default's entry.
  await wireClaudeDesktopEntry(directWire(WORK));
  new CopilotEnvConfig().set({ claudeDesktop: false });
  await captureAllWrites(() => runProfile({ sync: true, mode: "auto" }));
  expect(names()).toEqual(["copilot-env"]);
  // ... and with the key on, the launcher hot path never runs model discovery: a proxy
  // profile's reconcile issues no catalog fetch (the global fetch would throw here).
  new CopilotEnvConfig().del("claudeDesktop");
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("discovery ran on the hot path");
  };
  let synced = "";
  try {
    synced = await captureAllWrites(() => runProfile({ sync: true, mode: "auto" }));
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(synced).not.toContain("discovery ran on the hot path");
  expect(names()).toEqual(["copilot-env", "copilot-env: work"]);
  new CopilotEnvState().deleteProfile(WORK);
  removeAllClaudeDesktopWiring();
  // ... nor an identity probe for a DIRECT profile whose identity cache is empty: the
  // quiet reconcile is cleanup-only. Control: the non-quiet reconcile probes once.
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });
  let probes = 0;
  setIntegrationProbeFetch(() => {
    probes++;
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });
  // The control's upsert also runs model discovery: keep it off the network too.
  globalThis.fetch = () => Promise.reject(new Error("offline"));
  try {
    await captureAllWrites(() => reconcileClaudeDesktopWiring({ quiet: true }));
    expect(probes).toBe(0);
    await captureAllWrites(() => reconcileClaudeDesktopWiring());
    expect(probes).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = realFetch;
    setIntegrationProbeFetch(null);
  }
  new CopilotEnvState().deleteProfile(WORK);
  removeAllClaudeDesktopWiring();

  // The launcher's Claude profile write (`cl --profile work`) follows the key for its
  // own entry: key off removes it, key on restores it.
  new CopilotEnvConfig().set({ claudeDesktop: false });
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
  await wireClaudeDesktopEntry({ profile: WORK, mode: "proxy", fetchImpl: catalogFetch(CATALOG) });
  expect(names()).toEqual(["copilot-env: work"]);
  await captureAllWrites(async () => {
    await commandDeps().writeClaudeProfileSettings(WORK, "proxy");
  });
  expect(names()).toEqual([]);
  new CopilotEnvConfig().del("claudeDesktop");
  await captureAllWrites(async () => {
    await commandDeps().writeClaudeProfileSettings(WORK, "proxy");
  });
  expect(names()).toEqual(["copilot-env: work"]);
});

test("the reconcile re-discovers the default entry only when it is missing or stale", async () => {
  const { library } = isolateWithDesktop();
  const names = () => (metaOf(library).entries as { name: string }[]).map((e) => e.name);
  // A managed proxy default: the adapter write wires the entry (offline: no model rows).
  const realFetch = globalThis.fetch;
  let modelFetches = 0;
  globalThis.fetch = () => {
    modelFetches++;
    return Promise.reject(new Error("offline"));
  };
  try {
    await captureAllWrites(() => runClaude({ kind: "configure", mode: "proxy" }));
    expect(names()).toEqual(["copilot-env"]);
    // Already wired: the reconcile (what init / `agent claude` run next) fetches nothing.
    modelFetches = 0;
    await captureAllWrites(() => reconcileClaudeDesktopWiring());
    expect(modelFetches).toBe(0);
    expect(names()).toEqual(["copilot-env"]);
    // Missing (the config-only import path): the reconcile discovers and restores it.
    removeClaudeDesktopEntry(null);
    expect(names()).toEqual([]);
    await captureAllWrites(() => reconcileClaudeDesktopWiring());
    expect(modelFetches).toBeGreaterThan(0);
    expect(names()).toEqual(["copilot-env"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the sweep and its dry-run listing take every generated helper script and no neighbour", async () => {
  const { library } = isolateWithDesktop();
  const rootHome = resolveRootHome();
  mkdirSync(rootHome, { recursive: true });
  // Every helper name the writer can produce (both modes, default + profiles) ...
  const ours: string[] = [];
  for (const profile of [null, WORK, parseProfileName("a-b2")]) {
    for (const mode of ["direct", "proxy"] as const) {
      ours.push(writeDesktopHelperScript(mode, profile));
    }
  }
  // ... beside look-alikes that are not ours: a reserved or invalid profile word, another
  // artifact, a backup copy. None may be listed or deleted.
  const foreign = [
    "codex-model-catalog.json",
    "claude-desktop-token.sh.bak",
    "claude-desktop-token-default.sh",
    "claude-desktop-token-Bad.sh",
    "claude-desktop-token-.sh",
    "claude-desktop-proxy-token-all.cmd",
  ].map((name) => join(rootHome, name));
  for (const path of foreign) writeFileSync(path, "#!/bin/sh\n");
  expect(listClaudeDesktopOwnedArtifacts().helpers).toEqual([...ours].sort());
  removeAllClaudeDesktopWiring();
  expect(ours.filter(existsSync)).toEqual([]);
  expect(foreign.filter(existsSync)).toEqual(foreign);
  expect(listClaudeDesktopOwnedArtifacts()).toEqual({ entries: [], helpers: [], blocked: false });

  await wireClaudeDesktopEntry(directWire());
  const ownedPath = firstEntryPath(library);
  // A foreign sibling in the library is never listed: it would never be deleted.
  writeFileSync(join(library, "theirs.json"), '{"userKey":1}\n');
  const meta = metaOf(library);
  (meta.entries as unknown[]).push({ id: "theirs", name: "Mine" });
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify(meta)}\n`);
  expect(listClaudeDesktopOwnedArtifacts()).toEqual({
    entries: [ownedPath],
    helpers: [desktopHelperPath(rootHome, "direct", null)],
    blocked: false,
  });

  // A listed owned entry whose file is already gone is nothing to delete.
  rmSync(ownedPath);
  expect(listClaudeDesktopOwnedArtifacts().entries).toEqual([]);
  writeFileSync(ownedPath, "{}\n");
  // Desktop absent (injected null dir): no entries, the helper scripts still listed.
  expect(listClaudeDesktopOwnedArtifacts(null).entries).toEqual([]);
  expect(listClaudeDesktopOwnedArtifacts(null).helpers).toHaveLength(1);
  // A not-understood _meta.json blocks the sweep, and the listing says so.
  writeFileSync(join(library, "_meta.json"), "junk\n");
  expect(listClaudeDesktopOwnedArtifacts().blocked).toBe(true);
});
