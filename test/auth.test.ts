import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { loginWithGhCli, runAuth } from "../src/commands/auth.ts";
import { ghTokenLookFromSpawn } from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { assertProfileSlot, CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths, profileHome } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { errMessage } from "../src/utils/error.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  isolateAgentHomes,
  removeDir,
  resetExitCode,
  stageRefusedStop,
} from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
  dir = removeDir(dir);
});

// Isolate every store/config write under temp homes so tests never touch real state.
// isolateAgentHomes also clears an inherited COPILOT_GITHUB_TOKEN (FIRST in the gh-token
// env precedence) so a real one in the runner env can't satisfy the "no credential"
// paths; GH_TOKEN/GITHUB_TOKEN are set per-test.
function isolate(): { claudeHome: string } {
  const homes = isolateAgentHomes("copilot-auth-");
  dir = homes.dir;
  return { claudeHome: homes.claudeHome };
}

function state(): CopilotEnvState {
  return new CopilotEnvState();
}

// The catalog is opt-in (default false); the refresh-path tests flip it on so
// the auth-time refresh really runs.
function enableCatalog(): void {
  new CopilotEnvConfig().set({ codexModelCatalog: true });
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
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_stored123" });
  const out = await captureStdout(() => runAuth({ get: true }, NOOP_CATALOG_DEPS));
  expect(out).toBe("ghu_stored123\n");
});

test(
  "auth --del: a REFUSED stop warns the proxy is still running -- never the plain success",
  async () => {
    isolate();
    state().setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_refused" });
    const fx = stageRefusedStop(new CopilotApiPaths().home);
    try {
      // The credential clears, but the daemon (whose lock-held pid this host cannot
      // corroborate) was refused: the summary must say it may still be serving, never
      // the plain "De-authenticated." success.
      const err = await captureStderr(() => runAuth({ del: true }));
      expect(err).toContain("but the proxy is still running");
      expect(err).not.toContain("De-authenticated. Run");
    } finally {
      await fx.teardown();
    }
  },
  30_000,
);

test("auth --del clears the stored token and provider", async () => {
  isolate();
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_stored123" });
  await runAuth({ del: true });
  expect(state().read()).toEqual({
    githubToken: null,
    authProvider: null,
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogPatchVersion: 0,
    claudeModelVerdicts: {},
    codexCatalogCodexVersion: null,
  });
});

test("auth --check: a configured provider reports authenticated, exit 0", async () => {
  isolate();
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_stored123" });
  const out = await captureLog(() => runAuth({ check: true }));
  // Exit 0 is the machine "authenticated" contract; the status line is human
  // copy, so pin only the parenthesized provider identifier it must name (the
  // parens keep a longer provider name like "gh-token-file" from matching).
  expect(out).toContain("(gh-token)");
  expect(process.exitCode).toBe(0);
});

test("auth (bare) is idempotent on a RECORDED provider - no re-auth, no config writes", async () => {
  const { claudeHome } = isolate();
  state().setCredential(null, { kind: "stored", provider: "copilot", token: "ghu_stored123" });
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
  state().clearCredential(null);
  await expect(runAuth({ provider: "gh-token" })).rejects.toThrow(/GH_TOKEN|GITHUB_TOKEN/);
});

test("auth --provider gh-token stores the env token + provider, and does NOT configure agents", async () => {
  const { claudeHome } = isolate();
  // A recorded, RESOLVING credential under another provider: an explicit
  // provider must still run (never short-circuited by "already authenticated").
  state().setCredential(null, { kind: "stored", provider: "copilot", token: "ghu_old" });
  process.env.GH_TOKEN = "ghu_new_from_env";
  await runAuth({ provider: "gh-token" });
  expect(state().read()).toEqual({
    githubToken: "ghu_new_from_env",
    authProvider: "gh-token",
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogPatchVersion: 0,
    claudeModelVerdicts: {},
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
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogPatchVersion: 0,
    claudeModelVerdicts: {},
    codexCatalogCodexVersion: null,
  });
});

test("auth --set rejects a conflicting --provider", async () => {
  isolate();
  await expect(runAuth({ set: "ghu_x", provider: "copilot" })).rejects.toThrow(
    "--set only applies to `--provider gh-token`",
  );
});

test("auth --profile <unknown> errors instead of creating a half profile", async () => {
  isolate();
  // The old behavior wrote a credential-only half profile into the store; a
  // profile is created ONLY by `agent profile --add`'s atomic commit, so the
  // re-auth path refuses an unknown name -- BEFORE any acquisition runs.
  await expect(runAuth({ set: "ghu_x", profile: "ghost" })).rejects.toThrow(
    /no such profile 'ghost'/,
  );
  expect(state().read().profiles).toEqual({});

  // An existing profile's re-auth still lands in ITS slot only.
  const ghost = parseProfileName("ghost");
  state().commitProfile(ghost, {
    credential: { kind: "stored", provider: "gh-token", token: "ghu_old" },
    mode: "direct",
  });
  await runAuth({ set: "ghu_new", profile: "ghost" });
  expect(new CopilotEnvState().readProfileSlot(ghost).credential).toEqual({
    kind: "stored",
    provider: "gh-token",
    token: "ghu_new",
  });
  expect(state().read().githubToken).toBeNull(); // default slot untouched
});

test("auth --set cannot combine with --get/--del/--check", async () => {
  isolate();
  await expect(runAuth({ set: "ghu_x", get: true })).rejects.toThrow("cannot combine");
});

test("gh-token acquisition narrates 'Using', never 'Stored' (persistence is the caller's write)", async () => {
  isolate();
  // The token is only ACQUIRED here -- `agent profile --add` commits it later,
  // atomically with the profile's mode, so a "Stored" claim at this point would
  // be false on that path (and premature even on the plain auth path).
  const inline = await captureStderr(() => runAuth({ set: "ghu_inline_value" }));
  expect(inline).toContain("Using the provided GitHub token.");
  expect(inline).not.toContain("Stored");
  process.env.GH_TOKEN = "ghu_env_value";
  const fromEnv = await captureStderr(() => runAuth({ provider: "gh-token" }));
  expect(fromEnv).toContain("Using the GitHub token from the environment.");
  expect(fromEnv).not.toContain("Stored");
});

test("auth --get/--del/--check on a NONEXISTENT profile hint at `agent profile --add`", async () => {
  isolate();
  // `agent auth --profile` refuses a name with no store slot (creation belongs
  // to `agent profile --add` alone), so recommending a re-auth here would just
  // hit that gate -- the hint reuses the store's no-such-profile phrasing.
  // Asserted without backticks: consola renders code spans, stripping them.
  const addHint = "no such profile 'ghost' - create it with ";
  const addCommand = "agent profile --add ghost --direct|--proxy";
  const got = await captureStderr(() => runAuth({ get: true, profile: "ghost" }));
  expect(got).toContain(addHint);
  expect(got).toContain(addCommand);
  expect(got).not.toContain("agent auth --profile");
  expect(process.exitCode).toBe(1);
  resetExitCode();
  const deleted = await captureStderr(() => runAuth({ del: true, profile: "ghost" }));
  expect(deleted).toContain("Nothing to clear");
  expect(deleted).toContain(addCommand);
  const checked = await captureLog(() => runAuth({ check: true, profile: "ghost" }));
  expect(checked).toContain(addHint);
  expect(checked).toContain(addCommand);
  expect(process.exitCode).toBe(1);
  resetExitCode();

  // An EXISTING slot (here partial: de-authed, mode kept) re-auths in place, so
  // the hint stays `agent auth --profile`.
  const ghost = parseProfileName("ghost");
  state().commitProfile(ghost, {
    credential: { kind: "stored", provider: "gh-token", token: "ghu_old" },
    mode: "direct",
  });
  state().clearCredential(ghost);
  const gotExisting = await captureStderr(() => runAuth({ get: true, profile: "ghost" }));
  expect(gotExisting).toContain("agent auth --profile ghost");
  expect(gotExisting).not.toContain("profile --add");
  const deletedExisting = await captureStderr(() => runAuth({ del: true, profile: "ghost" }));
  expect(deletedExisting).toContain("Nothing to clear for profile 'ghost'");
  expect(deletedExisting).toContain("agent auth --profile ghost");
  expect(deletedExisting).not.toContain("profile --add");
  const checkedExisting = await captureLog(() => runAuth({ check: true, profile: "ghost" }));
  expect(checkedExisting).toContain("run `agent auth --profile ghost`");
});

test("auth --get/--del/--check on a HALF-CREATED profile reuse the store's missing-slot phrasing", async () => {
  isolate();
  // A daemon home without a store slot (an interrupted add): the store's write
  // gate (missingProfileSlotError via assertProfileSlot) words this as
  // "half-created", so the read-back hints must say the same instead of
  // claiming "no such profile". The repair command stays the atomic re-add.
  const ghost = parseProfileName("ghost");
  mkdirSync(profileHome(ghost), { recursive: true });
  const phrase = "profile 'ghost' has no store slot (half-created; its daemon home exists)";
  const addCommand = "agent profile --add ghost --direct|--proxy";
  // Alignment pin: the store's own gate renders the same phrase + command, so a
  // rewording on either side fails here.
  let storeMessage = "";
  try {
    assertProfileSlot(ghost);
  } catch (e) {
    storeMessage = errMessage(e);
  }
  expect(storeMessage).toContain(phrase);
  expect(storeMessage).toContain(addCommand);

  const got = await captureStderr(() => runAuth({ get: true, profile: "ghost" }));
  expect(got).toContain(phrase);
  expect(got).toContain(addCommand);
  expect(got).not.toContain("no such profile");
  expect(process.exitCode).toBe(1);
  resetExitCode();
  const deleted = await captureStderr(() => runAuth({ del: true, profile: "ghost" }));
  expect(deleted).toContain("Nothing to clear");
  expect(deleted).toContain(phrase);
  expect(deleted).toContain(addCommand);
  const checked = await captureLog(() => runAuth({ check: true, profile: "ghost" }));
  // --check prints the raw hint (console.log, no consola rendering), so the
  // WHOLE store message pins verbatim -- byte-level drift fails here.
  expect(checked).toContain(storeMessage);
  expect(process.exitCode).toBe(1);
  resetExitCode();
});

test("auth: --provider cannot combine with a sub-action (never silently dropped)", async () => {
  isolate();
  // `--get --provider bogus` used to run --get and drop the provider without
  // ever validating it; the boundary parse now rejects the combination.
  for (
    const args of [
      { get: true, provider: "bogus" },
      { del: true, provider: "copilot" },
      { check: true, provider: "gh-cli" },
      { printProxyToken: true, provider: "gh-token" },
      { list: true, provider: "copilot" },
    ]
  ) {
    await expect(runAuth(args)).rejects.toThrow(
      "--provider selects how to authenticate and cannot combine with " +
        "--get/--del/--check/--list/--print-proxy-token",
    );
  }
  // Pre-existing rejections keep their precedence over the new conflict: the
  // --list/--profile error and an invalid profile name still report themselves.
  await expect(runAuth({ list: true, profile: "work", provider: "copilot" })).rejects.toThrow(
    "--list reports every profile; it does not combine with --profile",
  );
  await expect(runAuth({ get: true, profile: "NOT valid", provider: "copilot" })).rejects.toThrow(
    /invalid profile name/,
  );
});

test("auth --get stdout stays EXACTLY the token even when the catalog refresh runs", async () => {
  isolate();
  enableCatalog();
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_stored123" });
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
    )
  );
  expect(out).toBe("ghu_stored123\n");
});

test("auth --get succeeds (exit 0) even when the catalog refresh blows up", async () => {
  isolate();
  enableCatalog();
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_stored123" });
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
    )
  );
  expect(out).toBe("ghu_stored123\n");
  expect(process.exitCode).toBe(0);
});

test("auth --print-proxy-token stdout stays EXACTLY the key even when the refresh runs", async () => {
  isolate();
  enableCatalog();
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
    )
  );
  // ensureApiKey generates a stable 64-char hex key on first use; the line is the
  // ENTIRE stdout, refresh failure or not.
  expect(first).toMatch(/^[0-9a-f]{64}\n$/);
  expect(process.exitCode).toBe(0);
});

test("disabled: auth --get removes the catalog artifacts and stdout stays EXACTLY the token", async () => {
  isolate();
  // Opt-in NOT set: pre-seed the artifacts a pre-opt-in release left behind.
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "proxy-home"), { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  writeFileSync(
    join(codexHome, "config.toml"),
    // stringify, not a hand-written template: a raw Windows path inside a TOML
    // basic string reads as escape sequences.
    stringify({ "model_provider": "copilot-env", "model_catalog_json": catalogFile }),
  );
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_stored123" });
  state().set({
    codexCatalogLastAttemptMs: 123,
    codexCatalogCodexVersion: "1.0.0",
    codexCatalogPatchVersion: 2,
  });

  const out = await captureStdout(() => runAuth({ get: true }, NOOP_CATALOG_DEPS));

  expect(out).toBe("ghu_stored123\n");
  expect(process.exitCode).toBe(0);
  const doc = parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(doc.model_catalog_json).toBeUndefined();
  expect(existsSync(catalogFile)).toBe(false);
  expect(state().read().codexCatalogLastAttemptMs).toBe(0);
  expect(state().read().codexCatalogCodexVersion).toBeNull();
  expect(state().read().codexCatalogPatchVersion).toBe(0);
});

test("disabled: auth --print-proxy-token runs the same cleanup", async () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "proxy-home"), { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  writeFileSync(join(codexHome, "config.toml"), stringify({ "model_catalog_json": catalogFile }));

  const out = await captureStdout(() => runAuth({ printProxyToken: true }, NOOP_CATALOG_DEPS));

  expect(out).toMatch(/^[0-9a-f]{64}\n$/);
  const doc = parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(doc.model_catalog_json).toBeUndefined();
  expect(existsSync(catalogFile)).toBe(false);
});

// --- gh-cli verify gate (failed-probe honesty) --------------------------------

test("ghTokenLookFromSpawn: completed exits prove, a dead spawn stays unproven", () => {
  // Exit 0 with a token: the one proven-token arm.
  expect(ghTokenLookFromSpawn({ status: 0, stdout: " tok \n" })).toEqual({ token: "tok" });
  // gh RAN: empty output on exit 0 and a nonzero exit are both proven misses.
  expect(ghTokenLookFromSpawn({ status: 0, stdout: "" })).toEqual({ token: null });
  expect(ghTokenLookFromSpawn({ status: 1, stdout: "" })).toEqual({ token: null });
  // The spawn never completed (timeout kill / spawn error): proven NOTHING.
  expect(ghTokenLookFromSpawn({ status: null })).toEqual({ token: null, unproven: true });
  expect(ghTokenLookFromSpawn({ status: 1, error: new Error("ETIMEDOUT"), stdout: "" }))
    .toEqual({ token: null, unproven: true });
});

test("loginWithGhCli: an UNPROVEN look says could-not-check; a proven miss keeps the gh advice", () => {
  expect(() => loginWithGhCli(() => ({ token: null, unproven: true }))).toThrow(
    "could not check gh authentication (`gh auth token` did not run to completion) - retry `agent auth`",
  );
  expect(() => loginWithGhCli(() => ({ token: null }))).toThrow(
    "gh is not authenticated - run `gh auth login`, then retry `agent auth`",
  );
  expect(() => loginWithGhCli(() => ({ token: "tok" }))).not.toThrow();
});
