// Claude Desktop config-library wiring (src/claude/desktop.ts): the managed entries,
// the never-clobber posture toward the app's own files, and the ownership record.
// Isolation: the suite floor points CLAUDE_DESKTOP_DIR_ENV at a NON-created dir, so
// nothing here can reach a real library; each test that wants Desktop "installed"
// creates its own data dir and re-points the seam at it.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  parseDesktopMeta,
  removeAllClaudeDesktopWiring,
  removeClaudeDesktopEntry,
  resolveDesktopLibraryDir,
  retireDesktopHelperScript,
  wireClaudeDesktopEntry,
  writeDesktopHelperScript,
} from "../src/claude/desktop.ts";
import { resolveClaudeHome } from "../src/claude/paths.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { DEFAULT_COPILOT_API_BASE } from "../src/copilot_api/integration_identity.ts";
import { resolveRootHome } from "../src/copilot_api/paths.ts";
import { agentLauncherCommand } from "../src/utils/root.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { expect, test } from "./helpers/testing.ts";
import { afterEach } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, removeDir } from "./helpers.ts";

const restoreEnv = envSnapshot();
const WORK = parseProfileName("work");
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

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
  // All capability switches on, all telemetry off (including essential).
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
      "disableEssentialTelemetry",
      "disableNonessentialTelemetry",
      "disableNonessentialServices",
    ]
  ) {
    expect(direct[key]).toBe(true);
  }
  expect(isRecordLike(direct["managedMcpServers"])).toBe(true);

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
  // alone carries no capability metadata).
  expect(Array.isArray(proxy["inferenceModels"])).toBe(true);
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
    existing: { "banner": { "enabled": true, "text": "keep me" }, "userKey": 42 },
  });
  expect(merged["banner"]).toEqual({ "enabled": true, "text": "keep me" });
  expect(merged["userKey"]).toBe(42);
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
  expect(new CopilotEnvState().ownsClaudeDesktopEntry(configPath)).toBe(true);

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
  await wireClaudeDesktopEntry(offline);
  meta = metaOf(library);
  const ours = (meta.entries as { id: string; name: string }[]).find(
    (e) => e.name === "copilot-env",
  );
  const doc = readJson(join(library, `${ours?.id}.json`));
  expect((doc["inferenceModels"] as unknown[]).length).toBeGreaterThan(0);
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

test("adopt-and-replace: same-gateway foreign entry is taken over in place and renamed", async () => {
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
  expect(entries).toEqual([{ id: "hand-1", name: "copilot-env" }]); // same uuid, renamed
  expect(meta.appliedId).toBe("hand-1"); // stays applied naturally
  const doc = readJson(join(library, "hand-1.json"));
  expect(doc["userKey"]).toBe("keep"); // surgical merge
  expect(doc["inferenceCredentialHelper"]).not.toBe(handMadeHelper); // managed helper now
  expect(existsSync(handMadeHelper)).toBe(false); // referenced hand-made helper retired
  expect(new CopilotEnvState().ownsClaudeDesktopEntry(join(library, "hand-1.json"))).toBe(true);
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
  expect(new CopilotEnvState().read().claudeDesktopOwnedPaths).toEqual([]);

  writeFileSync(join(library, "_meta.json"), "{ not json");
  await wireClaudeDesktopEntry(opts);
  expect(readFileSync(join(library, "_meta.json"), "utf8")).toBe("{ not json");
});

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
  expect(new CopilotEnvState().read().claudeDesktopOwnedPaths).toEqual([]);
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
  expect(new CopilotEnvState().read().claudeDesktopOwnedPaths).toEqual([]);
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
