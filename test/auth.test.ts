import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import {
  chooseGhAccount,
  credentialSourceLabel,
  loginWithGhCli,
  parseAcquisition,
  parseAuthAction,
  runAuth,
} from "../src/commands/auth.ts";
import {
  Credential,
  ghAccountsLookFromSpawn,
  ghTokenLookFromSpawn,
} from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { assertProfileSlot, CopilotEnvState } from "../src/copilot_api/env_state.ts";
import {
  type GhAccount,
  ghAccountPinnable,
  ghAuthStatusSpawnSpec,
  ghAuthTokenSpawnSpec,
  parseGhAuthStatusAccounts,
} from "../src/copilot_api/gh_cli.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  INTEGRATION_ID_HEADER,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { CopilotApiPaths, profileHome } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { errMessage } from "../src/utils/error.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, resetExitCode, stageRefusedStop } from "./helpers.ts";

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
    ghUser: null,
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogPatchVersion: 0,
    codexCatalogAccepted: null,
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
    ghUser: null,
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogPatchVersion: 0,
    codexCatalogAccepted: null,
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
    ghUser: null,
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogPatchVersion: 0,
    codexCatalogAccepted: null,
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
        fetchCopilotModels: async () =>
          new Map([["gpt-5.5", {
            limits: { maxContextWindowTokens: 1_050_000, maxPromptTokens: 922_000 },
            name: "GPT-5.5",
            reasoningEfforts: null,
            parallelToolCalls: null,
            codexServable: true,
          }]]),
        acceptsCatalog: () => true,
      },
    )
  );
  expect(out).toBe("ghu_stored123\n");
});

test("auth --get with a PAT keeps stdout to the token while the due refresh probes an alternate identity", async () => {
  isolate();
  enableCatalog();
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "github_pat_x" });
  // Copilot's /models accepts the PAT only under the CLI identity: the production
  // fetch probes, settles on it, and narrates the non-default choice.
  const respond = (init?: RequestInit): Response =>
    new Headers(init?.headers).get(INTEGRATION_ID_HEADER) === COPILOT_CLI_INTEGRATION_ID
      ? new Response(
        JSON.stringify({
          data: [{
            id: "gpt-5.5",
            capabilities: {
              limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 922_000 },
            },
          }],
        }),
        { status: 200 },
      )
      : new Response("PATs not supported", { status: 400 });
  setIntegrationProbeFetch((_input, init) => Promise.resolve(respond(init)));
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    ((_input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(respond(init))) as typeof fetch;
  let narrated = "";
  let out = "";
  try {
    out = await captureStdout(async () => {
      narrated = await captureStderr(() =>
        runAuth({ get: true }, {
          nowMs: () => 1_700_000_000_000, // lastAttemptMs 0 => due
          codexVersion: () => "1.0.0",
          bundledCatalog: () => '{"models":[{"slug":"gpt-5.5","context_window":272000}]}',
          acceptsCatalog: () => true,
        })
      );
    });
  } finally {
    globalThis.fetch = realFetch;
    setIntegrationProbeFetch(null);
  }
  expect(out).toBe("github_pat_x\n");
  expect(narrated).toContain(`Copilot integration identity: ${COPILOT_CLI_INTEGRATION_ID}`);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(true);
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
        fetchCopilotModels: async () => {
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
        fetchCopilotModels: async () => {
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
  expect(() => loginWithGhCli(null, () => ({ token: null, unproven: true }))).toThrow(
    "could not check gh authentication (`gh auth token` did not run to completion) - retry `agent auth`",
  );
  expect(() => loginWithGhCli(null, () => ({ token: null }))).toThrow(
    "gh is not authenticated - run `gh auth login`, then retry `agent auth`",
  );
  expect(() => loginWithGhCli(null, () => ({ token: "tok" }))).not.toThrow();
  // A pinned account wears its own words: the miss is about THAT account (gh's
  // active login may well be fine), and the look receives the pin to verify.
  const asked: Array<string | null> = [];
  expect(() =>
    loginWithGhCli("work", (ghUser) => {
      asked.push(ghUser);
      return { token: null };
    })
  ).toThrow(
    "gh is not authenticated as account 'work' - run `gh auth login` for that account, " +
      "then retry `agent auth`",
  );
  expect(() => loginWithGhCli("work", () => ({ token: null, unproven: true }))).toThrow(
    "could not check gh authentication (`gh auth token` did not run to completion) - retry `agent auth`",
  );
  expect(asked).toEqual(["work"]);
});

// --- gh multi-account selection (choice menu only, never an auth verdict) ------

// Real `gh auth status` shape (gh >= 2.40): per-host blocks, one "Logged in to"
// line per account, the active one flagged on its own line. The check mark is
// gh's output, fine inside a fixture literal.
const TWO_ACCOUNT_STATUS = `github.com
  ✓ Logged in to github.com account vivswan (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************
  ✓ Logged in to github.com account work-bot (keyring)
  - Active account: false
`;

function acct(login: string, active: boolean, source = "keyring"): GhAccount {
  return { host: "github.com", login, active, source };
}

test("parseGhAuthStatusAccounts: accounts with active attribution; broken logins and noise never match", () => {
  expect(parseGhAuthStatusAccounts(TWO_ACCOUNT_STATUS)).toEqual([
    acct("vivswan", true),
    acct("work-bot", false),
  ]);
  // A broken login must never surface as pickable, and its block's own "Active
  // account: true" line must not mark the healthy account parsed before it --
  // in EITHER of gh's failure wordings (per-account, and per-host env token).
  const withBrokenActive = [
    "github.com",
    "  ✓ Logged in to github.com account healthy (keyring)",
    "  - Active account: false",
    "  ✗ Failed to log in to github.com account broken (keyring)",
    "  - Active account: true",
    "enterprise.example",
    "  ✗ Failed to log in to enterprise.example using token (GH_ENTERPRISE_TOKEN)",
    "  - Active account: true",
  ].join("\n");
  expect(parseGhAuthStatusAccounts(withBrokenActive)).toEqual([acct("healthy", false)]);
  expect(parseGhAuthStatusAccounts("You are not logged into any GitHub hosts.")).toEqual([]);
  // The credential source is captured (an env-token login is not pinnable),
  // and the SAME login saved in the keyring stays a separate, pinnable entry
  // (gh lists the env-token account first).
  const envOverlap = parseGhAuthStatusAccounts(
    [
      "  ✓ Logged in to github.com account ci-bot (GH_TOKEN)",
      "  - Active account: true",
      "  ✓ Logged in to github.com account ci-bot (keyring)",
      "  - Active account: false",
    ].join("\n"),
  );
  expect(envOverlap).toEqual([acct("ci-bot", true, "GH_TOKEN"), acct("ci-bot", false)]);
  expect(envOverlap.map(ghAccountPinnable)).toEqual([false, true]);
  expect(ghAccountPinnable(acct("saved", false))).toBe(true);
  // A repeated host+login+source triple collapses to one menu entry.
  expect(parseGhAuthStatusAccounts(TWO_ACCOUNT_STATUS + TWO_ACCOUNT_STATUS).length).toBe(2);
});

test("the gh spawn recipes: a pinned account adds --user; auto stays byte-identical", () => {
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh").args).toEqual(["auth", "token"]);
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh", null).args).toEqual(["auth", "token"]);
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh", "work-bot").args).toEqual([
    "auth",
    "token",
    "--user",
    "work-bot",
  ]);
  expect(ghAuthStatusSpawnSpec("/opt/gh/gh").args).toEqual(["auth", "status"]);
});

test("ghAccountsLookFromSpawn: ANY completed exit parses stdout+stderr; a dead spawn is unproven", () => {
  expect(
    ghAccountsLookFromSpawn({ status: 0, stdout: TWO_ACCOUNT_STATUS, stderr: "" }).accounts
      .map((a) => a.login),
  ).toEqual(["vivswan", "work-bot"]);
  // gh exits non-zero when one account's login is broken but still lists the
  // healthy ones, and older gh printed the status to stderr: both stay proven.
  expect(
    ghAccountsLookFromSpawn({ status: 1, stdout: null, stderr: TWO_ACCOUNT_STATUS }).accounts
      .length,
  ).toBe(2);
  expect(ghAccountsLookFromSpawn({ status: null })).toEqual({ accounts: [], unproven: true });
  expect(ghAccountsLookFromSpawn({ status: 0, error: new Error("ETIMEDOUT") })).toEqual({
    accounts: [],
    unproven: true,
  });
});

test("chooseGhAccount: no real choice settles to auto; 2+ accounts without a TTY hint, never prompt", async () => {
  // Pin stdin to non-TTY for the duration: the settle rules under test are the
  // non-interactive ones, and an interactive dev run must not open a prompt.
  const hadTty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    // Unproven, zero, or one account: auto silently (exactly the historical flow).
    expect(await chooseGhAccount(() => ({ accounts: [], unproven: true }))).toEqual({
      kind: "auto",
    });
    expect(await chooseGhAccount(() => ({ accounts: [] }))).toEqual({ kind: "auto" });
    expect(await chooseGhAccount(() => ({ accounts: [acct("solo", true)] }))).toEqual({
      kind: "auto",
    });
    // Another host's login, and an env-token login (`--user` reads saved
    // credentials only), are not pinnable choices: one pinnable account left
    // means no menu.
    expect(
      await chooseGhAccount(() => ({
        accounts: [acct("solo", true), {
          host: "ghe.example.com",
          login: "enterprise",
          active: false,
          source: "keyring",
        }],
      })),
    ).toEqual({ kind: "auto" });
    expect(
      await chooseGhAccount(() => ({
        accounts: [acct("solo", false), acct("ci-bot", true, "GH_TOKEN")],
      })),
    ).toEqual({ kind: "auto" });
    // The env-token overlap of a saved login must not shrink the menu: two
    // pinnable saved accounts still hint (below), even with GH_TOKEN's entry
    // duplicating one of them.
    let overlapChoice: Awaited<ReturnType<typeof chooseGhAccount>> | undefined;
    const overlapErr = await captureStderr(async () => {
      overlapChoice = await chooseGhAccount(() => ({
        accounts: [
          acct("vivswan", true, "GH_TOKEN"),
          acct("vivswan", false),
          acct("work-bot", false),
        ],
      }));
    });
    expect(overlapChoice).toEqual({ kind: "auto" });
    expect(overlapErr).toContain("--gh-user");
    // 2+ github.com accounts, non-TTY: auto plus a stderr hint naming the
    // escape hatch and the active account -- never a prompt, never a throw.
    let choice: Awaited<ReturnType<typeof chooseGhAccount>> | undefined;
    const err = await captureStderr(async () => {
      choice = await chooseGhAccount(() => ({
        accounts: [acct("vivswan", true), acct("work-bot", false)],
      }));
    });
    expect(choice).toEqual({ kind: "auto" });
    expect(err).toContain("--gh-user");
    expect(err).toContain("(currently vivswan)");
  } finally {
    process.stdin.isTTY = hadTty;
  }
});

test("parseAcquisition: --gh-user implies gh-cli and rejects every conflicting flag", () => {
  expect(parseAcquisition(undefined, undefined, "work-bot")).toEqual({
    kind: "gh-cli",
    account: { kind: "pinned", login: "work-bot" },
  });
  expect(parseAcquisition("gh-cli", undefined, " work-bot ")).toEqual({
    kind: "gh-cli",
    account: { kind: "pinned", login: "work-bot" },
  });
  // A bare gh-cli provider still asks (settling to auto when there's no choice).
  expect(parseAcquisition("gh-cli", undefined, undefined)).toEqual({
    kind: "gh-cli",
    account: { kind: "choose" },
  });
  expect(() => parseAcquisition("copilot", undefined, "x")).toThrow(
    "--gh-user only applies to `--provider gh-cli`",
  );
  expect(() => parseAcquisition(undefined, "tok", "x")).toThrow("--set implies gh-token");
  expect(() => parseAcquisition(undefined, undefined, "   ")).toThrow(
    "--gh-user requires a non-empty gh account login",
  );
});

test("auth: --gh-user cannot combine with a sub-action (never silently dropped)", () => {
  const subs = [
    { get: true },
    { del: true },
    { check: true },
    { printProxyToken: true },
    { list: true },
  ];
  for (const sub of subs) {
    expect(() => parseAuthAction({ ghUser: "x", ...sub })).toThrow(
      "--gh-user pins the gh account",
    );
  }
});

test("Credential.resolve threads the slot's account pin into the gh probe", () => {
  isolate();
  const asked: Array<string | null> = [];
  const gh = (ghUser: string | null): string | null => {
    asked.push(ghUser);
    return "tok";
  };
  state().setCredential(null, { kind: "gh-cli", ghUser: null });
  expect(new Credential().resolve(gh)).toBe("tok");
  state().setCredential(null, { kind: "gh-cli", ghUser: "work-bot" });
  expect(new Credential().resolve(gh)).toBe("tok");
  expect(asked).toEqual([null, "work-bot"]);
});

test("credentialSourceLabel: a pinned gh account is named; auto and token providers stay bare", () => {
  // The one label --check/--list/"Already authenticated" render: auto gh-cli
  // must stay byte-identical to the pre-pin output.
  expect(credentialSourceLabel({ kind: "gh-cli", ghUser: null })).toBe("gh-cli");
  expect(credentialSourceLabel({ kind: "gh-cli", ghUser: "work-bot" })).toBe(
    "gh-cli (user work-bot)",
  );
  expect(credentialSourceLabel({ kind: "stored", provider: "gh-token", token: "t" })).toBe(
    "gh-token",
  );
  expect(credentialSourceLabel({ kind: "none", provider: null })).toBeNull();
});

// The credential store reads STRICTLY: an unreadable store must diagnose the
// failed read, never read as "no credential" (a wrong fix pointer) or "no such
// profile" (a false hard-fail naming the profile instead of the store). The
// named-profile arm is the sharper one -- profiles never fall back, so a
// fabricated empty would deny a credential that exists. POSIX, non-root only:
// root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable credential store throws at read, never 'no credential / no such profile'",
  () => {
    isolate();
    state().setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_keep" });
    const work = parseProfileName("work");
    state().commitProfile(work, {
      credential: { kind: "stored", provider: "gh-token", token: "ghu_work" },
      mode: "proxy",
    });
    const stateFile = new CopilotApiPaths().sharedStateFile;
    chmodSync(stateFile, 0o000);
    try {
      expect(() => state().readCredential(null)).toThrow(
        "refusing to treat an unreadable store as empty",
      );
      expect(() => state().profileSlotStatus(work)).toThrow(stateFile);
      expect(() => assertProfileSlot(work)).toThrow(stateFile);
    } finally {
      chmodSync(stateFile, 0o600);
    }
    // Control: readable again, the same reads answer the stored slots.
    expect(state().readCredential(null)).toEqual({
      kind: "stored",
      provider: "gh-token",
      token: "ghu_keep",
    });
    expect(state().profileSlotStatus(work).exists).toBe(true);
  },
);
