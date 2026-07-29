import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

import {
  CUSTOM_HEADERS_ENV,
  configureClaudeConfig,
  settingsPathFor,
} from "../src/claude/config.ts";
import { codexProviderId, configureCodexConfig } from "../src/codex/config.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { setIntegrationProbeFetch } from "../src/copilot_api/integration_identity.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { migration } from "../src/migrations/3.5.1.ts";
import { isRecord } from "../src/utils/json.ts";

// The 3.5.1 migration re-bakes the probed Copilot client identity into DIRECT agent
// configs, healing an install whose PAT credential predates identity probing. It writes
// to real config homes, so isolate everything under a temp HOME.
// A branded fixture name: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");

const SAVED = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  COPILOT_API_HOME: process.env.COPILOT_API_HOME,
};
let dir = "";

afterEach(() => {
  setIntegrationProbeFetch(null);
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

/** A temp HOME with both agents wired DIRECT the pre-3.5.2 way (no identity header). */
function isolateDirect(token: string): { claudeHome: string; codexHome: string } {
  dir = mkdtempSync(join(tmpdir(), "copilot-mig351-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "proxy-home");
  mkdirSync(join(dir, "proxy-home"), { recursive: true });
  const claudeHome = join(dir, ".claude");
  const codexHome = join(dir, ".codex");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  new Credential().store("gh-token", token);
  // Pre-3.5.2 wiring: direct, with NO directIntegrationId baked.
  configureClaudeConfig(claudeHome, "direct", { quiet: true });
  configureCodexConfig(codexHome, "direct", { quiet: true, codexExecVersion: "0.139.0" });
  return { claudeHome, codexHome };
}

function claudeHeaders(claudeHome: string): string {
  const doc = JSON.parse(readFileSync(settingsPathFor(claudeHome), "utf8"));
  return (doc.env as Record<string, string>)[CUSTOM_HEADERS_ENV] ?? "";
}

function codexHeaders(codexHome: string): Record<string, unknown> {
  const doc = parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<
    string,
    unknown
  >;
  const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
  const provider = providers[codexProviderId()];
  const headers = isRecord(provider) ? provider.http_headers : undefined;
  return isRecord(headers) ? headers : {};
}

/** Accept only `copilot-developer-cli` -- the PAT case this migration exists for. */
function patOnlyEndpoint(): void {
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
}

test("re-bakes the probed identity into both direct configs, and is idempotent", async () => {
  const { claudeHome, codexHome } = isolateDirect("github_pat_x");
  // Pre-migration: the stale wiring carries no identity.
  expect(claudeHeaders(claudeHome)).not.toContain("Copilot-Integration-Id");
  expect(codexHeaders(codexHome)["Copilot-Integration-Id"]).toBeUndefined();

  patOnlyEndpoint();
  await migration.run();
  expect(claudeHeaders(claudeHome)).toContain("Copilot-Integration-Id: copilot-developer-cli");
  expect(codexHeaders(codexHome)["Copilot-Integration-Id"]).toBe("copilot-developer-cli");

  // Idempotent: a retried update re-runs it without changing anything.
  const claudeBefore = readFileSync(settingsPathFor(claudeHome), "utf8");
  const codexBefore = readFileSync(join(codexHome, "config.toml"), "utf8");
  await migration.run();
  expect(readFileSync(settingsPathFor(claudeHome), "utf8")).toBe(claudeBefore);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(codexBefore);
});

test("a non-PAT credential needs no header, so the configs are left untouched", async () => {
  const { claudeHome, codexHome } = isolateDirect("gho_oauth");
  const claudeBefore = readFileSync(settingsPathFor(claudeHome), "utf8");
  const codexBefore = readFileSync(join(codexHome, "config.toml"), "utf8");
  // A non-PAT token short-circuits before any network call; fail loudly if one happens.
  setIntegrationProbeFetch(() => Promise.reject(new Error("must not probe a non-PAT credential")));

  await migration.run();
  expect(readFileSync(settingsPathFor(claudeHome), "utf8")).toBe(claudeBefore);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(codexBefore);
});

test("a rejected credential warns instead of failing the update", async () => {
  const { claudeHome } = isolateDirect("github_pat_dead");
  const before = readFileSync(settingsPathFor(claudeHome), "utf8");
  // Every identity rejected -> resolveDirectIntegrationId throws; the migration must swallow
  // it (an update must not fail because a credential went bad) and leave the config alone.
  setIntegrationProbeFetch((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url.includes("/copilot_internal/user")
        ? new Response("{}", { status: 200 })
        : new Response("PATs not supported", { status: 400 }),
    );
  });

  await migration.run();
  expect(readFileSync(settingsPathFor(claudeHome), "utf8")).toBe(before);
});

test("a proxy-mode install is skipped entirely (no probe, no writes)", async () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-mig351-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "proxy-home");
  mkdirSync(join(dir, "proxy-home"), { recursive: true });
  const claudeHome = join(dir, ".claude");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = join(dir, ".codex");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(dir, ".codex"), { recursive: true });
  new Credential().store("gh-token", "github_pat_x");
  configureClaudeConfig(claudeHome, "proxy", { quiet: true });
  const before = readFileSync(settingsPathFor(claudeHome), "utf8");
  setIntegrationProbeFetch(() => Promise.reject(new Error("must not probe a proxy install")));

  await migration.run();
  expect(readFileSync(settingsPathFor(claudeHome), "utf8")).toBe(before);
});

test("the store's profile slots are untouched (named profiles self-heal on next launch)", async () => {
  isolateDirect("github_pat_x");
  const state = new CopilotEnvState();
  state.setProfileMode(WORK, "direct");
  patOnlyEndpoint();

  await migration.run();
  // No integrationIdentity written for the profile: a null slot already means "re-derive",
  // and every `cl`/`cx --profile` launch re-wires it.
  expect(state.readProfileSlot(WORK).integrationIdentity).toBeNull();
  expect(state.readProfileSlot(WORK).mode).toBe("direct");
});
