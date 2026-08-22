// `agent uninstall`: the full-teardown command. Every run injects the deps seam
// (install root + codexHomes + farm + shell removal) so `deno test` never touches
// the real ~/.codex, the host farm, or the shell rc files -- and the install root
// it deletes is a sandbox directory, never the tree this process runs from.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
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
import type { RootMode } from "../src/utils/root.ts";
import { ROOT } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, removeDir, resetExitCode } from "./helpers.ts";

// A branded fixture name: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");

const restoreEnv = envSnapshot();
let dir = "";

// The delete step chdir's out of the doomed directory; every other test file that
// reads a cwd-relative path would inherit that move, so put it back.
const startCwd = process.cwd();

afterEach(() => {
  restoreEnv();
  process.chdir(startCwd);
  // An aborted run's exit 1 must never leak into the whole `deno test` run.
  resetExitCode();
  dir = removeDir(dir);
});

/** Isolated homes for one test: proxy home + Claude home + Codex home. */
function tmpHomes(): { proxyHome: string; claudeHome: string; codexHome: string } {
  const homes = isolateAgentHomes("copilot-uninstall-");
  dir = homes.dir;
  return homes;
}

/**
 * A sandbox stand-in for the install root, shaped like what the installers build
 * (`<root>/bin/agent-bin`). `kind: "compiled"` means the delete step treats it as an
 * installed binary root and REALLY removes it -- the production code path, run
 * against a temp directory instead of the tree under test.
 */
function sandboxRoot(kind: RootMode["kind"] = "compiled"): RootMode {
  if (dir === "") throw new Error("call tmpHomes() first: sandboxRoot needs the per-test tmp dir");
  const root = join(dir, "install-root");
  // Carry the marker layout looksLikeInstallRoot() requires, so the delete step sees a
  // root shaped like a real one rather than being turned away by the safety guard.
  for (const marker of ["bin", "shell", join("src", "scripts")]) {
    mkdirSync(join(root, marker), { recursive: true });
  }
  writeFileSync(join(root, "bin", "agent-bin"), "#!/bin/sh\n");
  return { kind, root };
}

/** The injected seam every test run passes: real codex home, spied side effects. */
function tmpDeps(codexHome: string): UninstallDeps & { calls: string[]; installRoot: RootMode } {
  const calls: string[] = [];
  return {
    calls,
    codexHomes: [codexHome],
    installRoot: sandboxRoot(),
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
  // exitCode stays undefined until someone sets it; a clean run sets nothing.
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
  // injected side-effect seams both ran. The install root deleted is the injected
  // sandbox; the tree this process runs from is untouched.
  expect(existsSync(proxyHome)).toBe(false);
  expect(deps.calls).toEqual(["farm", "shell"]);
  expect(existsSync(deps.installRoot.root)).toBe(false);
  expect(existsSync(join(ROOT, "package.json"))).toBe(true);
});

test("uninstall leaves a source-checkout root in place without --force", async () => {
  const { codexHome } = tmpHomes();
  const deps = tmpDeps(codexHome);
  deps.installRoot = sandboxRoot("checkout");

  await runUninstall({ yes: true }, deps);

  // Protection follows the injected RootMode's kind, not any ambient .git probe:
  // nothing was created or removed inside the sandbox to make it look like a clone.
  expect(existsSync(deps.installRoot.root)).toBe(true);
  expect(existsSync(join(deps.installRoot.root, ".git"))).toBe(false);
});

test("uninstall --force deletes a source-checkout root", async () => {
  const { codexHome } = tmpHomes();
  const deps = tmpDeps(codexHome);
  deps.installRoot = sandboxRoot("checkout");

  await runUninstall({ yes: true, force: true }, deps);

  expect(existsSync(deps.installRoot.root)).toBe(false);
});

test("uninstall refuses a root that does not look like a copilot-env install", async () => {
  const { codexHome } = tmpHomes();
  const deps = tmpDeps(codexHome);
  // A compiled binary dropped in ~/.local/bin resolves its root to ~/.local: unprotected
  // by kind, but not ours to delete. Only `bin` is present, none of the other markers.
  const stray = join(dir, "stray-root");
  mkdirSync(join(stray, "bin"), { recursive: true });
  deps.installRoot = { kind: "compiled", root: stray };

  await runUninstall({ yes: true }, deps);

  expect(existsSync(stray)).toBe(true);
  expect(process.exitCode).toBe(1);
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

  // the test runner's stdin is not a TTY, so the guard fires before the prompt.
  await expect(runUninstall({}, tmpDeps(codexHome))).rejects.toThrow(/--yes/);
  expect(existsSync(settingsPathFor(claudeHome))).toBe(true);
  expect(existsSync(proxyHome)).toBe(true);
});

test("uninstall --dry-run changes nothing and narrates every step", async () => {
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
  // Capture the narration: the registry must describe EVERY execution step,
  // including the two that were once missing (the drift this guards against).
  const written: string[] = [];
  const savedLevel = consola.level;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array) => {
    written.push(String(s));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array) => {
    written.push(String(s));
    return true;
  };
  try {
    consola.level = 3; // ensure info is not self-silenced under the test runner
    await runUninstall({ dryRun: true }, deps);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    consola.level = savedLevel;
  }
  const narration = written.join("");
  expect(narration).toContain("Would stop the default proxy daemon");
  expect(narration).toContain("Would remove the copilot-env MCP registration");
  expect(narration).toContain("Would stop any proxy daemon relaunched in the meantime");
  expect(narration).toContain(`Would delete the copilot-api home: ${proxyHome}`);
  expect(narration).toContain(`Would delete the install directory: ${deps.installRoot.root}`);

  expect(existsSync(deps.installRoot.root)).toBe(true);
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

test.skipIf(process.platform === "win32")(
  "uninstall --dry-run narrates the codex host-farm delete and leaves the farm alone",
  async () => {
    const { codexHome } = tmpHomes();
    const farm = join(dir, "farm");
    mkdirSync(farm, { recursive: true });
    new CopilotEnvRunState().set({ codexHome: farm });

    // No farm seam, so the narration reflects the REAL removal it describes.
    const deps = tmpDeps(codexHome);
    delete deps.removeCodexHostFarm;
    const written: string[] = [];
    const savedLevel = consola.level;
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s: string | Uint8Array) => {
      written.push(String(s));
      return true;
    };
    process.stderr.write = (s: string | Uint8Array) => {
      written.push(String(s));
      return true;
    };
    try {
      consola.level = 3;
      await runUninstall({ dryRun: true }, deps);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      consola.level = savedLevel;
    }

    expect(written.join("")).toContain(`Would delete the CODEX_HOME host farm: ${farm}`);
    expect(existsSync(farm)).toBe(true);
  },
);
