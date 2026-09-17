import { directWiring } from "../src/agents/configure.ts";
import { DEFAULT_COPILOT_API_BASE } from "../src/copilot_api/integration_identity.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { configureClaudeConfig } from "../src/claude/config.ts";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import {
  chooseGhAccount,
  credentialSourceLabel,
  type IdentityTableInput,
  identityTableLines,
  liveCredentialSourceLabel,
  loginWithGhCli,
  parseAcquisition,
  parseAuthAction,
  runAuth,
} from "../src/commands/auth.ts";
import {
  Credential,
  ghAccountsLookFromSpawn,
  ghAuthTokenLookVia,
  type GhTokenLook,
  ghTokenLookFromSpawn,
  runGhSpecAsync,
} from "../src/copilot_api/credential.ts";
import { CODEX_IDENTITY_NAME, CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { assertProfileSlot, CopilotEnvState } from "../src/copilot_api/env_state.ts";
import {
  activeGhLogin,
  GH_AUTH_TIMEOUT_MS,
  type GhAccount,
  ghAuthStatusSpawnSpec,
  ghAuthTokenSpawnSpec,
  type GhSpawnSpec,
  parseGhAuthStatusAccounts,
} from "../src/copilot_api/gh_cli.ts";
import {
  COPILOT_OAUTH_CLIENT_ID,
  COPILOT_OAUTH_SCOPE,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  githubDeviceFlowLogin,
  githubLoginLook,
  setGithubLoginFetch,
} from "../src/copilot_api/github_login.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  INTEGRATION_ID_HEADER,
  type ProbeFetch,
  setIntegrationProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { CopilotApiPaths, profileHome } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { errMessage } from "../src/utils/error.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  isolateAgentHomes,
  resetExitCode,
  stageRefusedStop,
  stubGithubLogins,
  writeRunState,
} from "./helpers.ts";

const restoreEnv = envSnapshot(["PATH"]);
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
  setGithubLoginFetch(null);
  dir = removeDir(dir);
});

/** Every token this file provisions reads as octocat's; a test that cares stubs its own. */
function isolate(): { claudeHome: string; codexHome: string } {
  const homes = isolateAgentHomes("copilot-auth-");
  dir = homes.dir;
  stubGithubLogins({
    ghu_inline_value: "octocat",
    ghu_new_from_env: "octocat",
    ghu_env_value: "octocat",
    ghu_x: "octocat",
    ghu_new: "octocat",
  });
  return { claudeHome: homes.claudeHome, codexHome: homes.codexHome };
}

function state(): CopilotEnvState {
  return new CopilotEnvState();
}

// The catalog is opt-in (default false); without this the auth-time refresh never runs.
function enableCatalog(): void {
  new CopilotEnvConfig().set({ "codex.model-catalog": true });
}

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
  // The status line is human copy, so only the parenthesized provider identifier is pinned (the
  // parens keep a longer name like "gh-token-file" from matching); exit 0 is the machine contract.
  expect(out).toContain("(gh-token)");
  expect(process.exitCode).toBe(0);
});

test("auth (bare) is idempotent on a RECORDED provider - no re-auth, no config writes", async () => {
  const { claudeHome } = isolate();
  state().setCredential(null, { kind: "stored", provider: "copilot", token: "ghu_stored123" });
  await runAuth({});
  expect(state().read().githubToken).toBe("ghu_stored123");
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
});

test("auth (bare) with NO recorded provider re-runs the flow even when gh works (no idempotency loop)", async () => {
  isolate();
  // Idempotency keys on the RECORDED choice, not on whether gh works: otherwise a machine with a gh
  // login could never reach a fresh login. The non-TTY throw proves the flow ran, not a gh
  // short-circuit.
  await expect(runAuth({})).rejects.toThrow("not a terminal");
});

test("headless gh-token never reads the env: that is gh-env's job", async () => {
  isolate();
  state().clearCredential(null);
  process.env.GH_TOKEN = "ghu_env_value";
  await expect(runAuth({ provider: "gh-token" })).rejects.toThrow(/--set <token>/);
  expect(state().read().githubToken).toBeNull();
  delete process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  await expect(runAuth({ provider: "gh-env" })).rejects.toThrow(/GH_TOKEN/);
});

test("auth --provider gh-env stores the env token + provider, and does NOT configure agents", async () => {
  const { claudeHome } = isolate();
  // A recorded, RESOLVING credential under another provider: an explicit
  // provider must still run (never short-circuited by "already authenticated").
  state().setCredential(null, { kind: "stored", provider: "copilot", token: "ghu_old" });
  process.env.GH_TOKEN = "ghu_new_from_env";
  await runAuth({ provider: "gh-env" });
  expect(state().read()).toEqual({
    githubToken: "ghu_new_from_env",
    authProvider: "gh-env",
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
  // A profile is created ONLY by `agent profile --add`'s atomic commit, so re-auth refuses an
  // unknown name BEFORE any acquisition runs.
  await expect(runAuth({ set: "ghu_x", profile: "ghost" })).rejects.toThrow(
    /no such profile 'ghost'/,
  );
  expect(state().read().profiles).toEqual({});

  const ghost = parseProfileName("ghost");
  state().commitProfile(ghost, {
    credential: { kind: "stored", provider: "gh-token", token: "ghu_old" },
    mode: "direct",
  });
  // A complete Direct profile is rebaked by the landing: every credential probes (the codex
  // identity accepted here), and the pair the probe selected is stored beside the new credential.
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
  try {
    await runAuth({ set: "ghu_new", profile: "ghost" });
  } finally {
    setIntegrationProbeFetch(null);
  }
  expect(new CopilotEnvState().readProfileSlot(ghost).credential).toEqual({
    kind: "stored",
    provider: "gh-token",
    token: "ghu_new",
  });
  expect(new CopilotEnvState().readProfileDirectPair(ghost)).toEqual({
    integrationId: null,
    host: "https://api.githubcopilot.com",
  });
  expect(state().read().githubToken).toBeNull(); // default slot untouched
});

test("auth --set cannot combine with --get/--del/--check", async () => {
  isolate();
  await expect(runAuth({ set: "ghu_x", get: true })).rejects.toThrow("cannot combine");
});

test("token acquisition narrates 'Using' + the account, never 'Stored' (persistence is the caller's write)", async () => {
  isolate();
  // The token is only ACQUIRED here -- `agent profile --add` commits it later,
  // atomically with the profile's mode, so a "Stored" claim at this point would
  // be false on that path (and premature even on the plain auth path).
  const inline = await captureStderr(() => runAuth({ set: "ghu_inline_value" }));
  expect(inline).toContain("Using the provided GitHub token as octocat.");
  expect(inline).not.toContain("Stored");
  process.env.GH_TOKEN = "ghu_env_value";
  const fromEnv = await captureStderr(() => runAuth({ provider: "gh-env" }));
  expect(fromEnv).toContain("Using $GH_TOKEN as octocat.");
  expect(fromEnv).not.toContain("Stored");
  // A missed look labels, never blocks: the token is still used, shown by its ends with GitHub's verdict.
  const unknown = await captureStderr(() => runAuth({ set: "ghu_unlisted_0123456789" }));
  expect(unknown).toContain(
    "Using the provided GitHub token = ghu_un...6789, unverified (GitHub rejected it, HTTP 401).",
  );
  expect(state().read().githubToken).toBe("ghu_unlisted_0123456789");
});

test("githubLoginLook asks GraphQL for the viewer and reads a login, a 401, or an unreachable GitHub", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const answer = (status: number, body: string) => (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  };
  expect(await githubLoginLook("ghp_a", answer(200, '{"data":{"viewer":{"login":"octocat"}}}')))
    .toEqual({ login: "octocat" });
  const [request] = seen;
  expect(request?.url).toBe("https://api.github.com/graphql");
  expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer ghp_a");
  expect(JSON.parse(String(request?.init?.body))).toEqual({ query: "query { viewer { login } }" });
  expect(await githubLoginLook("ghp_b", answer(401, '{"message":"Bad credentials"}'))).toEqual({
    login: null,
    detail: "GitHub rejected it, HTTP 401",
  });
  expect(await githubLoginLook("ghp_c", () => Promise.reject(new Error("ENOTFOUND")))).toEqual({
    login: null,
    detail: "GitHub could not be reached: ENOTFOUND",
  });
});

test("auth --get/--del/--check on a NONEXISTENT profile hint at `agent profile --add`", async () => {
  isolate();
  // Recommending a re-auth would hit the no-store-slot gate, so the hint reuses the store's
  // no-such-profile phrasing. Asserted without backticks: consola renders code spans, stripping
  // them.
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

  // A partial slot (de-authed, mode kept) re-auths in place, so the hint stays
  // `agent auth --profile`.
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
  // A daemon home without a store slot (an interrupted add): the store's own write gate words this
  // "half-created", so the read-back hints must say the same, never "no such profile".
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
  // The bug pinned: `--get --provider bogus` once ran --get and dropped the provider unvalidated.
  for (
    const args of [
      { get: true, provider: "bogus" },
      { del: true, provider: "copilot" },
      { check: true, provider: "gh-cli" },
      { printProxyToken: true, provider: "gh-token" },
      { list: true, provider: "copilot" },
      { identities: true, provider: "copilot" },
      { identity: "copilot-developer-cli", provider: "copilot" },
    ]
  ) {
    await expect(runAuth(args)).rejects.toThrow(
      "--provider selects how to authenticate and cannot combine with " +
        "--get/--del/--check/--list/--identities/--identity/--print-proxy-token",
    );
  }
  // Other rejections keep precedence over the conflict: --list/--profile and an invalid name still
  // report themselves.
  await expect(runAuth({ list: true, profile: "work", provider: "copilot" })).rejects.toThrow(
    "--list reports every profile; it does not combine with --profile",
  );
  await expect(runAuth({ get: true, profile: "NOT valid", provider: "copilot" })).rejects.toThrow(
    /invalid profile name/,
  );
});

// --- integration identities -------------------------------------------------

/** A PAT the CLI identity accepts on both hosts (a 5-model generic catalog, 37 on the account
 *  host), that the sandbox accepts on the generic host only (2 models), and that the codex identity
 *  (no id header), vscode-chat, and any other id reject. A `host` literal host accepts every
 *  identity (9 models). */
const CONFIGURED_HOST = "https://copilot.example";

/** An id no candidate list carries: only a pin or a stored pair puts it in the table. */
const FOREIGN_ID = "my-custom-id";
const FOREIGN_MARKED_ROW = new RegExp(
  `^${FOREIGN_ID}\\s+rejected \\(400\\) \\*\\s+rejected \\(400\\)`,
  "m",
);

/** The stub the identities tests install (stubIdentitySurvey), kept so a test can wrap it. */
let stubbedSurveyFetch: ProbeFetch = () => Promise.reject(new Error("no survey stub installed"));

function stubIdentitySurvey(designated = "https://api.enterprise.githubcopilot.com"): void {
  stubbedSurveyFetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ endpoints: { api: designated } }), { status: 200 }),
      );
    }
    const catalog = (size: number): Response =>
      new Response(
        JSON.stringify({ data: Array.from({ length: size }, (_, i) => ({ id: `m${i}` })) }),
        {
          status: 200,
        },
      );
    if (new URL(url).origin === CONFIGURED_HOST) return Promise.resolve(catalog(9));
    const enterprise = url.startsWith("https://api.enterprise.");
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
    if (id === COPILOT_CLI_INTEGRATION_ID) return Promise.resolve(catalog(enterprise ? 37 : 5));
    if (id === COPILOT_SANDBOX_INTEGRATION_ID && !enterprise) return Promise.resolve(catalog(2));
    return Promise.resolve(
      new Response("Personal Access Tokens are not supported for this endpoint", { status: 400 }),
    );
  };
  setIntegrationProbeFetch(stubbedSurveyFetch);
}

const PAT_REJECTION = "400 Personal Access Tokens are not supported for this endpoint";

const GENERIC_HOST = "https://api.githubcopilot.com";

test("auth --identities: one column per host, ONE mark on the slot's identity under the pin, and never a read of the agent files", async () => {
  const { claudeHome } = isolate();
  const credential = { kind: "stored", provider: "gh-token", token: "github_pat_x" } as const;
  state().setCredential(null, credential);
  stubIdentitySurvey();
  // The table is pinned at its natural width whatever terminal runs the tests.
  const columns = process.env.COLUMNS;
  process.env.COLUMNS = "200";
  try {
    // One header set for every mode, so every (host, identity) is asked ONCE; the survey selects
    // nothing and writes nothing.
    const requests = new Map<string, number>();
    const surveyFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const key = `${url} ${headers.get(INTEGRATION_ID_HEADER) ?? "-"} ${
        headers.get("User-Agent") ?? "-"
      }`;
      requests.set(key, (requests.get(key) ?? 0) + 1);
      return stubbedSurveyFetch(input, init);
    };
    setIntegrationProbeFetch(surveyFetch);
    const fresh = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect([...requests.entries()].filter(([, n]) => n !== 1)).toEqual([]);
    // The account lookup (no id, copilot-env's own User-Agent) happened exactly once.
    expect(requests.get("https://api.github.com/copilot_internal/user - copilot-env")).toBe(1);
    setIntegrationProbeFetch(stubbedSurveyFetch);
    // Color is a TTY affordance: the survey a pipe or a test reads is plain text.
    expect(fresh).not.toContain("\x1b");
    // Four candidate rows, nothing more; vscode-chat is the last candidate.
    expect(fresh).toMatch(
      /^vscode-chat\s+rejected \(400\)\s+rejected \(400\)\s+copilot-api's former default$/m,
    );
    expect(fresh).not.toContain(FOREIGN_ID);
    expect(fresh).toContain("identity: auto");
    expect(fresh).toContain("host: auto (api.githubcopilot.com in use)");
    expect(fresh).toMatch(
      /^identity\s+api\.githubcopilot\.com \(in use\)\s+api\.enterprise\.githubcopilot\.com \(account\)\s+note$/m,
    );
    expect(fresh).toMatch(/^codex\s+rejected \(400\)\s+rejected \(400\)\s+the default/m);
    // A slot never probed has nothing in use, so no `*`; `>` sits on what the next landing would
    // pick: the first candidate the host in use accepts (the codex identity is rejected there).
    expect(fresh).toMatch(
      /^copilot-developer-cli\s+accepted \(5 models\) >\s+accepted \(37 models\)\s+GitHub Copilot CLI/m,
    );
    expect(fresh).toMatch(
      /^copilot-developer-sandbox\s+accepted \(2 models\)\s+rejected \(400\)$/m,
    );
    expect(fresh.match(/ \*/g)).toBeNull();
    expect(fresh.match(/\) >/g)).toHaveLength(1);
    expect(fresh).toContain("; > = would be picked by the next landing (nothing stored yet)");
    expect(fresh).toContain(
      "Nothing stored yet for this profile: run `agent init` (or `agent start`) once; it probes " +
        "on the host in use and stores the identity and host it lands on.",
    );
    expect(state().readProfileDirectPair(null)).toEqual({});
    expect(fresh).toContain(`  codex on api.githubcopilot.com: ${PAT_REJECTION}`);
    expect(fresh).toContain(
      `  copilot-developer-sandbox on api.enterprise.githubcopilot.com (account): ${PAT_REJECTION}`,
    );

    // A pin without a stored pair marks nothing: the pin fixes the identity, so there is no pick to
    // preview, and the host is still the probe's to find, so the `*` waits for the pair.
    new CopilotEnvConfig().setProfile(null, { identity: COPILOT_CLI_INTEGRATION_ID });
    const pinnedEmpty = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(pinnedEmpty).toContain(`identity: pinned to ${COPILOT_CLI_INTEGRATION_ID}`);
    expect(pinnedEmpty).not.toContain(">");
    expect(pinnedEmpty.match(/ \*/g)).toBeNull();
    expect(pinnedEmpty).toContain("The host is not stored yet for this profile");
    new CopilotEnvConfig().setProfile(null, { identity: "auto" });

    // A pinned landing stored only the host; with the pin cleared the slot holds that half alone.
    // The next landing re-selects from the generic host, so no pick is previewed on the stored one.
    state().setProfileDirectPair(null, { host: "https://api.enterprise.githubcopilot.com" });
    const halfStored = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(halfStored).toContain("host: auto (api.enterprise.githubcopilot.com in use)");
    expect(halfStored).not.toContain(">");
    expect(halfStored.match(/ \*/g)).toBeNull();
    expect(halfStored).toContain("The identity is not stored yet for this profile");

    // The stored pair is THE identity in use: one `*`, on its host, and the `>` preview is gone.
    state().setProfileDirectPair(null, {
      integrationId: COPILOT_CLI_INTEGRATION_ID,
      host: GENERIC_HOST,
    });
    const stored = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(stored).toMatch(
      /^copilot-developer-cli\s+accepted \(5 models\) \*\s+accepted \(37 models\)\s/m,
    );
    expect(stored.match(/ \*/g)).toHaveLength(1);
    expect(stored).not.toContain(">");
    expect(stored).not.toContain("Nothing stored yet");

    // Negative control: an agent file baking another identity changes nothing; the files are
    // outputs, and the survey never reads them.
    configureClaudeConfig(claudeHome, {
      mode: "direct",
      credential: { kind: "command" },
      direct: directWiring(COPILOT_SANDBOX_INTEGRATION_ID, DEFAULT_COPILOT_API_BASE),
    });
    expect(await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS))).toBe(stored);

    // A pin overlays the stored identity: the mark moves to it, and the note names the overlay.
    await runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID }, NOOP_CATALOG_DEPS);
    const pinned = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(pinned).toContain(`identity: pinned to ${COPILOT_SANDBOX_INTEGRATION_ID}`);
    expect(pinned).toMatch(
      /^copilot-developer-cli\s+accepted \(5 models\)\s+accepted \(37 models\)\s/m,
    );
    expect(pinned).toMatch(
      /^copilot-developer-sandbox\s+accepted \(2 models\) \*\s+rejected \(400\)$/m,
    );
    expect(pinned).toContain(
      "Slot: the probed identity is copilot-developer-cli; the pin overlays it at every " +
        "re-render and daemon start.",
    );

    // A pin that is not a built-in candidate is still probed and marked, never a bare `-`.
    new CopilotEnvConfig().setProfile(null, { identity: FOREIGN_ID });
    const foreign = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(foreign).toMatch(FOREIGN_MARKED_ROW);
    expect(foreign).toContain(`  ${FOREIGN_ID} on api.githubcopilot.com: ${PAT_REJECTION}`);

    // A stored identity no candidate list names (set here directly: a landing never stores a
    // pin) stays in use once the pin clears, so its row stays and keeps the mark.
    new CopilotEnvConfig().setProfile(null, { identity: "auto" });
    state().setProfileDirectPair(null, { integrationId: FOREIGN_ID, host: GENERIC_HOST });
    const storedForeign = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(storedForeign).toContain("identity: auto");
    expect(storedForeign).toMatch(FOREIGN_MARKED_ROW);
    expect(storedForeign.match(/ \*/g)).toHaveLength(1);

    // A credential the proxy exchanges itself (device-flow) has no identity story of its own: the
    // credential write took the pair with it, so the slot reads as never probed again.
    state().setCredential(null, { kind: "stored", provider: "copilot", token: "ghu_device" });
    const exchanged = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(exchanged.match(/ \*/g)).toBeNull();
    expect(exchanged).toContain("Nothing stored yet for this profile");
    expect(exchanged).not.toContain("passthrough");

    // A running daemon keeps the identity and host it launched with, and the table says so.
    writeRunState({ pid: process.pid, port: 4141 });
    const running = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(running).toContain(
      "Proxy: a daemon is running and keeps the identity and host it launched with; restart it " +
        "to apply a change: `agent stop`, then `agent start`.",
    );
  } finally {
    setIntegrationProbeFetch(null);
    if (columns === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = columns;
  }
});

/** Every verdict kind on the host in use, an absent cell on the account's host, and the would-be
 *  pick, so every color the palette has lands somewhere. */
const SURVEY_TABLE: IdentityTableInput = {
  survey: {
    hosts: [
      {
        apiBase: GENERIC_HOST,
        role: "generic",
        verdicts: [
          { name: CODEX_IDENTITY_NAME, verdict: { kind: "rejected", detail: PAT_REJECTION } },
          { name: COPILOT_CLI_INTEGRATION_ID, verdict: { kind: "accepted", models: 5 } },
          {
            name: VSCODE_CHAT_INTEGRATION_ID,
            verdict: { kind: "inconclusive", detail: "503 upstream unavailable", status: 503 },
          },
        ],
      },
      {
        apiBase: "https://api.enterprise.githubcopilot.com",
        role: "designated",
        verdicts: [
          { name: CODEX_IDENTITY_NAME, verdict: { kind: "rejected", detail: PAT_REJECTION } },
          { name: COPILOT_CLI_INTEGRATION_ID, verdict: { kind: "accepted", models: 37 } },
        ],
      },
    ],
    designatedUnknown: false,
  },
  pinned: null,
  configuredHost: null,
  stored: {},
  hostInUse: GENERIC_HOST,
  slot: { kind: "empty", wouldPick: COPILOT_CLI_INTEGRATION_ID },
  daemonRunning: false,
  profile: null,
  color: false,
};

const ESC = "\x1b";

test("identityTableLines: with color on, the palette paints the survey like agent config and strips back to the plain layout", () => {
  const columns = process.env.COLUMNS;
  process.env.COLUMNS = "160";
  try {
    const plain = identityTableLines(SURVEY_TABLE);
    const colored = identityTableLines({ ...SURVEY_TABLE, color: true });
    expect(plain.join("\n")).not.toContain("\x1b");
    // Escapes never move a cell: stripped, the painted table IS the plain one, line for line.
    const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    expect(colored.map((line) => line.replace(sgr, ""))).toEqual(plain);
    const painted = colored.join("\n");
    expect(painted).toContain("\x1b[1midentity\x1b[22m");
    expect(painted).toContain(`\x1b[36m${COPILOT_CLI_INTEGRATION_ID}\x1b[39m`);
    expect(painted).toContain("\x1b[32maccepted (5 models)\x1b[39m \x1b[32m>\x1b[39m");
    expect(painted).toContain("\x1b[33mrejected (400)\x1b[39m");
    expect(painted).toContain("\x1b[2munclear (503)\x1b[22m");
    expect(painted).toContain("\x1b[2m-\x1b[22m");
    expect(painted).toContain("api.githubcopilot.com \x1b[2m(in use)\x1b[22m");
    // The legend, every note, and every reason are dim end to end: one open, one close, so the
    // host label inside a reason never nests a dim of its own.
    const dimWhole = (line: string | undefined, indent = ""): boolean =>
      line !== undefined && line.startsWith(`${indent}\x1b[2m`) && line.endsWith("\x1b[22m") &&
      line.split(ESC).length === 3;
    expect(dimWhole(colored.find((line) => line.includes("* = in use")))).toBe(true);
    expect(dimWhole(colored.find((line) => line.includes("Nothing stored yet")))).toBe(true);
    const reason = colored.find((line) => line.includes("codex on api.enterprise."));
    expect(reason).toContain("(account)");
    expect(dimWhole(reason, "  ")).toBe(true);
  } finally {
    if (columns === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = columns;
  }
});

test("auth --identities: columns are the generic host, the account's when it differs, and the host in use (the literal, else the stored host)", async () => {
  isolate();
  const credential = { kind: "stored", provider: "gh-token", token: "github_pat_x" } as const;
  state().setCredential(null, credential);
  const columns = process.env.COLUMNS;
  process.env.COLUMNS = "200";
  try {
    // The account is served on the generic host: one column, marked in use.
    stubIdentitySurvey("https://api.githubcopilot.com");
    const one = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(one).toMatch(/^identity\s+api\.githubcopilot\.com \(in use\)\s+note$/m);
    expect(one).not.toContain("(account)");

    // A literal adds its column and takes the in-use mark over the stored host: the stored codex
    // identity is marked on the literal's column, where every identity is accepted.
    state().setProfileDirectPair(null, { integrationId: null, host: GENERIC_HOST });
    new CopilotEnvConfig().setProfile(null, { host: CONFIGURED_HOST });
    stubIdentitySurvey();
    const three = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(three).toContain(`host: ${CONFIGURED_HOST}`);
    expect(three).toMatch(
      /^identity\s+api\.githubcopilot\.com\s+api\.enterprise\.githubcopilot\.com \(account\)\s+copilot\.example \(host, in use\)\s+note$/m,
    );
    expect(three).toMatch(
      /^codex\s+rejected \(400\)\s+rejected \(400\)\s+accepted \(9 models\) \*\s+the default/m,
    );
    expect(three.match(/ \*/g)).toHaveLength(1);

    // Under `auto` the stored host is the host in use: a column of its own when the account lookup
    // fails (no account column to merge into), tagged as stored, and the mark sits there.
    new CopilotEnvConfig().delProfile(null, "host");
    state().setProfileDirectPair(null, {
      integrationId: COPILOT_CLI_INTEGRATION_ID,
      host: "https://api.enterprise.githubcopilot.com",
    });
    setIntegrationProbeFetch((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(new Response("upstream", { status: 503 }));
      }
      return stubbedSurveyFetch(input, init);
    });
    const storedHost = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(storedHost).toContain("host: auto (api.enterprise.githubcopilot.com in use)");
    expect(storedHost).toMatch(
      /^identity\s+api\.githubcopilot\.com\s+api\.enterprise\.githubcopilot\.com \(stored, in use\)\s+note$/m,
    );
    expect(storedHost).toMatch(
      /^copilot-developer-cli\s+accepted \(5 models\)\s+accepted \(37 models\) \*\s/m,
    );
    expect(storedHost).toContain(
      "Host: the account's designated host could not be looked up (transient); only the hosts " +
        "above were surveyed.",
    );

    // A literal equal to the account's host is one column, in its account role.
    stubIdentitySurvey();
    new CopilotEnvConfig().setProfile(null, { host: "https://api.enterprise.githubcopilot.com" });
    const merged = await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS));
    expect(merged).toMatch(
      /^identity\s+api\.githubcopilot\.com\s+api\.enterprise\.githubcopilot\.com \(account, in use\)\s+note$/m,
    );
    expect(merged).not.toContain("host, in use");
  } finally {
    setIntegrationProbeFetch(null);
    if (columns === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = columns;
  }
});

test("auth --identities: at 80 columns the note wraps inside its own column, never under the identity", async () => {
  isolate();
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "github_pat_x" });
  // One host column (the account is served on the generic host), so the columns fit and wrap.
  stubIdentitySurvey("https://api.githubcopilot.com");
  const columns = process.env.COLUMNS;
  process.env.COLUMNS = "80";
  try {
    const lines = (await captureLog(() => runAuth({ identities: true }, NOOP_CATALOG_DEPS)))
      .split("\n");
    expect(lines.filter((line) => line.length > 80)).toEqual([]);
    const header = lines.find((line) => line.startsWith("identity  "));
    const noteAt = header?.indexOf("note") ?? -1;
    expect(noteAt).toBeGreaterThan(0);
    // The codex note breaks before its longest word; the continuation starts where the note
    // column does, with every cell before it blank.
    const continuation = lines.find((line) => /^\s+Copilot-Integration-Id/.test(line));
    expect(continuation?.search(/\S/)).toBe(noteAt);
  } finally {
    setIntegrationProbeFetch(null);
    if (columns === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = columns;
  }
});

test("auth --identity <id>: refused only when EVERY host rejects; one acceptance pins and names the other verdicts; auto clears", async () => {
  isolate();
  state().setCredential(null, { kind: "stored", provider: "gh-token", token: "github_pat_x" });
  stubIdentitySurvey();
  try {
    await expect(runAuth({ identity: VSCODE_CHAT_INTEGRATION_ID }, NOOP_CATALOG_DEPS)).rejects
      .toThrow(
        [
          `every host rejects this credential under \`${VSCODE_CHAT_INTEGRATION_ID}\`; not pinned:`,
          `  - api.githubcopilot.com: ${PAT_REJECTION}`,
          `  - api.enterprise.githubcopilot.com (account): ${PAT_REJECTION}`,
        ].join("\n"),
      );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();

    // Accepted on the generic host, rejected on the account's: pinned, and the warning names what
    // carried it.
    const narrated = await captureStderr(() =>
      runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID }, NOOP_CATALOG_DEPS)
    );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe(COPILOT_SANDBOX_INTEGRATION_ID);
    // consola's fancy reporter strips the backticks around the id; the CI reporter keeps them.
    expect(narrated).toMatch(
      new RegExp(
        `api\\.enterprise\\.githubcopilot\\.com \\(account\\): rejects \`?${COPILOT_SANDBOX_INTEGRATION_ID}\`? ` +
          `\\(${PAT_REJECTION}\\); pinning on api\\.githubcopilot\\.com accepting it\\.`,
      ),
    );

    await runAuth({ identity: "auto" }, NOOP_CATALOG_DEPS);
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();

    // A transient account-host lookup leaves that host unknown and a blocked generic host (403)
    // is inconclusive: nothing definitive stands against the pin, so it lands unverified and
    // says so.
    setIntegrationProbeFetch((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        url.includes("/copilot_internal/user")
          ? new Response("upstream", { status: 503 })
          : new Response("forbidden", { status: 403 }),
      );
    });
    const unknown = await captureStderr(() =>
      runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID }, NOOP_CATALOG_DEPS)
    );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe(COPILOT_SANDBOX_INTEGRATION_ID);
    expect(unknown).toContain(
      "The account's designated host could not be looked up (transient); pinning unverified.",
    );

    // Under a literal every request goes there, so its rejection alone refuses the pin even though
    // another host accepts the identity (the enterprise host rejects the sandbox id in this stub).
    await runAuth({ identity: "auto" }, NOOP_CATALOG_DEPS);
    stubIdentitySurvey();
    new CopilotEnvConfig().setProfile(null, { host: "https://api.enterprise.githubcopilot.com" });
    await expect(runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID }, NOOP_CATALOG_DEPS)).rejects
      .toThrow(
        "api.enterprise.githubcopilot.com (account, in use) rejects this credential under " +
          `\`${COPILOT_SANDBOX_INTEGRATION_ID}\`; not pinned, every request goes to the ` +
          `host in use: ${PAT_REJECTION}`,
      );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();

    // Under `auto` the same rule reads the host auto WOULD select for the pin: the generic host
    // answers 400 for the sandbox id (kept: 400 is an identity answer), so its rejection refuses
    // the pin even though the account's host accepts that id; the CLI id, accepted there, pins.
    new CopilotEnvConfig().delProfile(null, "host");
    setIntegrationProbeFetch((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ endpoints: { api: "https://api.enterprise.githubcopilot.com" } }),
            { status: 200 },
          ),
        );
      }
      const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
      const enterprise = url.startsWith("https://api.enterprise.");
      const accepted = id === COPILOT_CLI_INTEGRATION_ID ||
        (id === COPILOT_SANDBOX_INTEGRATION_ID && enterprise);
      return Promise.resolve(
        accepted
          ? new Response(JSON.stringify({ data: [{}] }), { status: 200 })
          : new Response("Personal Access Tokens are not supported for this endpoint", {
            status: 400,
          }),
      );
    });
    await expect(runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID }, NOOP_CATALOG_DEPS)).rejects
      .toThrow(
        "api.githubcopilot.com rejects this credential under " +
          `\`${COPILOT_SANDBOX_INTEGRATION_ID}\`; not pinned, every request goes to the host auto ` +
          `selects for this identity: ${PAT_REJECTION}`,
      );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();
    await runAuth({ identity: COPILOT_CLI_INTEGRATION_ID }, NOOP_CATALOG_DEPS);
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe(COPILOT_CLI_INTEGRATION_ID);
  } finally {
    setIntegrationProbeFetch(null);
  }
});

test("auth --identity <id> validates the id at the flag like --provider, before any probe", async () => {
  isolate();
  await expect(runAuth({ identity: CODEX_IDENTITY_NAME })).rejects.toThrow(/cannot be pinned/);
  await expect(runAuth({ identity: "evil\nX: 1" })).rejects.toThrow(/header-safe/);
  await expect(runAuth({ identity: true, list: true })).rejects.toThrow("mutually exclusive");
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
  // ensureApiKey mints a 64-char hex key on first use.
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

test("resolveWithReason: one probe answers with the token or names the provider and gh's detail", () => {
  isolate();
  const credential = new Credential(state());
  expect(credential.resolveWithReason(() => ({ token: null }))).toEqual({
    token: null,
    reason: "no GitHub credential configured - run `agent auth` to log in",
  });
  credential.useGhCli("octocat");
  expect(credential.resolveWithReason(() => ({ token: "tok" }))).toEqual({
    token: "tok",
    reason: null,
  });
  // gh-cli recorded but gh missing from this process's PATH (the MCP-server case): the
  // provider is named and nothing sends the user to `agent auth`, which from a shell
  // where gh IS on PATH would say "already authenticated".
  const missing = credential.resolveWithReason(() => ({
    token: null,
    detail: "`gh` is not on this process's PATH",
  })).reason;
  expect(missing).toContain("provider 'gh-cli as octocat' is selected but no credential resolves");
  expect(missing).toContain("`gh` is not on this process's PATH");
  expect(missing).toContain("minimal PATH");
  expect(missing).not.toContain("agent auth");
  const refused = credential.resolveWithReason(() => ({
    token: null,
    detail: "`gh auth token` exited 1: no oauth token",
  })).reason;
  expect(refused).toContain("no oauth token");
  expect(refused).not.toContain("minimal PATH");
  const named = new Credential(state(), parseProfileName("p1"));
  expect(named.resolveWithReason(() => ({ token: null })).reason).toContain(
    "for profile 'p1' - run `agent auth --profile p1` to log in (a named profile never falls back",
  );
});

test("ghTokenLookFromSpawn: completed exits prove, a dead spawn stays unproven", () => {
  expect(ghTokenLookFromSpawn({ status: 0, stdout: " tok \n" })).toEqual({
    token: "tok",
    command: "gh auth token",
  });
  // gh RAN: proven misses, the detail carrying gh's own first stderr line when there is one.
  expect(ghTokenLookFromSpawn({ status: 0, stdout: "", stderr: "credential unavailable\n" }))
    .toEqual({
      token: null,
      detail: "`gh auth token` printed no token: credential unavailable",
    });
  expect(ghTokenLookFromSpawn({ status: 1, stdout: "", stderr: "no oauth token\r\nmore\r\n" }))
    .toEqual({
      token: null,
      detail: "`gh auth token` exited 1: no oauth token",
    });
  // The spawn never completed (timeout kill / spawn error): proven NOTHING.
  expect(ghTokenLookFromSpawn({ status: null })).toEqual({
    token: null,
    unproven: true,
    detail: "`gh auth token` did not complete (the spawn was killed)",
  });
  expect(ghTokenLookFromSpawn({ status: 1, error: new Error("ETIMEDOUT"), stdout: "" })).toEqual({
    token: null,
    unproven: true,
    detail: "`gh auth token` did not complete (ETIMEDOUT)",
  });
});

test("loginWithGhCli: an UNPROVEN look says could-not-check; a proven miss quotes gh and keeps the advice", async () => {
  isolate(); // clears GH_TOKEN/GITHUB_TOKEN so a runner credential never shapes the wording
  const killed: GhTokenLook = {
    token: null,
    unproven: true,
    detail: "`gh auth token` did not complete (killed)",
  };
  expect(() => loginWithGhCli(null, () => killed)).toThrow(
    "could not check gh authentication (`gh auth token` did not complete (killed)) - retry `agent auth`",
  );
  expect(() =>
    loginWithGhCli(null, () => ({ token: null, detail: "`gh auth token` exited 1: not logged in" }))
  ).toThrow(
    "gh is not authenticated (`gh auth token` exited 1: not logged in) - run `gh auth login`, then retry `agent auth`",
  );
  expect(() => loginWithGhCli(null, () => ({ token: "tok" }))).not.toThrow();
  // The auto success line names the followed account when known (nothing hidden).
  const named = await captureStderr(() => {
    loginWithGhCli(null, () => ({ token: "tok" }), "octocat");
    return Promise.resolve();
  });
  expect(named).toContain(
    "Using the gh CLI login on AUTO (currently account octocat; follows gh account switches) " +
      "as the Direct credential.",
  );
  // A pinned account wears its own words: the miss is about THAT account (gh's active login may
  // well be fine), the look receives the pin to verify, and gh's own stderr is quoted verbatim.
  const asked: Array<string | null> = [];
  const miss = {
    token: null,
    detail: "`gh auth token --user work --hostname github.com` exited 1: no oauth token found",
  };
  const pinnedMiss = (ghUser: string | null) => {
    asked.push(ghUser);
    return miss;
  };
  expect(() => loginWithGhCli("work", pinnedMiss)).toThrow(
    "gh has no saved credential for account 'work' (`gh auth token --user work --hostname " +
      "github.com` exited 1: no oauth token found) - run `gh auth login` for that account, pass " +
      "--gh-user <login> for another, or choose auto interactively via `agent auth --provider gh-cli`",
  );
  expect(() => loginWithGhCli("work", () => killed)).toThrow(
    "could not check gh authentication (`gh auth token` did not complete (killed)) - retry `agent auth`",
  );
  expect(asked).toEqual(["work"]);
});

// --- the pinned look's fallback: the plain token when the pin is gh's active account ----------

/** A remote Linux box: a hosts.yml login, a missing-scope warning that makes `gh auth status` exit 1,
 *  and a `--user` call gh refuses. The check marks are gh's output, fine inside a fixture literal. */
const HOSTS_YML_STATUS = `github.com
  ✓ Logged in to github.com account work-bot (/home/user/.config/gh/hosts.yml)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************
  - Token scopes: 'read:user', 'repo'
  ! Missing required token scopes: 'read:org'
  - To request missing scopes, run: gh auth refresh -h github.com
`;

/** gh < 2.40: "as <login>", no active marker, and no `--user` flag at all. */
const OLD_GH_STATUS = `github.com
  ✓ Logged in to github.com as work-bot (/home/user/.config/gh/hosts.yml)
  ✓ Git operations for github.com configured to use ssh protocol.
  ✓ Token: gho_************************
`;

type GhRun = (spec: GhSpawnSpec) => { status: number | null; stdout: string; stderr: string };

interface FakeGhShape {
  pinned: { status: number; stdout?: string; stderr?: string };
  status: { status: number | null; stdout: string };
  /** Absent: the plain call reports "not logged in". */
  plain?: { status: number; stdout: string };
}

/** A gh answering each of the three calls per `shape`, recording the order it was asked in. */
function fakeGh(shape: FakeGhShape): { run: GhRun; calls: string[] } {
  const calls: string[] = [];
  const run: GhRun = (spec) => {
    const call = spec.args.join(" ");
    calls.push(call);
    if (call.startsWith("auth status")) return { stderr: "", ...shape.status };
    if (call.includes("--user")) return { stdout: "", stderr: "", ...shape.pinned };
    return shape.plain === undefined
      ? { status: 1, stdout: "", stderr: "not logged in" }
      : { stderr: "", ...shape.plain };
  };
  return { run, calls };
}

const NO_USER_FLAG = { status: 1, stderr: "unknown flag: --user\n\nUsage:  gh auth token [flags]" };
const NO_TOKEN_FOR_USER = {
  status: 1,
  stderr: "no oauth token found for github.com account work-bot",
};
const SAVED = { status: 0, stdout: "gho_saved\n" };
const PINNED_CALL = "auth token --user work-bot --hostname github.com";
/** Host-scoped: a bare `gh auth token` would follow a GH_HOST override to another host. */
const PLAIN_CALL = "auth token --hostname github.com";

test("ghAuthTokenLookVia: a refused --user lands the plain token when the pin is gh's active account; the pin never follows a switch", () => {
  isolate(); // clears GH_TOKEN/GITHUB_TOKEN: the env guard below must be earned
  // (a) gh < 2.40 rejects --user; its status names the login as the only one.
  const old = fakeGh({
    pinned: NO_USER_FLAG,
    status: { status: 0, stdout: OLD_GH_STATUS },
    plain: SAVED,
  });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", old.run)).toEqual({
    token: "gho_saved",
    command: "gh auth token --hostname github.com",
  });
  expect(old.calls).toEqual([PINNED_CALL, "auth status --hostname github.com", PLAIN_CALL]);
  // (b) a hosts.yml login `--user` cannot serve, status exit 0.
  const hosts = fakeGh({
    pinned: NO_TOKEN_FOR_USER,
    status: {
      status: 0,
      stdout: HOSTS_YML_STATUS.replace(/ *! Missing.*\n *- To request.*\n/, ""),
    },
    plain: SAVED,
  });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", hosts.run)).toEqual({
    token: "gho_saved",
    command: "gh auth token --hostname github.com",
  });
  // (c) the same with the missing-scope warning: status exits 1 and is still read.
  const scopes = fakeGh({
    pinned: NO_TOKEN_FOR_USER,
    status: { status: 1, stdout: HOSTS_YML_STATUS },
    plain: SAVED,
  });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", scopes.run)).toEqual({
    token: "gho_saved",
    command: "gh auth token --hostname github.com",
  });
  // A working --user asks nothing else; an auto look never falls back.
  const direct = fakeGh({
    pinned: { status: 0, stdout: "gho_pinned\n" },
    status: { status: 0, stdout: "" },
  });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", direct.run)).toEqual({
    token: "gho_pinned",
    command: "gh auth token --user work-bot --hostname github.com",
  });
  expect(direct.calls).toEqual([PINNED_CALL]);
  const auto = fakeGh({
    pinned: NO_TOKEN_FOR_USER,
    status: { status: 0, stdout: HOSTS_YML_STATUS },
  });
  expect(ghAuthTokenLookVia(null, "/opt/gh/gh", auto.run)).toEqual({
    token: null,
    detail: "`gh auth token` exited 1: not logged in",
  });
  expect(auto.calls).toEqual(["auth token"]);
  // gh switched to another account: the plain token is someone else's, so the pin stays a miss
  // and the detail quotes both what gh refused and whom it now serves.
  const switched = fakeGh({
    pinned: NO_TOKEN_FOR_USER,
    status: { status: 0, stdout: TWO_ACCOUNT_STATUS },
    plain: SAVED,
  });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", switched.run)).toEqual({
    token: null,
    detail: "`gh auth token --user work-bot --hostname github.com` exited 1: " +
      "no oauth token found for github.com account work-bot; `gh auth status` reports active account octocat",
  });
  expect(switched.calls).not.toContain(PLAIN_CALL);
  // An env-token active account is not a saved login: never adopted, and named as the reason.
  const envServed = fakeGh({
    pinned: NO_TOKEN_FOR_USER,
    status: {
      status: 0,
      stdout: TWO_ACCOUNT_STATUS.replace("octocat (keyring)", "octocat (GH_TOKEN)"),
    },
    plain: SAVED,
  });
  expect(ghAuthTokenLookVia("octocat", "/opt/gh/gh", envServed.run).detail).toContain(
    "; gh serves octocat from $GH_TOKEN, not a saved login",
  );
  expect(envServed.calls).not.toContain(PLAIN_CALL);
  // Older gh marks no active account, so the env source must be found on the login itself.
  const oldEnvServed = fakeGh({
    pinned: NO_TOKEN_FOR_USER,
    status: {
      status: 0,
      stdout: OLD_GH_STATUS.replace("(/home/user/.config/gh/hosts.yml)", "(GH_TOKEN)"),
    },
    plain: SAVED,
  });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", oldEnvServed.run).detail)
    .toContain(
      "; gh serves work-bot from $GH_TOKEN, not a saved login",
    );
  expect(oldEnvServed.calls).not.toContain(PLAIN_CALL);
  // A token var in OUR environment is what the plain call would print: refused before any status call.
  process.env.GITHUB_TOKEN = "ghp_env";
  const envSet = fakeGh({
    pinned: NO_TOKEN_FOR_USER,
    status: { status: 0, stdout: HOSTS_YML_STATUS },
    plain: SAVED,
  });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", envSet.run)).toEqual({
    token: null,
    detail: "`gh auth token --user work-bot --hostname github.com` exited 1: " +
      "no oauth token found for github.com account work-bot; $GITHUB_TOKEN is set, not a saved login",
  });
  expect(envSet.calls).toEqual([PINNED_CALL]);
  delete process.env.GITHUB_TOKEN;
  // The plain call failing too reports both refusals; a status that never completed proves nothing.
  const both = fakeGh({ pinned: NO_USER_FLAG, status: { status: 0, stdout: OLD_GH_STATUS } });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", both.run).detail).toBe(
    "`gh auth token --user work-bot --hostname github.com` exited 1: unknown flag: --user; " +
      "`gh auth token --hostname github.com` exited 1: not logged in",
  );
  const killedStatus = fakeGh({
    pinned: NO_USER_FLAG,
    status: { status: null, stdout: "" },
    plain: SAVED,
  });
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", killedStatus.run)).toEqual({
    token: null,
    unproven: true,
    detail:
      "`gh auth token --user work-bot --hostname github.com` exited 1: unknown flag: --user; " +
      "`gh auth status --hostname github.com` did not complete",
  });
  // ONE budget for the whole look: a pinned call that ate it leaves nothing for the status call,
  // so the look ends unproven there instead of chaining fresh 5s timeouts past the caller's deadline.
  let now = 1_000_000;
  const slow = fakeGh({
    pinned: NO_USER_FLAG,
    status: { status: 0, stdout: OLD_GH_STATUS },
    plain: SAVED,
  });
  const slowRun: GhRun = (spec) => {
    now += GH_AUTH_TIMEOUT_MS;
    return slow.run(spec);
  };
  expect(ghAuthTokenLookVia("work-bot", "/opt/gh/gh", slowRun, () => now)).toEqual({
    token: null,
    unproven: true,
    detail:
      "`gh auth token --user work-bot --hostname github.com` exited 1: unknown flag: --user; " +
      "the 5s gh budget ran out before `gh auth status --hostname github.com`",
  });
  expect(slow.calls).toEqual([PINNED_CALL]);
});

test.skipIf(process.platform === "win32")(
  "runGhSpecAsync settles when gh exits, not when a descendant releases the pipes",
  async () => {
    // A background child inherits gh's stdout: `close` would wait for it, `exit` does not. Its
    // pid comes back on stderr so the test ends it instead of leaving it to run out.
    const started = Date.now();
    const result = await runGhSpecAsync({
      file: "sh",
      args: ["-c", "echo tok; sleep 5 & echo $! >&2"],
      shell: false,
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin" },
    });
    const elapsed = Date.now() - started;
    const descendant = Number(result.stderr?.trim());
    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("tok\n");
      expect(elapsed).toBeLessThan(900);
    } finally {
      process.kill(descendant);
    }
  },
);

// The production path end to end through a fake `gh` on PATH: status listing -> pin -> the pinned
// look -> the fallback, then the recorded slot resolves through the same code every `--get` runs.
// (POSIX shell scripts; the Windows .cmd dispatch is covered by the launch tests.)
const onPosix = test.skipIf(process.platform === "win32");

function fakeGhOnPath(script: string): void {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}`, { mode: 0o755 });
  // The fake bin dir FIRST, with the system dirs kept: findCommand resolves through `sh`.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

/** A gh whose `--user` call fails as `userReply` says, whose status prints `status` with `statusExit`,
 *  and whose plain `gh auth token` serves the saved login. Every other call is a test failure. */
function ghScript(userReply: string, status: string, statusExit: number): string {
  return [
    'case "$*" in',
    `  "auth token --user work-bot --hostname github.com") echo "${userReply}" >&2; exit 1;;`,
    `  "auth status --hostname github.com") cat <<'STATUS'\n${status}STATUS\n    exit ${statusExit};;`,
    '  "auth token --hostname github.com") echo gho_saved;;',
    '  *) echo "unexpected gh call: $*" >&2; exit 2;;',
    "esac",
    "",
  ].join("\n");
}

onPosix(
  "auth --provider gh-cli lands the owner's hosts.yml login and an old gh's login through a fake gh",
  async () => {
    const hadTty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      for (
        const script of [
          ghScript(NO_TOKEN_FOR_USER.stderr, HOSTS_YML_STATUS, 1),
          ghScript("unknown flag: --user", OLD_GH_STATUS, 0),
        ]
      ) {
        isolate();
        fakeGhOnPath(script);
        await runAuth({ provider: "gh-cli" });
        const stored = state().read();
        expect([stored.authProvider, stored.ghUser]).toEqual(["gh-cli", "work-bot"]);
        expect(new Credential().resolveWithReason()).toEqual({ token: "gho_saved", reason: null });
      }
      // The same box after `gh auth switch` to another account: the failure quotes gh's own refusal
      // and names whom gh now serves, and never the env-token guess (nothing is set here).
      isolate();
      fakeGhOnPath(ghScript(NO_TOKEN_FOR_USER.stderr, TWO_ACCOUNT_STATUS, 0));
      let message = "";
      try {
        await runAuth({ provider: "gh-cli", ghUser: "work-bot" });
      } catch (e) {
        message = errMessage(e);
      }
      expect(message).toBe(
        "gh has no saved credential for account 'work-bot' (`gh auth token --user " +
          "work-bot --hostname github.com` exited 1: no oauth token found for github.com " +
          "account work-bot; `gh auth status` reports active account octocat) - run " +
          "`gh auth login` for that account, pass --gh-user <login> for another, or choose auto " +
          "interactively via `agent auth --provider gh-cli`",
      );
      expect(state().read().authProvider).toBeNull();
    } finally {
      process.stdin.isTTY = hadTty;
    }
  },
);

// --- gh multi-account selection (choice menu only, never an auth verdict) ------

// Real `gh auth status` shape (gh >= 2.40): per-host blocks, one "Logged in to"
// line per account, the active one flagged on its own line. The check mark is
// gh's output, fine inside a fixture literal.
const TWO_ACCOUNT_STATUS = `github.com
  ✓ Logged in to github.com account octocat (keyring)
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
    acct("octocat", true),
    acct("work-bot", false),
  ]);
  // A broken login is never pickable, and its block's own "Active account: true" must not mark the
  // healthy account parsed before it, in ANY of gh's failure wordings. Each failure block sits
  // DIRECTLY after a healthy account, so a reset regex missing that wording marks the wrong
  // account.
  const withBrokenActive = [
    "github.com",
    "  ✓ Logged in to github.com account healthy (keyring)",
    "  - Active account: false",
    "  ✗ Timeout trying to log in to github.com account slow (keyring)",
    "  - Active account: true",
    "  ✓ Logged in to github.com account steady (keyring)",
    "  - Active account: false",
    "  ✗ Failed to log in to github.com account broken (keyring)",
    "  - Active account: true",
    "enterprise.example",
    "  ✗ Failed to log in to enterprise.example using token (GH_ENTERPRISE_TOKEN)",
    "  - Active account: true",
  ].join("\n");
  expect(parseGhAuthStatusAccounts(withBrokenActive)).toEqual([
    acct("healthy", false),
    { host: "github.com", login: "slow", active: true, source: "keyring", broken: true },
    acct("steady", false),
    { host: "github.com", login: "broken", active: true, source: "keyring", broken: true },
    {
      host: "enterprise.example",
      login: "",
      active: true,
      source: "GH_ENTERPRISE_TOKEN",
      broken: true,
    },
  ]);
  // The BROKEN active login still names what auto follows: gh's bare resolution tracks the active
  // account even when its login is broken.
  expect(activeGhLogin(parseGhAuthStatusAccounts(withBrokenActive))).toBe("slow");
  expect(parseGhAuthStatusAccounts("You are not logged into any GitHub hosts.")).toEqual([]);
  // The credential source is captured for DISPLAY only: an exported GH_TOKEN can shadow a saved
  // keyring credential for the same login, so the source never decides pinnability.
  const envOverlap = parseGhAuthStatusAccounts(
    [
      "  ✓ Logged in to github.com account ci-bot (GH_TOKEN)",
      "  - Active account: true",
      "  ✓ Logged in to github.com account ci-bot (keyring)",
      "  - Active account: false",
    ].join("\n"),
  );
  expect(envOverlap).toEqual([acct("ci-bot", true, "GH_TOKEN"), acct("ci-bot", false)]);
  expect(activeGhLogin(envOverlap)).toBe("ci-bot");
  expect(activeGhLogin([acct("solo", false)])).toBe("solo");
  expect(activeGhLogin([acct("a", false), acct("b", false)])).toBeNull();
  expect(activeGhLogin([])).toBeNull();
  // No active marker + a broken sibling: ambiguous, so nothing is named (the
  // only-login fallback needs the WHOLE list, broken included, to agree).
  expect(activeGhLogin([
    acct("healthy", false),
    { host: "github.com", login: "slow", active: false, source: "keyring", broken: true },
  ])).toBeNull();
  // An active entry whose login is unparseable (per-host env failure) names nothing.
  expect(activeGhLogin([
    { host: "github.com", login: "", active: true, source: "GH_TOKEN", broken: true },
    acct("healthy", false),
  ])).toBeNull();
  // No marker + an UNNAMED broken sibling: still ambiguous, still nothing named.
  expect(activeGhLogin([
    { host: "github.com", login: "", active: false, source: "GH_TOKEN", broken: true },
    acct("healthy", false),
  ])).toBeNull();
  // A repeated host+login+source triple collapses to one menu entry.
  expect(parseGhAuthStatusAccounts(TWO_ACCOUNT_STATUS + TWO_ACCOUNT_STATUS).length).toBe(2);
});

test("the gh spawn recipes: a pinned account adds --user on github.com; auto stays byte-identical", () => {
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh").args).toEqual(["auth", "token"]);
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh", null).args).toEqual(["auth", "token"]);
  // The pin was chosen from github.com's logins, so the resolve names the host:
  // a GH_HOST override must not point --user at another host's accounts.
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh", "work-bot").args).toEqual([
    "auth",
    "token",
    "--user",
    "work-bot",
    "--hostname",
    "github.com",
  ]);
  // The status probe is scoped to the pinnable host (an unreachable enterprise
  // host must not eat the timeout), and its machine-parsed output is stripped of
  // forced color: NO_COLOR set, the forcing vars dropped.
  const hadForce = process.env.CLICOLOR_FORCE;
  process.env.CLICOLOR_FORCE = "1";
  try {
    const status = ghAuthStatusSpawnSpec("/opt/gh/gh");
    expect(status.args).toEqual(["auth", "status", "--hostname", "github.com"]);
    expect(status.env.NO_COLOR).toBe("1");
    expect(status.env.CLICOLOR_FORCE).toBeUndefined();
  } finally {
    if (hadForce === undefined) delete process.env.CLICOLOR_FORCE;
    else process.env.CLICOLOR_FORCE = hadForce;
  }
});

test("ghAccountsLookFromSpawn: ANY completed exit parses stdout+stderr; a dead spawn is unproven", () => {
  expect(
    ghAccountsLookFromSpawn({ status: 0, stdout: TWO_ACCOUNT_STATUS, stderr: "" }).accounts
      .map((a) => a.login),
  ).toEqual(["octocat", "work-bot"]);
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

test("chooseGhAccount: pinning is the only default - sole login pins, non-TTY pins the active, auto never settles itself", async () => {
  // Pin stdin to non-TTY for the duration: the settle rules under test are the
  // non-interactive ones, and an interactive dev run must not open a prompt.
  const hadTty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    // Nothing pinnable is an ERROR naming the escape hatches - recording auto
    // would let a later `gh auth login` spend an unchosen account's credit.
    await expect(chooseGhAccount(() => ({ accounts: [], unproven: true }))).rejects.toThrow(
      "could not list gh accounts (`gh auth status` did not run to completion) - retry `agent auth`, or pass --gh-user <login>",
    );
    await expect(chooseGhAccount(() => ({ accounts: [] }))).rejects.toThrow(
      "gh has no logged-in github.com account - run `gh auth login`, then retry `agent auth`",
    );
    // One account: PINNED to it, so a later login cannot switch the credential.
    expect(await chooseGhAccount(() => ({ accounts: [acct("solo", true)] }))).toEqual({
      kind: "pinned",
      login: "solo",
    });
    // Another host's login is not a github.com choice (Copilot's host).
    expect(
      await chooseGhAccount(() => ({
        accounts: [acct("solo", true), {
          host: "ghe.example.com",
          login: "enterprise",
          active: false,
          source: "keyring",
        }],
      })),
    ).toEqual({ kind: "pinned", login: "solo" });
    // 2+ logins, non-TTY: the ACTIVE one is pinned, with a hint naming it and
    // the escape hatches (an env-token source is still a choice - it may
    // shadow a saved credential; the verify step is the gate, never the menu).
    let envChoice: Awaited<ReturnType<typeof chooseGhAccount>> | undefined;
    const envErr = await captureStderr(async () => {
      envChoice = await chooseGhAccount(() => ({
        accounts: [acct("solo", false), acct("ci-bot", true, "GH_TOKEN")],
      }));
    });
    expect(envChoice).toEqual({ kind: "pinned", login: "ci-bot" });
    expect(envErr).toContain("pinning the active one (ci-bot)");
    expect(envErr).toContain("--gh-user");
    // The env-token overlap of a saved login must not shrink the choice set.
    let overlapChoice: Awaited<ReturnType<typeof chooseGhAccount>> | undefined;
    await captureStderr(async () => {
      overlapChoice = await chooseGhAccount(() => ({
        accounts: [
          acct("octocat", true, "GH_TOKEN"),
          acct("octocat", false),
          acct("work-bot", false),
        ],
      }));
    });
    expect(overlapChoice).toEqual({ kind: "pinned", login: "octocat" });
    // 2+ logins and NO determinable active account: an error, never a guess.
    await expect(
      chooseGhAccount(() => ({ accounts: [acct("a", false), acct("b", false)] })),
    ).rejects.toThrow(
      "gh has 2 logged-in accounts and no pinnable active one - pass --gh-user <login> " +
        "(pinnable: a, b), or run `agent auth --provider gh-cli` in a terminal",
    );
    // A BROKEN entry still counts as an account: {healthy bystander, broken
    // active} is a multi-account machine, so the bystander is never pinned
    // silently - without a TTY that is the same honest error.
    await expect(
      chooseGhAccount(() => ({
        accounts: [acct("healthy", false), { ...acct("hurt", true), broken: true as const }],
      })),
    ).rejects.toThrow(
      "gh has 2 logged-in accounts and no pinnable active one - pass --gh-user <login> " +
        "(pinnable: healthy), or run `agent auth --provider gh-cli` in a terminal",
    );
    // A sole ENV-ONLY login still pins without a TTY (nothing to ask): its
    // verification failure names the recovery.
    expect(await chooseGhAccount(() => ({ accounts: [acct("solo", true, "GH_TOKEN")] })))
      .toEqual({ kind: "pinned", login: "solo" });
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
  // The shape gate: the pin becomes a `gh auth token --user` argv token that
  // crosses cmd.exe on Windows, so anything outside a GitHub login's alphabet
  // (blank included) is rejected before it can reach a shell.
  for (const bad of ["   ", "%USERNAME%", "a b", "x;rm", "why'd"]) {
    expect(() => parseAcquisition(undefined, undefined, bad)).toThrow(
      "--gh-user must be a GitHub login (1-39 letters, digits, dashes, or underscores)",
    );
  }
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

test("liveCredentialSourceLabel: an auto slot SAYS auto and lists what it may use, bracket-free", () => {
  const cred = { kind: "gh-cli", ghUser: null } as const;
  // Auto is explicit, the followed account is named, and every account it may
  // use is listed -- with NO nested brackets (callers add the one paren level).
  expect(
    liveCredentialSourceLabel(cred, () => ({
      accounts: [acct("octocat", true), acct("work-bot", false)],
    })),
  ).toBe("gh-cli on auto: currently octocat; may use octocat, work-bot");
  // Unproven/empty looks keep the bare auto label (never a guessed account),
  // and a pinned slot never spawns the look at all.
  expect(liveCredentialSourceLabel(cred, () => ({ accounts: [], unproven: true })))
    .toBe("gh-cli on auto");
  expect(
    liveCredentialSourceLabel({ kind: "gh-cli", ghUser: "work-bot" }, () => {
      throw new Error("a pinned slot must not probe gh");
    }),
  ).toBe("gh-cli as work-bot");
});

test("credentialSourceLabel: a pinned gh account is named, bracket-free", () => {
  // The static half of the read-back label: BRACKET-FREE by contract (the
  // surfaces wrap it in their one paren level; nested brackets are unreadable).
  expect(credentialSourceLabel({ kind: "gh-cli", ghUser: null })).toBe("gh-cli");
  expect(credentialSourceLabel({ kind: "gh-cli", ghUser: "work-bot" })).toBe(
    "gh-cli as work-bot",
  );
  expect(credentialSourceLabel({ kind: "stored", provider: "gh-token", token: "t" })).toBe(
    "gh-token",
  );
  expect(credentialSourceLabel({ kind: "none", provider: null })).toBeNull();
});

// The store reads STRICTLY: a fabricated "empty" would deny a credential that exists, since
// profiles never fall back.
//   unreadable store  -> the failed read is diagnosed, never "no credential" or "no such profile"
//   Windows, root     -> skipped: chmod 000 does not deny the read there
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
    const stateFile = new CopilotApiPaths().stateStoreFile;
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

// --- the device flow -----------------------------------------------------------------------------

/** GitHub's two device-flow endpoints, answering per `polls` in order (the last answer repeats). */
function stubDeviceFlow(polls: Array<Record<string, unknown>>): void {
  let poll = 0;
  setGithubLoginFetch((input, init) => {
    const body = JSON.parse(String(init?.body));
    if (input === GITHUB_DEVICE_CODE_URL) {
      expect(body).toEqual({ client_id: COPILOT_OAUTH_CLIENT_ID, scope: COPILOT_OAUTH_SCOPE });
      return Promise.resolve(Response.json({
        device_code: "dev-123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0,
      }));
    }
    if (input === GITHUB_ACCESS_TOKEN_URL) {
      expect(body).toEqual({
        client_id: COPILOT_OAUTH_CLIENT_ID,
        device_code: "dev-123",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const answer = polls[Math.min(poll, polls.length - 1)] ?? {};
      poll++;
      return Promise.resolve(Response.json(answer));
    }
    throw new Error(`unexpected fetch of ${input}`);
  });
}

test("auth --provider copilot lands the device-flow token in the slot and leaves no token file behind", async () => {
  const { claudeHome } = isolate();
  stubDeviceFlow([{ error: "authorization_pending" }, { access_token: "gho_device" }]);
  const announced = await captureStderr(() => runAuth({ provider: "copilot" }));
  expect(announced).toContain("https://github.com/login/device");
  expect(announced).toContain("ABCD-EFGH");
  expect(state().read()).toMatchObject({ githubToken: "gho_device", authProvider: "copilot" });
  // The store is the ONLY landing: nothing under the root home or the daemon home carries the token.
  const root = new CopilotApiPaths();
  for (const home of [dir, root.home]) {
    expect(existsSync(join(home, "github_token"))).toBe(false);
  }
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
});

test("githubDeviceFlowLogin: waits through slow_down at GitHub's longer interval, and ends on any other refusal", async () => {
  isolate();
  const waits: number[] = [];
  const sleep = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  const announce = () => {};
  stubDeviceFlow([{ error: "slow_down" }, { access_token: "gho_late" }]);
  expect(await githubDeviceFlowLogin({ sleep, announce })).toBe("gho_late");
  // interval 0 -> 0 ms, then +5 s after slow_down.
  expect(waits).toEqual([0, 5000]);
  stubDeviceFlow([{ error: "access_denied", error_description: "The user denied the request." }]);
  await expect(githubDeviceFlowLogin({ sleep, announce })).rejects.toThrow(
    "device-flow login failed: The user denied the request.",
  );
});
