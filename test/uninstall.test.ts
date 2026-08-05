// `agent uninstall`: the full-teardown command. Every run injects the deps seam
// (codexHomes + farm + shell removal) so `bun test` never touches the real
// ~/.codex, the host farm, or the shell rc files -- and never passes --force, so
// the dev checkout's .git guard keeps PROJECT_ROOT safe by construction.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

import { configureClaudeConfig } from "../src/claude/config.ts";
import { claudeJsonPath } from "../src/claude/mcp_registration.ts";
import { DIRECT_HELPER_NAME, PROXY_HELPER_NAME, settingsPathFor } from "../src/claude/paths.ts";
import { configureCodexConfig } from "../src/codex/config.ts";
import { runUninstall, type UninstallDeps } from "../src/commands/uninstall.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { profileHome } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { isRecord } from "../src/utils/json.ts";
import { envSnapshot, isolateAgentHomes, removeDir, resetExitCode } from "./helpers.ts";

// A branded fixture name: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  // An aborted run's exit 1 must never leak into the whole `bun test` run.
  resetExitCode();
  dir = removeDir(dir);
});

/** Isolated homes for one test: proxy home + Claude home + Codex home. */
function tmpHomes(): { proxyHome: string; claudeHome: string; codexHome: string } {
  const homes = isolateAgentHomes("copilot-uninstall-");
  dir = homes.dir;
  return homes;
}

/** The injected seam every test run passes: real codex home, spied side effects. */
function tmpDeps(codexHome: string): UninstallDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    codexHomes: [codexHome],
    removeCodexHostFarm: () => calls.push("farm"),
    removeShellIntegration: () => calls.push("shell"),
  };
}

function readToml(codexHome: string): Record<string, unknown> {
  return parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<string, unknown>;
}

test("uninstall removes everything managed and preserves user config", async () => {
  const { proxyHome, claudeHome, codexHome } = tmpHomes();

  // Default wiring: Claude direct + Codex proxy, each with a user key alongside.
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(settingsPathFor(claudeHome), JSON.stringify({ model: "opus" }));
  configureClaudeConfig(claudeHome, "direct", { quiet: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    ['foo = "bar"', "", "[model_providers.mine]", 'base_url = "https://example.test"', ""].join(
      "\n",
    ),
  );
  configureCodexConfig(codexHome, {
    mode: "proxy",
    quiet: true,
    baseUrl: "http://127.0.0.1:4199/v1",
  });

  // Default credential + a named direct profile (credential, mode, both agents, home).
  new Credential().store("gh-token", "ghp_default");
  new Credential(undefined, WORK).store("gh-token", "ghp_work");
  new CopilotEnvState().setProfileMode(WORK, "direct");
  configureClaudeConfig(claudeHome, "direct", { quiet: true, profile: WORK });
  configureCodexConfig(codexHome, { mode: "direct", quiet: true, profile: WORK });
  mkdirSync(profileHome(WORK), { recursive: true });

  // A second Codex home (e.g. a farm home from when it was the effective one)
  // that carries BOTH default and profile wiring: the sweep must clean it too.
  const codexHome2 = join(dir, ".codex-farm");
  configureCodexConfig(codexHome2, {
    mode: "proxy",
    quiet: true,
    baseUrl: "http://127.0.0.1:4199/v1",
  });
  configureCodexConfig(codexHome2, { mode: "direct", quiet: true, profile: WORK });

  const deps = tmpDeps(codexHome);
  deps.codexHomes = [codexHome, codexHome2];
  await runUninstall({ yes: true }, deps);
  // Bun leaves exitCode undefined until someone sets it; a clean run sets nothing.
  expect(process.exitCode ?? 0).toBe(0);

  // Named profile artifacts gone.
  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(false);
  expect(existsSync(profileHome(WORK))).toBe(false);

  // Claude: managed keys stripped, user key survives, helper scripts gone.
  const settings = JSON.parse(readFileSync(settingsPathFor(claudeHome), "utf8")) as Record<
    string,
    unknown
  >;
  expect(settings.apiKeyHelper).toBeUndefined();
  expect(settings.env).toBeUndefined();
  // The MCP + WebSearch-deny pair the direct wiring added is fully taken back.
  expect(settings.permissions).toBeUndefined();
  expect(
    (JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>).mcpServers,
  ).toBeUndefined();
  expect(settings.model).toBe("opus");
  expect(existsSync(join(claudeHome, DIRECT_HELPER_NAME))).toBe(false);
  expect(existsSync(join(claudeHome, PROXY_HELPER_NAME))).toBe(false);

  // Codex: our selector + tables gone from BOTH homes, the user's key and
  // provider table survive.
  for (const home of [codexHome, codexHome2]) {
    const swept = readToml(home);
    expect(swept.model_provider).toBeUndefined();
    expect(swept.web_search).toBeUndefined();
    expect(swept.profiles).toBeUndefined();
    const sweptProviders = isRecord(swept.model_providers) ? swept.model_providers : {};
    expect(sweptProviders["copilot-env"]).toBeUndefined();
    expect(sweptProviders["copilot-env-work"]).toBeUndefined();
  }
  const doc = readToml(codexHome);
  const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
  expect(isRecord(providers.mine)).toBe(true);
  expect(doc.foo).toBe("bar");

  // The whole copilot-api home (store, run state, profile homes) is gone, and the
  // injected side-effect seams both ran. The dev checkout survives (.git guard).
  expect(existsSync(proxyHome)).toBe(false);
  expect(deps.calls).toEqual(["farm", "shell"]);
  expect(existsSync(join(import.meta.dir, "..", "package.json"))).toBe(true);
});

test("uninstall leaves foreign Claude/Codex wiring untouched", async () => {
  const { claudeHome, codexHome } = tmpHomes();
  mkdirSync(claudeHome, { recursive: true });
  const settingsText = JSON.stringify({
    apiKeyHelper: "/usr/local/bin/my-helper",
    env: { ANTHROPIC_BASE_URL: "https://my-gateway.test" },
  });
  writeFileSync(settingsPathFor(claudeHome), settingsText);
  mkdirSync(codexHome, { recursive: true });
  const tomlText = ['model_provider = "openai"', 'web_search = "live"', ""].join("\n");
  writeFileSync(join(codexHome, "config.toml"), tomlText);

  await runUninstall({ yes: true }, tmpDeps(codexHome));

  expect(readFileSync(settingsPathFor(claudeHome), "utf8")).toBe(settingsText);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(tomlText);
});

test("uninstall is idempotent: a second run finds nothing and exits 0", async () => {
  const { codexHome } = tmpHomes();
  const deps = tmpDeps(codexHome);
  await runUninstall({ yes: true }, deps);
  await runUninstall({ yes: true }, deps);
  expect(process.exitCode ?? 0).toBe(0);
});

test("uninstall without --yes on a non-TTY refuses and deletes nothing", async () => {
  const { proxyHome, claudeHome, codexHome } = tmpHomes();
  mkdirSync(claudeHome, { recursive: true });
  configureClaudeConfig(claudeHome, "direct", { quiet: true });
  new Credential().store("gh-token", "ghp_default");

  // bun test's stdin is not a TTY, so the guard fires before the prompt.
  await expect(runUninstall({}, tmpDeps(codexHome))).rejects.toThrow(/--yes/);
  expect(existsSync(settingsPathFor(claudeHome))).toBe(true);
  expect(existsSync(proxyHome)).toBe(true);
});

test("uninstall --dry-run changes nothing", async () => {
  const { proxyHome, claudeHome, codexHome } = tmpHomes();
  mkdirSync(claudeHome, { recursive: true });
  configureClaudeConfig(claudeHome, "direct", { quiet: true });
  configureCodexConfig(codexHome, {
    mode: "proxy",
    quiet: true,
    baseUrl: "http://127.0.0.1:4199/v1",
  });
  new Credential().store("gh-token", "ghp_default");

  const deps = tmpDeps(codexHome);
  await runUninstall({ dryRun: true }, deps);

  expect(existsSync(settingsPathFor(claudeHome))).toBe(true);
  expect(existsSync(join(claudeHome, DIRECT_HELPER_NAME))).toBe(true);
  expect(readToml(codexHome).model_provider).toBe("copilot-env");
  expect(new Credential().resolve()).toBe("ghp_default");
  expect(existsSync(proxyHome)).toBe(true);
  expect(deps.calls).toEqual([]);
});

test("uninstall scrubs the legacy .env token but never OPENAI_API_KEY", async () => {
  const { codexHome } = tmpHomes();
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, ".env"), "COPILOT_ENV_GH_TOKEN=ghp_x\nOPENAI_API_KEY=user-key\n");

  await runUninstall({ yes: true }, tmpDeps(codexHome));

  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe("OPENAI_API_KEY=user-key\n");
});

test.skipIf(process.platform === "win32")(
  "uninstall removes only the run-state-recorded codex farm, never an untracked dir",
  async () => {
    const { codexHome } = tmpHomes();
    const farm = join(dir, "farm");
    const untracked = join(dir, "untracked-farm");
    mkdirSync(farm, { recursive: true });
    mkdirSync(untracked, { recursive: true });
    new CopilotEnvRunState().set({ codexHome: farm });

    // No farm seam: exercise the real implementation (it reads the redirected
    // run state, so it is test-safe on POSIX).
    const deps = tmpDeps(codexHome);
    delete deps.removeCodexHostFarm;
    await runUninstall({ yes: true }, deps);

    expect(existsSync(farm)).toBe(false);
    expect(existsSync(untracked)).toBe(true);
  },
);
