import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";

import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { migration } from "../src/migrations/3.3.3.ts";

// The 3.3.3 migration has filesystem side effects (state store + copilot-api's
// github_token file + the Codex config), so it is isolated here under a temp home --
// separate from migrations.test.ts, which covers the pure selection logic.
const SAVED = {
  HOME: process.env.HOME,
  COPILOT_API_HOME: process.env.COPILOT_API_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
};
let dir = "";

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function isolate(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-mig-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "proxy-home");
  // Pin CODEX_HOME into the temp dir so unifyCodexProvider can never touch a real
  // ~/.codex (effectiveCodexHome resolves $CODEX_HOME ahead of the homedir fallback).
  process.env.CODEX_HOME = join(dir, ".codex");
}

function state(): CopilotEnvState {
  return new CopilotEnvState();
}

function writeCodexConfig(contents: string): string {
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, contents);
  return configPath;
}

test("3.3.3 (a): backfills gh-token for a stored token with no recorded provider", () => {
  isolate();
  state().set({ githubToken: "ghu_legacy" }); // unreleased --gh-token shape: token, no provider
  void migration.run();
  expect(state().read()).toEqual({ githubToken: "ghu_legacy", authProvider: "gh-token" });
});

test("3.3.3 (b): imports copilot-api's token as copilot and scrubs its file", () => {
  isolate();
  const tokenFile = new CopilotApiPaths().githubTokenFile;
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, "ghu_from_copilot_api\n");
  void migration.run();
  expect(state().read()).toEqual({ githubToken: "ghu_from_copilot_api", authProvider: "copilot" });
  expect(existsSync(tokenFile)).toBe(false); // scrubbed
});

test("3.3.3 is idempotent: a chosen gh-cli provider (no token) is never overwritten", () => {
  isolate();
  state().set({ githubToken: null, authProvider: "gh-cli" });
  const tokenFile = new CopilotApiPaths().githubTokenFile;
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, "ghu_should_not_import\n");
  void migration.run();
  // gh-cli holds no token of its own and must not be clobbered by the import.
  expect(state().read()).toEqual({ githubToken: null, authProvider: "gh-cli" });
});

test("3.3.3 (codex): rewrites a legacy github-copilot-direct config to copilot-env", () => {
  isolate();
  const configPath = writeCodexConfig(
    [
      'model_provider = "github-copilot-direct"',
      "",
      "[model_providers.github-copilot-direct]",
      'name = "GitHub Copilot Direct"',
      'base_url = "https://api.githubcopilot.com"',
      'user_extra = "kept"',
      "",
      "[model_providers.other]",
      'base_url = "http://other/v1"',
      "",
    ].join("\n"),
  );

  void migration.run();

  const doc = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  expect(doc.model_provider).toBe("copilot-env");
  const providers = doc.model_providers as Record<string, unknown>;
  const asRecord = (v: unknown) => v as Record<string, unknown>;
  // Legacy table folded into copilot-env (user key kept, display name rewritten); the
  // legacy table is gone; unrelated providers survive.
  expect(providers["github-copilot-direct"]).toBeUndefined();
  expect(asRecord(providers["copilot-env"]).base_url).toBe("https://api.githubcopilot.com");
  expect(asRecord(providers["copilot-env"]).name).toBe("copilot-env");
  expect(asRecord(providers["copilot-env"]).user_extra).toBe("kept");
  expect(asRecord(providers.other).base_url).toBe("http://other/v1");
});

test("3.3.3 (codex) is idempotent + leaves a unified config untouched", () => {
  isolate();
  const unified = [
    'model_provider = "copilot-env"',
    "",
    "[model_providers.copilot-env]",
    'base_url = "https://api.githubcopilot.com"',
    "",
  ].join("\n");
  const configPath = writeCodexConfig(unified);

  void migration.run();
  const after = readFileSync(configPath, "utf8");
  expect(parse(after).model_provider).toBe("copilot-env");
  expect((parse(after).model_providers as Record<string, unknown>)["github-copilot-direct"]).toBe(
    undefined,
  );

  // A second run finds nothing legacy to change.
  void migration.run();
  expect(readFileSync(configPath, "utf8")).toBe(after);
});

test("3.3.3 (codex): a direct install with a stale copilot-env proxy table stays direct", () => {
  isolate();
  // model_provider selects legacy direct, but a leftover copilot-env PROXY table also
  // exists. The migration must keep the install DIRECT (the legacy table wins), not let
  // the stale proxy table flip it to proxy.
  const configPath = writeCodexConfig(
    [
      'model_provider = "github-copilot-direct"',
      "",
      "[model_providers.copilot-env]",
      'base_url = "http://localhost:4141/v1"',
      'env_key = "OPENAI_API_KEY"',
      "",
      "[model_providers.github-copilot-direct]",
      'base_url = "https://api.githubcopilot.com"',
      "",
      "[model_providers.github-copilot-direct.auth]",
      'command = "/x/agent"',
      'args = ["auth", "--get"]',
      "",
    ].join("\n"),
  );

  void migration.run();

  const doc = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const asRecord = (v: unknown) => v as Record<string, unknown>;
  expect(doc.model_provider).toBe("copilot-env");
  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  // Direct table won: api.githubcopilot.com + the auth block (NOT the localhost proxy).
  expect(provider.base_url).toBe("https://api.githubcopilot.com");
  expect(asRecord(provider.auth).command).toBe("/x/agent");
  expect(asRecord(doc.model_providers)["github-copilot-direct"]).toBeUndefined();
});
