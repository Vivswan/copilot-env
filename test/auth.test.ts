import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { runAuth } from "../src/commands/auth.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";

const SAVED = {
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  COPILOT_API_HOME: process.env.COPILOT_API_HOME,
  GH_TOKEN: process.env.GH_TOKEN,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  // COPILOT_GITHUB_TOKEN is FIRST in the gh-token env precedence (GH_TOKEN_ENV_VARS); save it so
  // a runner that exports it can't leak into the "no token" tests and silently make them pass.
  COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
};
let dir = "";

function restore(key: keyof typeof SAVED): void {
  if (SAVED[key] === undefined) delete process.env[key];
  else process.env[key] = SAVED[key];
}

afterEach(() => {
  for (const k of Object.keys(SAVED) as (keyof typeof SAVED)[]) restore(k);
  process.exitCode = 0; // NOT undefined -- bun keeps the last value otherwise (leaks exit 1)
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

// Isolate every store/config write under temp homes so tests never touch real state.
function isolate(): { claudeHome: string } {
  dir = mkdtempSync(join(tmpdir(), "copilot-auth-"));
  process.env.COPILOT_API_HOME = join(dir, "proxy-home");
  process.env.HOME = dir;
  process.env.CODEX_HOME = join(dir, ".codex");
  // Clear an inherited COPILOT_GITHUB_TOKEN so a real one in the runner env can't satisfy the
  // "no credential" paths (afterEach restores it). GH_TOKEN/GITHUB_TOKEN are set per-test.
  delete process.env.COPILOT_GITHUB_TOKEN;
  const claudeHome = join(dir, ".claude");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  return { claudeHome };
}

function state(): CopilotEnvState {
  return new CopilotEnvState();
}

/** Capture process.stdout.write output while awaiting `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

/** Capture console.log output while awaiting `fn`. */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return out;
}

test("auth: --get / --del / --check are mutually exclusive", async () => {
  await expect(runAuth({ get: true, del: true })).rejects.toThrow("mutually exclusive");
  await expect(runAuth({ get: true, check: true })).rejects.toThrow("mutually exclusive");
});

test("auth: --provider rejects unknown values", async () => {
  await expect(runAuth({ provider: "bogus" })).rejects.toThrow("--provider must be one of");
});

test("auth --get prints the stored token to stdout (nothing else)", async () => {
  isolate();
  state().set({ githubToken: "ghu_stored123", authProvider: "gh-token" });
  const out = await captureStdout(() => runAuth({ get: true }, NOOP_CATALOG_DEPS));
  expect(out).toBe("ghu_stored123\n");
});

test("auth --del clears the stored token and provider", async () => {
  isolate();
  state().set({ githubToken: "ghu_stored123", authProvider: "gh-token" });
  await runAuth({ del: true });
  expect(state().read()).toEqual({
    githubToken: null,
    authProvider: null,
    codexCatalogLastAttemptMs: 0,
    codexCatalogCodexVersion: null,
  });
});

test("auth --check: a configured provider reports authenticated, exit 0", async () => {
  isolate();
  state().set({ githubToken: "ghu_stored123", authProvider: "gh-token" });
  const out = await captureLog(() => runAuth({ check: true }));
  expect(out).toContain("authenticated (gh-token)");
  expect(process.exitCode).toBe(0);
});

test("auth (bare) is idempotent on a RECORDED provider — no re-auth, no config writes", async () => {
  const { claudeHome } = isolate();
  state().set({ githubToken: "ghu_stored123", authProvider: "copilot" });
  // A recorded provider => runAuth returns WITHOUT prompting, acquiring, or configuring.
  await runAuth({});
  expect(state().read().githubToken).toBe("ghu_stored123");
  // auth never configures agents, so no Claude settings.json was written.
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
});

test("auth (bare) with NO recorded provider re-runs the flow even when gh works (no idempotency loop)", async () => {
  isolate();
  // No stored token and no recorded provider. Idempotency must key on the RECORDED
  // choice, not on whether `gh` happens to work -- otherwise a machine with a gh
  // login could never reach a fresh login (and --del would clear nothing). With no
  // recorded provider, bare auth runs the flow: interactive choice, which throws
  // here because the test env is non-TTY (proving it did NOT short-circuit on gh).
  await expect(runAuth({})).rejects.toThrow("not a terminal");
});

test("auth --provider gh-token: missing GH_TOKEN/GITHUB_TOKEN errors clearly", async () => {
  isolate();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  state().set({ githubToken: null });
  await expect(runAuth({ provider: "gh-token" })).rejects.toThrow(/GH_TOKEN|GITHUB_TOKEN/);
});

test("auth --provider gh-token stores the env token + provider, and does NOT configure agents", async () => {
  const { claudeHome } = isolate();
  state().set({ githubToken: "ghu_old" });
  process.env.GH_TOKEN = "ghu_new_from_env";
  // An explicit provider always runs (not short-circuited by "already authenticated").
  await runAuth({ provider: "gh-token" });
  expect(state().read()).toEqual({
    githubToken: "ghu_new_from_env",
    authProvider: "gh-token",
    codexCatalogLastAttemptMs: 0,
    codexCatalogCodexVersion: null,
  });
  // auth only manages the credential -- configuring Codex/Claude is `agent init`'s job.
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
});

test("auth --set <token> stores it verbatim (no env, no UI) and records gh-token", async () => {
  isolate();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  await runAuth({ set: "ghu_inline_value" });
  expect(state().read()).toEqual({
    githubToken: "ghu_inline_value",
    authProvider: "gh-token",
    codexCatalogLastAttemptMs: 0,
    codexCatalogCodexVersion: null,
  });
});

test("auth --set rejects a conflicting --provider", async () => {
  isolate();
  await expect(runAuth({ set: "ghu_x", provider: "copilot" })).rejects.toThrow(
    "--set only applies to `--provider gh-token`",
  );
});

test("auth --set cannot combine with --get/--del/--check", async () => {
  isolate();
  await expect(runAuth({ set: "ghu_x", get: true })).rejects.toThrow("cannot combine");
});

test("auth --get stdout stays EXACTLY the token even when the catalog refresh runs", async () => {
  isolate();
  state().set({ githubToken: "ghu_stored123", authProvider: "gh-token" });
  const out = await captureStdout(() =>
    runAuth(
      { get: true },
      {
        nowMs: () => 1_700_000_000_000,
        codexVersion: () => null, // lastAttemptMs 0 => due, so the refresh really runs
        bundledCatalog: () => '{"models":[{"slug":"gpt-5.5","context_window":272000}]}',
        fetchLimits: async () =>
          new Map([["gpt-5.5", { maxContextWindowTokens: 1_050_000, maxPromptTokens: 922_000 }]]),
      },
    ),
  );
  expect(out).toBe("ghu_stored123\n");
});

test("auth --get succeeds (exit 0) even when the catalog refresh blows up", async () => {
  isolate();
  state().set({ githubToken: "ghu_stored123", authProvider: "gh-token" });
  const out = await captureStdout(() =>
    runAuth(
      { get: true },
      {
        nowMs: () => 1_700_000_000_000,
        codexVersion: () => null,
        bundledCatalog: () => {
          throw new Error("spawn exploded");
        },
        fetchLimits: async () => {
          throw new Error("network exploded");
        },
      },
    ),
  );
  expect(out).toBe("ghu_stored123\n");
  expect(process.exitCode).toBe(0);
});

test("auth --print-proxy-token stdout stays EXACTLY the key even when the refresh runs", async () => {
  isolate();
  const first = await captureStdout(() =>
    runAuth(
      { printProxyToken: true },
      {
        nowMs: () => 1_700_000_000_000,
        codexVersion: () => null, // due => the refresh really runs (and fails, harmlessly)
        bundledCatalog: () => null,
        fetchLimits: async () => {
          throw new Error("proxy exploded");
        },
      },
    ),
  );
  // ensureApiKey generates a stable 64-char hex key on first use; the line is the
  // ENTIRE stdout, refresh failure or not.
  expect(first).toMatch(/^[0-9a-f]{64}\n$/);
  expect(process.exitCode).toBe(0);
});
