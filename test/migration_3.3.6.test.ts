import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

import { DIRECT_HELPER_NAME, PROXY_HELPER_NAME } from "../src/claude/paths.ts";
import { copilotApiResolvePort } from "../src/copilot_api/port.ts";
import { migration } from "../src/migrations/3.3.6.ts";
import {
  envSnapshot,
  isolateAgentHomes,
  removeDir,
  writeClaudeSettings,
  writeCodexConfigToml,
} from "./helpers.ts";

// The 3.3.6 migration re-points existing Codex/Claude configs from localhost to 127.0.0.1
// (and, via the Claude writer re-run, the .sh -> .cmd helper on Windows). It has filesystem
// side effects, so it is isolated here under temp homes.
const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function isolate(): { codexHome: string; claudeHome: string } {
  const homes = isolateAgentHomes("copilot-mig336-", { mkdirs: true });
  dir = homes.dir;
  return { codexHome: homes.codexHome, claudeHome: homes.claudeHome };
}

function writeCodex(codexHome: string, baseUrl: string): string {
  return writeCodexConfigToml(codexHome, { baseUrl, wireApi: "responses" });
}

function readCodexBaseUrl(p: string): unknown {
  const doc = parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  return providers["copilot-env"]?.base_url;
}

function writeClaude(claudeHome: string, apiKeyHelper: string, baseUrl: string, extra = {}): void {
  writeClaudeSettings(claudeHome, { apiKeyHelper, baseUrl, extra, pretty: true });
}

function readClaude(claudeHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
}

test("Codex: a stale localhost base_url is re-pointed to 127.0.0.1, other keys preserved", () => {
  const { codexHome } = isolate();
  const p = writeCodex(codexHome, "http://localhost:4141/v1");
  void migration.run();
  expect(readCodexBaseUrl(p)).toBe("http://127.0.0.1:4141/v1");
  // unrelated provider fields survive the targeted edit.
  const doc = parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  expect(doc.model_provider).toBe("copilot-env");
  expect(
    (doc.model_providers as Record<string, Record<string, unknown>>)["copilot-env"]?.wire_api,
  ).toBe("responses");
});

test("Codex: a config already on 127.0.0.1 is left untouched (idempotent)", () => {
  const { codexHome } = isolate();
  const p = writeCodex(codexHome, "http://127.0.0.1:4141/v1");
  const before = readFileSync(p, "utf8");
  void migration.run();
  expect(readFileSync(p, "utf8")).toBe(before);
});

test("Codex: a non-managed (foreign) base_url is not rewritten", () => {
  const { codexHome } = isolate();
  const p = writeCodex(codexHome, "https://api.githubcopilot.com");
  void migration.run();
  expect(readCodexBaseUrl(p)).toBe("https://api.githubcopilot.com"); // direct/foreign untouched
});

test("Claude: a stale localhost proxy config is re-pointed to 127.0.0.1 (helper at the current ext), user keys kept", () => {
  const { claudeHome } = isolate();
  // A pre-3.3.6 proxy install: apiKeyHelper points at the legacy .sh basename + a localhost URL.
  writeClaude(claudeHome, join(claudeHome, "copilot-proxy-token.sh"), "http://localhost:4141", {
    model: "sonnet",
  });
  void migration.run();
  const doc = readClaude(claudeHome);
  // Mode recovered from the .sh basename, writer re-run -> helper at the current platform ext.
  expect(doc.apiKeyHelper).toBe(join(claudeHome, PROXY_HELPER_NAME));
  expect((doc.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
    `http://127.0.0.1:${copilotApiResolvePort()}`,
  );
  expect(doc.model).toBe("sonnet"); // unrelated user key survives the surgical merge
});

test("Claude: a foreign apiKeyHelper is left untouched", () => {
  const { claudeHome } = isolate();
  writeClaude(claudeHome, "/opt/company/copilot-token.sh", "http://localhost:4141");
  const before = readFileSync(join(claudeHome, "settings.json"), "utf8");
  void migration.run();
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(before);
});

test("Claude: a direct install re-runs the writer (helper at the current ext), base URL stays direct", () => {
  const { claudeHome } = isolate();
  writeClaude(claudeHome, join(claudeHome, "copilot-token.sh"), "https://api.githubcopilot.com");
  void migration.run();
  const doc = readClaude(claudeHome);
  expect(doc.apiKeyHelper).toBe(join(claudeHome, DIRECT_HELPER_NAME));
  expect((doc.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
    "https://api.githubcopilot.com",
  );
});
