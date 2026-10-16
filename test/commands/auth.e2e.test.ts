import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AuthArgs,
  acquireCredential,
  chooseGhAccount,
  ensureAuthenticated,
  ghCannotServeByName,
  loginWithGhCli,
  runAuth,
} from "../../src/commands/auth.ts";
import { runDryRun } from "../../src/commands/dry_run.ts";
import { addProfile } from "../../src/commands/profile.ts";
import { CODEX_IDENTITY_NAME } from "../../src/copilot_api/config_registry.ts";
import { CopilotEnvConfig } from "../../src/copilot_api/env_config.ts";
import { assertProfileSlot, CopilotEnvState } from "../../src/copilot_api/env_state.ts";
import {
  COPILOT_OAUTH_CLIENT_ID,
  COPILOT_OAUTH_SCOPE,
  GITHUB_GRAPHQL_URL,
  githubDeviceFlowLogin,
  githubLoginLook,
  setGithubLoginFetch,
} from "../../src/copilot_api/github_login.ts";
import {
  type ProbeFetch,
  setIntegrationProbeFetch,
} from "../../src/copilot_api/integration_identity.ts";
import { CopilotApiPaths, profileHome } from "../../src/copilot_api/paths.ts";
import { parseProfileName } from "../../src/copilot_api/profile.ts";
import { errMessage } from "../../src/utils/error.ts";
import { withColumns } from "../helpers/columns.ts";
import { stageRefusedStop } from "../helpers/daemon.ts";
import { envSnapshot, isolateAgentHomes, resetExitCode } from "../helpers/env.ts";
import { stubGithubLogins } from "../helpers/fixtures.ts";
import { captureChannels } from "../helpers/output.ts";
import { afterEach, expect, removeDir, test } from "../helpers/testing.ts";
import {
  AUTH_GH_CLI,
  acct,
  captureStderr,
  captureStdout,
  OCTOCAT_LOGINS,
  WORK,
  words,
} from "./auth_fixtures.ts";

const restoreEnv = envSnapshot(["PATH"]);
let dir = "";
/** The longest profile name and gh login the grammars allow: the widest labels a message carries. */
const LONGEST = parseProfileName("p".repeat(32));
const LOGIN = "l".repeat(39);

afterEach(() => {
  restoreEnv();
  resetExitCode();
  setGithubLoginFetch(null);
});

function isolate(): { claudeHome: string; codexHome: string } {
  const homes = isolateAgentHomes("copilot-auth-");
  dir = homes.dir;
  stubGithubLogins(OCTOCAT_LOGINS);
  return { claudeHome: homes.claudeHome, codexHome: homes.codexHome };
}

const PROVIDER_CONFLICT =
  "--provider selects how to authenticate and cannot combine with " + "--get/--del/--check";

// Every rejection fires at the parse, before any state read, probe, or prompt: the probe seam
// counts here, and a rejected flag set that probed first fails its row on the count. The bug
// pinned by the --provider rows: `--get --provider bogus` once ran --get and dropped the provider
// unvalidated.
test("auth: every conflicting or malformed flag set is refused at the parse, before any probe", async () => {
  isolate();
  let probes = 0;
  setIntegrationProbeFetch(() => {
    probes++;
    return Promise.reject(new Error("a flag rejection must precede any probe"));
  });
  const rows: { args: AuthArgs; error: string | RegExp }[] = [
    { args: { get: true, del: true }, error: "mutually exclusive" },
    { args: { get: true, check: true }, error: "mutually exclusive" },
    { args: { identity: true, identities: true }, error: "mutually exclusive" },
    { args: { provider: "bogus" }, error: "--provider must be one of" },
    {
      args: { set: "ghu_x", provider: "copilot" },
      error: "--set only applies to `--provider gh-token`",
    },
    { args: { set: "ghu_x", get: true }, error: "cannot combine" },
    { args: { get: true, provider: "bogus" }, error: PROVIDER_CONFLICT },
    { args: { del: true, provider: "copilot" }, error: PROVIDER_CONFLICT },
    { args: { check: true, provider: "gh-cli" }, error: PROVIDER_CONFLICT },
    { args: { identities: true, provider: "copilot" }, error: PROVIDER_CONFLICT },
    { args: { identity: "copilot-developer-cli", provider: "copilot" }, error: PROVIDER_CONFLICT },
    // Other rejections keep precedence over the conflict: an invalid name still reports itself.
    {
      args: { get: true, profile: "NOT valid", provider: "copilot" },
      error: /invalid profile name/,
    },
    // The id is validated at the flag like --provider.
    { args: { identity: CODEX_IDENTITY_NAME }, error: /cannot be pinned/ },
    { args: { identity: "evil\nX: 1" }, error: /header-safe/ },
    { args: { ghUser: "x", get: true }, error: "--gh-user pins the gh account" },
    { args: { ghUser: "x", del: true }, error: "--gh-user pins the gh account" },
    { args: { ghUser: "x", check: true }, error: "--gh-user pins the gh account" },
  ];
  try {
    for (const row of rows) {
      await expect(runAuth(row.args), JSON.stringify(row.args)).rejects.toThrow(row.error);
      expect(probes, JSON.stringify(row.args)).toBe(0);
    }
  } finally {
    setIntegrationProbeFetch(null);
  }
});

test("auth --del: a REFUSED stop warns the proxy is still running -- never the plain success", async () => {
  isolate();
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_refused",
  });
  const fx = stageRefusedStop(new CopilotApiPaths().home);
  try {
    // The raw capture: the warn is a block (headline, evidence, the stop command), and the fold
    // in captureStderr would read its indented lines as one.
    const err = await withColumns(
      80,
      async () => (await captureChannels(() => runAuth({ del: true }))).stderr,
    );
    expect(err).toContain(
      [
        "De-authenticated.",
        "  the proxy is still running",
        "  it may keep serving the old credential",
        "Fix:",
        "  agent stop  stop it",
      ].join("\n"),
    );
    expect(err).not.toContain("Then:");
  } finally {
    await fx.teardown();
  }
}, 30_000);

test("auth --del, --provider gh-env, and --set land exactly in the store and write no agent file", async () => {
  const rows: {
    name: string;
    arrange: () => void;
    args: AuthArgs;
    githubToken: string | null;
    authProvider: string | null;
  }[] = [
    {
      name: "--del clears the stored token and provider",
      arrange: () =>
        new CopilotEnvState().setCredential(null, {
          kind: "stored",
          provider: "gh-token",
          token: "ghu_stored123",
        }),
      args: { del: true },
      githubToken: null,
      authProvider: null,
    },
    {
      // A recorded, RESOLVING credential under another provider: an explicit provider must still
      // run (never short-circuited by "already authenticated").
      name: "--provider gh-env stores the env token + provider over a recorded credential",
      arrange: () => {
        new CopilotEnvState().setCredential(null, {
          kind: "stored",
          provider: "copilot",
          token: "ghu_old",
        });
        process.env.GH_TOKEN = "ghu_new_from_env";
      },
      args: { provider: "gh-env" },
      githubToken: "ghu_new_from_env",
      authProvider: "gh-env",
    },
    {
      name: "--set <token> stores it verbatim (no env, no UI) and records gh-token",
      arrange: () => {
        delete process.env.GH_TOKEN;
        delete process.env.GITHUB_TOKEN;
      },
      args: { set: "ghu_inline_value" },
      githubToken: "ghu_inline_value",
      authProvider: "gh-token",
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    const { claudeHome } = isolate();
    row.arrange();
    await runAuth(row.args);
    const { githubToken, authProvider, ghUser, profiles } = new CopilotEnvState().read();
    expect({ githubToken, authProvider, ghUser, profiles }, row.name).toEqual({
      githubToken: row.githubToken,
      authProvider: row.authProvider,
      ghUser: null,
      profiles: {},
    });
    // auth only manages the credential -- configuring Codex/Claude is `agent init`'s job.
    expect(existsSync(join(claudeHome, "settings.json")), row.name).toBe(false);
  }
});

test("auth --check: a configured provider reports authenticated with its account, exit 0", async () => {
  isolate();
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_stored123",
  });
  const out = await captureStdout(() => runAuth({ check: true }));
  // The status is human copy, so only its headline and source line are pinned; exit 0 is the
  // machine contract.
  expect(out).toContain("authenticated.\n  gh-token as octocat");
  expect(process.exitCode).toBe(0);
  // The account is a label, never a gate: a token GitHub rejects still reports the stored
  // provider as authenticated (exit 0) and says why the account is missing.
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_unknown",
  });
  const unverified = await captureStdout(() => runAuth({ check: true }));
  expect(unverified).toContain(
    "authenticated.\n  gh-token; account unverified: GitHub rejected it, HTTP 401",
  );
  expect(process.exitCode).toBe(0);
});

test("auth (bare) on a recorded provider names the account, then the two ways out as a table", async () => {
  isolate();
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_stored123",
  });
  // The raw capture: the table's indented rows are the layout under test, and the fold in
  // captureStderr would read them as wrapped continuations.
  const err = await withColumns(80, async () => (await captureChannels(() => runAuth({}))).stderr);
  expect(err).toContain(
    [
      "Already authenticated.",
      "  gh-token as octocat",
      "Pick one:",
      "  agent auth --provider <copilot|gh-cli|gh-token|gh-env>  switch the provider",
      "  agent auth --del                                        clear it",
    ].join("\n"),
  );
});

/** The shape every multi-part auth message prints in, at 80 columns: a headline, indented
 *  evidence, a lead, and the commands as a table. `run` returns the text where the message
 *  lands: a thrown Error's message, or the raw stderr or stdout (the fold in captureStderr would
 *  read the indented lines as one). */
test("every auth message with more than one part prints as a headline, evidence, lead, and command table", async () => {
  const thrown = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (e) {
      return errMessage(e);
    }
    throw new Error("expected a refusal");
  };
  const stderr = async (fn: () => Promise<unknown>): Promise<string> =>
    (await captureChannels(async () => void (await fn()))).stderr;
  const stdout = async (fn: () => Promise<unknown>): Promise<string> =>
    (await captureChannels(async () => void (await fn()))).stdout;
  const stored = () =>
    new CopilotEnvState().setCredential(null, {
      kind: "stored",
      provider: "gh-token",
      token: "ghu_stored123",
    });
  const rows: { name: string; run: () => Promise<string>; lines: string[] }[] = [
    {
      name: "--del with a stored token and no daemon",
      run: () => {
        stored();
        return stderr(() => runAuth({ del: true }));
      },
      lines: ["De-authenticated.", "Then:", "  agent auth  log in again"],
    },
    {
      name: "--del with nothing stored",
      run: () => stderr(() => runAuth({ del: true })),
      lines: ["Nothing to clear.", "  not authenticated", "Then:", "  agent auth  log in"],
    },
    {
      name: "--check with nothing stored",
      run: () => stdout(() => runAuth({ check: true })),
      lines: ["not authenticated.", "Fix:", "  agent auth  log in"],
    },
    {
      name: "--set lands the default credential",
      run: () => stderr(() => runAuth({ set: "ghu_x" })),
      lines: ["Authenticated (gh-token).", "Then:", "  agent init  configure Codex and Claude"],
    },
    {
      name: "a named --set with a recorded mode names the launchers",
      run: async () => {
        await captureChannels(() => addProfile(WORK, { mode: "proxy", noAuth: true }));
        return stderr(() => runAuth({ set: "ghu_x", profile: "work" }));
      },
      lines: [
        "Authenticated (gh-token).",
        "  for profile 'work'",
        "  both agents are wired for its proxy mode",
        "Then:",
        "  cl --profile work  launch Claude",
        "  cx --profile work  launch Codex",
      ],
    },
    {
      name: "a bare identity choice without a terminal",
      run: () => {
        stored();
        return thrown(() => runAuth({ identity: true }));
      },
      lines: [
        "no terminal to choose the identity in.",
        "Pick one:",
        "  agent profile set identity <id|auto>  pin an id, or auto",
        "  agent profile identity                show the current identity",
      ],
    },
    {
      name: "gh-token without a terminal or a --set",
      run: () => thrown(() => runAuth({ provider: "gh-token" })),
      lines: [
        "no GitHub token given.",
        "Pick one:",
        "  --set <token>      pass the token",
        "  --provider gh-env  copy one of COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN",
      ],
    },
    {
      name: "gh-env with nothing set",
      run: () => thrown(() => runAuth({ provider: "gh-env" })),
      lines: [
        "no GitHub token in the environment.",
        "Fix:",
        "  COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN  set one of these",
      ],
    },
    {
      name: "gh-env with two set and no terminal takes the most specific",
      run: () => {
        process.env.GH_TOKEN = "ghu_env_value";
        process.env.GITHUB_TOKEN = "ghu_x";
        return stderr(() => runAuth({ provider: "gh-env" }));
      },
      lines: [
        "Taking $GH_TOKEN (the most specific).",
        "  2 of $COPILOT_GITHUB_TOKEN, $GH_TOKEN, $GITHUB_TOKEN are set",
        "Then:",
        "  agent auth --provider gh-env  pick another in a terminal",
      ],
    },
    {
      name: "a bare --dry-run has no provider to plan from",
      run: () => thrown(() => runAuth({ dryRun: true })),
      lines: [
        "a dry run never prompts.",
        "  no provider to plan the default profile's credential slot from",
        "Pick one:",
        "  --provider <copilot|gh-cli|gh-token|gh-env>  plan that provider's landing",
        "  --set <token>                                plan a gh-token landing",
      ],
    },
    {
      name: "gh-token --dry-run without a --set",
      run: () => thrown(() => runAuth({ provider: "gh-token", dryRun: true })),
      lines: [
        "a dry run never prompts.",
        "  no token to plan the default profile's credential slot with",
        "Fix:",
        "  --set <token>  the token to land",
      ],
    },
    {
      name: "--set --dry-run plans the store write",
      run: () => stderr(() => runAuth({ set: "ghu_x", dryRun: true })),
      lines: [
        "Would store the given token.",
        "  in the default profile's credential slot",
        "  its GitHub account is looked up when the landing is real",
      ],
    },
    {
      name: "gh-env --dry-run with two set plans the most specific",
      run: () => {
        process.env.GH_TOKEN = "ghu_env_value";
        process.env.GITHUB_TOKEN = "ghu_x";
        return stderr(() => runAuth({ provider: "gh-env", dryRun: true }));
      },
      lines: [
        "Would land the token from $GH_TOKEN.",
        "  the most specific of 2 set",
        "  in the default profile's credential slot",
        "  its GitHub account is looked up when the landing is real",
      ],
    },
    {
      name: "a named --dry-run names the wiring it cannot plan",
      run: async () => {
        await captureChannels(() => addProfile(WORK, { mode: "proxy", noAuth: true }));
        return stderr(() => runAuth({ provider: "copilot", profile: "work", dryRun: true }));
      },
      lines: ["Would wire both agents for the landed token.", "  profile 'work' in proxy mode"],
    },
    {
      name: "a wiring command's dry run on no credential",
      run: () => thrown(() => runDryRun(() => ensureAuthenticated())),
      lines: [
        "a dry run never logs in.",
        "  default is not authenticated",
        "Fix:",
        "  agent auth  log in first, then re-run with --dry-run",
      ],
    },
    {
      name: "a named --del with the longest profile name, its daemon never started",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        new CopilotEnvState().setCredential(LONGEST, {
          kind: "stored",
          provider: "gh-token",
          token: "ghu_stored123",
        });
        return stderr(() => runAuth({ del: true, profile: LONGEST }));
      },
      lines: [
        "De-authenticated.",
        `  for profile '${LONGEST}'`,
        "Then:",
        `  agent profile ${LONGEST} auth  log in again`,
      ],
    },
    {
      name: "a named bare auth with the longest profile name on a recorded provider",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        new CopilotEnvState().setCredential(LONGEST, {
          kind: "stored",
          provider: "gh-token",
          token: "ghu_stored123",
        });
        return stderr(() => runAuth({ profile: LONGEST }));
      },
      lines: [
        "Already authenticated.",
        `  for profile '${LONGEST}'`,
        "  gh-token as octocat",
        // A command too wide for its column stacks the table; the command is one line however wide.
        "Pick one:",
        `  agent profile ${LONGEST} auth --provider <copilot|gh-cli|gh-token|gh-env>`,
        "    switch the provider",
        "",
        `  agent profile ${LONGEST} auth --del`,
        "    clear it",
      ],
    },
    {
      name: "headless gh pins the active account, the longest login",
      run: () =>
        stderr(() =>
          chooseGhAccount(
            AUTH_GH_CLI,
            () => ({ kind: "listed", accounts: [acct(LOGIN, true), acct("b", false)] }),
            "headless",
          ),
        ),
      lines: [
        "gh has 2 logged-in accounts; pinning the active one.",
        `  active account: ${LOGIN}`,
        "Pick one:",
        "  agent auth --provider gh-cli --gh-user <login>  pin another account",
        "  agent auth --provider gh-cli                    choose in a terminal (auto",
        "                                                  included)",
      ],
    },
    {
      name: "gh cannot serve the longest login by name",
      run: () => {
        const detail = "`gh auth token` exited 1: no oauth token found";
        return Promise.resolve(errMessage(ghCannotServeByName(LOGIN, detail, "agent auth")));
      },
      lines: [
        "gh cannot serve the pinned account by name.",
        `  account: ${LOGIN}`,
        "  `gh auth token` exited 1: no oauth token found",
        "Pick one:",
        "  gh auth login              re-login on gh 2.40 or newer, then retry",
        "  agent auth --gh-user auto  follow gh's active account (switches with gh)",
      ],
    },
    {
      name: "--check on the longest profile name with nothing stored",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        return stdout(() => runAuth({ check: true, profile: LONGEST }));
      },
      lines: [
        "not authenticated.",
        `  for profile '${LONGEST}'`,
        "Fix:",
        `  agent profile ${LONGEST} auth  log in`,
      ],
    },
    {
      name: "a named --del with nothing stored on the longest profile name",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        return stderr(() => runAuth({ del: true, profile: LONGEST }));
      },
      lines: [
        "Nothing to clear.",
        `  for profile '${LONGEST}'`,
        "  not authenticated",
        "Then:",
        `  agent profile ${LONGEST} auth  log in`,
      ],
    },
    {
      name: "a named --set with the longest profile name names the launchers",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        return stderr(() => runAuth({ set: "ghu_x", profile: LONGEST }));
      },
      lines: [
        "Authenticated (gh-token).",
        `  for profile '${LONGEST}'`,
        "  both agents are wired for its proxy mode",
        "Then:",
        `  cl --profile ${LONGEST}  launch Claude`,
        `  cx --profile ${LONGEST}  launch Codex`,
      ],
    },
    {
      name: "a named --dry-run with the longest profile name names the wiring",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        return stderr(() => runAuth({ provider: "copilot", profile: LONGEST, dryRun: true }));
      },
      lines: [
        "Would wire both agents for the landed token.",
        `  profile '${LONGEST}' in proxy mode`,
      ],
    },
    {
      name: "a wiring command's dry run on the longest unauthenticated profile",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        return thrown(() => runDryRun(() => ensureAuthenticated(LONGEST)));
      },
      lines: [
        "a dry run never logs in.",
        `  profile '${LONGEST}' is not authenticated`,
        "Fix:",
        `  agent profile ${LONGEST} auth  log in first, then re-run`,
        "                                                       with --dry-run",
      ],
    },
    {
      name: "--del on a half-created profile with the longest name: the store's refusal carries the verb's outcome",
      run: () => {
        mkdirSync(profileHome(LONGEST), { recursive: true });
        return stderr(() => runAuth({ del: true, profile: LONGEST }));
      },
      lines: [
        `profile '${LONGEST}' has no store slot.`,
        "  nothing to clear",
        "  half-created: its daemon home exists",
        "Fix:",
        // The command is too wide for its column at 80: the table stacks the meaning under it.
        `  agent profile ${LONGEST} add --direct|--proxy`,
        "    re-create it",
      ],
    },
    {
      name: "--del on a nonexistent profile with the longest name",
      run: () => stderr(() => runAuth({ del: true, profile: LONGEST })),
      lines: [
        `no such profile '${LONGEST}'.`,
        "  nothing to clear",
        "  no profiles exist",
        "Fix:",
        `  agent profile ${LONGEST} add --direct|--proxy  create it`,
      ],
    },
    {
      name: "--check on a half-created profile with the longest name",
      run: () => {
        mkdirSync(profileHome(LONGEST), { recursive: true });
        return stdout(() => runAuth({ check: true, profile: LONGEST }));
      },
      lines: [
        `profile '${LONGEST}' has no store slot.`,
        "  half-created: its daemon home exists",
        "Fix:",
        // The command is too wide for its column at 80: the table stacks the meaning under it.
        `  agent profile ${LONGEST} add --direct|--proxy`,
        "    re-create it",
      ],
    },
    {
      name: "a baked static-key stays until the rewire",
      run: () => {
        stored();
        new CopilotEnvConfig().setProfile(null, { "static-key": "claude" });
        return stderr(() => runAuth({}));
      },
      lines: [
        "static-key is claude.",
        "  Claude's baked value stays as it is",
        "Fix:",
        "  agent init  rewrites it",
      ],
    },
    {
      name: "--check on the longest profile name, authenticated",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        new CopilotEnvState().setCredential(LONGEST, {
          kind: "stored",
          provider: "gh-token",
          token: "ghu_stored123",
        });
        return stdout(() => runAuth({ check: true, profile: LONGEST }));
      },
      lines: ["authenticated.", `  for profile '${LONGEST}'`, "  gh-token as octocat"],
    },
    {
      name: "the gh CLI login pinned to the longest login",
      run: () =>
        stderr(() =>
          Promise.resolve(
            loginWithGhCli({ kind: "pinned", login: LOGIN }, () => ({
              kind: "found",
              token: "tok",
              command: `gh auth token --user ${LOGIN}`,
            })),
          ),
        ),
      lines: ["Using the gh CLI login as the Direct credential.", `  pinned to account ${LOGIN}`],
    },
    {
      name: "a copilot --dry-run on the longest profile name plans the device flow",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        return stderr(() => runAuth({ provider: "copilot", profile: LONGEST, dryRun: true }));
      },
      lines: [
        "Would run GitHub's device flow and land the token.",
        `  in profile '${LONGEST}''s credential slot`,
      ],
    },
    {
      name: "a gh-cli --dry-run pinned to the longest login on the longest profile name",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        return stderr(() =>
          runDryRun(() =>
            acquireCredential(
              { kind: "gh-cli", account: { kind: "pinned", login: LOGIN } },
              LONGEST,
              { look: () => ({ kind: "found", token: "gho_saved", command: "gh auth token" }) },
            ),
          ),
        );
      },
      lines: [
        "Would record the gh CLI login.",
        `  pinned to account ${LOGIN}`,
        `  in profile '${LONGEST}''s credential slot`,
      ],
    },
    {
      name: "the login step on the longest profile name",
      run: async () => {
        await captureChannels(() => addProfile(LONGEST, { mode: "proxy", noAuth: true }));
        return stderr(() => ensureAuthenticated(LONGEST, { kind: "gh-token", token: "ghu_x" }));
      },
      lines: [
        "  Not authenticated yet - let's log in to GitHub Copilot.",
        `    for profile '${LONGEST}'`,
      ],
    },
  ];
  if (process.platform !== "win32") {
    rows.push({
      name: "--check with a gh-cli pin and no gh on PATH",
      run: () => {
        new CopilotEnvState().setCredential(null, { kind: "gh-cli", ghUser: "octocat" });
        const emptyBin = join(dir, "empty-bin");
        mkdirSync(emptyBin, { recursive: true });
        process.env.PATH = emptyBin;
        return stdout(() => runAuth({ check: true }));
      },
      lines: [
        "no credential resolves.",
        "  provider 'gh-cli as octocat' is selected",
        "Fix:",
        "  agent auth  log in again",
      ],
    });
  }
  const hadTty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    for (const row of rows) {
      dir = removeDir(dir);
      isolate();
      delete process.env.COPILOT_GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      const text = await withColumns(80, row.run);
      expect(text, row.name).toContain(row.lines.join("\n"));
      // A wrapped headline's tail is indented like evidence, so no headline may wrap: the basic
      // (CI) reporter's widest first-line lead is `[success] `, ten columns.
      expect(row.lines[0]?.length, row.name).toBeLessThanOrEqual(70);
      resetExitCode();
    }
  } finally {
    process.stdin.isTTY = hadTty;
  }
});

test("auth (bare) keys idempotency on the RECORDED provider: recorded, nothing runs; none, the flow runs even when gh works", async () => {
  const { claudeHome } = isolate();
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "copilot",
    token: "ghu_stored123",
  });
  await runAuth({});
  expect(new CopilotEnvState().read().githubToken).toBe("ghu_stored123");
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
  // Idempotency keys on the RECORDED choice, not on whether gh works: otherwise a machine with a gh
  // login could never reach a fresh login. The non-TTY throw proves the flow ran, not a gh
  // short-circuit.
  dir = removeDir(dir);
  isolate();
  // At 80 columns the provider row's description wraps under its own column, never under the
  // command; the message is the user's whole way out, so every line is the contract.
  await withColumns(80, async () => {
    await expect(runAuth({})).rejects.toThrow(
      [
        "not a terminal - store a credential first.",
        "Pick one:",
        "  agent auth --provider gh-env                          copy a token from",
        "                                                        $COPILOT_GITHUB_TOKEN /",
        "                                                        $GH_TOKEN /",
        "                                                        $GITHUB_TOKEN (headless)",
        "  agent auth --provider copilot|gh-cli|gh-token|gh-env  store a credential by",
        "                                                        provider",
        "  agent auth --set <token>                              store a GitHub token",
      ].join("\n"),
    );
  });
  // A named profile's refusal names ITS auth command: `agent auth` would store into the default slot.
  const work = await acquireCredential({ kind: "choose" }, parseProfileName("work")).then(
    () => "",
    (e: Error) => e.message,
  );
  expect(work).toContain("agent profile work auth --provider gh-env");
  expect(work).toContain("agent profile work auth --provider copilot|gh-cli|gh-token|gh-env");
  expect(work).toContain("agent profile work auth --set <token>");
});

test("headless gh-token never reads the env: that is gh-env's job", async () => {
  isolate();
  new CopilotEnvState().clearCredential(null);
  process.env.GH_TOKEN = "ghu_env_value";
  await expect(runAuth({ provider: "gh-token" })).rejects.toThrow(/--set <token>/);
  expect(new CopilotEnvState().read().githubToken).toBeNull();
  delete process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  await expect(runAuth({ provider: "gh-env" })).rejects.toThrow(/GH_TOKEN/);
});

test("a named auth on an unknown profile errors instead of creating a half profile", async () => {
  isolate();
  // A profile is created ONLY by `agent profile <name> add`'s atomic commit, so re-auth refuses an
  // unknown name BEFORE any acquisition runs.
  await expect(runAuth({ set: "ghu_x", profile: "ghost" })).rejects.toThrow(
    /no such profile 'ghost'/,
  );
  expect(new CopilotEnvState().read().profiles).toEqual({});

  const ghost = parseProfileName("ghost");
  new CopilotEnvState().commitProfile(ghost, {
    credential: { kind: "stored", provider: "gh-token", token: "ghu_old" },
    mode: "direct",
  });
  // A complete Direct profile is rebaked by the landing: every credential probes (the codex
  // identity accepted here), and the pair the probe selected is stored beside the new credential.
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
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
  expect(new CopilotEnvState().read().githubToken).toBeNull(); // default slot untouched
});

test("token acquisition narrates 'Using' + the account, never 'Stored' (persistence is the caller's write)", async () => {
  isolate();
  // The token is only ACQUIRED here -- `agent profile <name> add` commits it later,
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
  expect(new CopilotEnvState().read().githubToken).toBe("ghu_unlisted_0123456789");
});

test("githubLoginLook asks GraphQL for the viewer and reads a login, a 401, or an unreachable GitHub", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const answer =
    (status: number, body: string): ProbeFetch =>
    (url, init) => {
      seen.push({ url: String(url), init });
      return Promise.resolve(new Response(body, { status }));
    };
  expect(
    await githubLoginLook("ghp_a", answer(200, '{"data":{"viewer":{"login":"octocat"}}}')),
  ).toEqual({ login: "octocat" });
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

test("auth --get/--del/--check on a named profile per slot state: nonexistent hints at `agent profile <name> add`, half-created reuses the store's missing-slot phrasing, partial (de-authed, mode kept) re-auths in place", async () => {
  const ghost = parseProfileName("ghost");
  // Asserted without backticks: consola renders code spans, stripping them.
  const addCommand = "agent profile ghost add --direct|--proxy";
  const rows: {
    name: string;
    /** Stages the slot and returns the needle --check's hint must carry (for the half-created
     *  slot, the store's WHOLE message folded like the captured output, so a rewording on either
     *  side fails here). */
    arrange: () => string;
    /** Needles every verb's output carries. */
    says: string[];
    /** A needle --get and --del never carry: the other slot state's hint. */
    never: string;
    delSays: string;
  }[] = [
    {
      // Recommending a re-auth would hit the no-store-slot gate, so the hint reuses the store's
      // no-such-profile phrasing.
      name: "nonexistent",
      arrange: () => "no such profile 'ghost'.",
      says: ["no such profile 'ghost'.", addCommand],
      never: "ghost auth",
      delSays: "no such profile 'ghost'. nothing to clear no profiles exist",
    },
    {
      // A daemon home without a store slot (an interrupted add): the store's own write gate words
      // this "half-created", so the read-back hints must say the same, never "no such profile".
      name: "half-created",
      arrange: () => {
        mkdirSync(profileHome(ghost), { recursive: true });
        // Alignment pin: the store's own gate renders the same phrase + command, so a rewording
        // on either side fails here.
        let storeMessage = "";
        try {
          assertProfileSlot(ghost);
        } catch (e) {
          storeMessage = errMessage(e);
        }
        expect(storeMessage).toContain("profile 'ghost' has no store slot.");
        expect(storeMessage).toContain(addCommand);
        // Folded like the captured --check output, whose lines the comparison also folds.
        return words(storeMessage);
      },
      says: ["profile 'ghost' has no store slot.", addCommand],
      never: "no such profile",
      delSays: "profile 'ghost' has no store slot. nothing to clear half-created",
    },
    {
      // A partial slot (de-authed, mode kept) re-auths in place, so the hint stays
      // `agent profile <name> auth`.
      name: "partial",
      arrange: () => {
        new CopilotEnvState().commitProfile(ghost, {
          credential: { kind: "stored", provider: "gh-token", token: "ghu_old" },
          mode: "direct",
        });
        new CopilotEnvState().clearCredential(ghost);
        return "Fix: agent profile ghost auth  log in";
      },
      says: ["agent profile ghost auth"],
      never: "ghost add",
      delSays: "Nothing to clear. for profile 'ghost'",
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    isolate();
    const checkSays = row.arrange();
    const got = await captureStderr(() => runAuth({ get: true, profile: "ghost" }));
    expect(process.exitCode, row.name).toBe(1);
    resetExitCode();
    const deleted = await captureStderr(() => runAuth({ del: true, profile: "ghost" }));
    for (const out of [got, deleted]) {
      for (const needle of row.says) expect(out, row.name).toContain(needle);
      expect(out, row.name).not.toContain(row.never);
    }
    expect(deleted, row.name).toContain(row.delSays);
    resetExitCode();
    const checked = words(await captureStdout(() => runAuth({ check: true, profile: "ghost" })));
    for (const needle of row.says) expect(checked, row.name).toContain(needle);
    expect(checked, row.name).toContain(checkSays);
    expect(process.exitCode, row.name).toBe(1);
    resetExitCode();
  }
});

// The store reads STRICTLY: a fabricated "empty" would deny a credential that exists, since
// profiles never fall back.
//   unreadable store  -> the failed read is diagnosed, never "no credential" or "no such profile"
//   Windows, root     -> skipped: chmod 000 does not deny the read there
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable credential store throws at read, never 'no credential / no such profile'",
  () => {
    isolate();
    new CopilotEnvState().setCredential(null, {
      kind: "stored",
      provider: "gh-token",
      token: "ghu_keep",
    });
    const work = parseProfileName("work");
    new CopilotEnvState().commitProfile(work, {
      credential: { kind: "stored", provider: "gh-token", token: "ghu_work" },
      mode: "proxy",
    });
    const stateFile = new CopilotApiPaths().stateStoreFile;
    chmodSync(stateFile, 0o000);
    try {
      expect(() => new CopilotEnvState().readCredential(null)).toThrow(
        "refusing to treat an unreadable store as empty",
      );
      expect(() => new CopilotEnvState().profileSlotStatus(work)).toThrow(stateFile);
      expect(() => assertProfileSlot(work)).toThrow(stateFile);
    } finally {
      chmodSync(stateFile, 0o600);
    }
    // Control: readable again, the same reads answer the stored slots.
    expect(new CopilotEnvState().readCredential(null)).toEqual({
      kind: "stored",
      provider: "gh-token",
      token: "ghu_keep",
    });
    expect(new CopilotEnvState().profileSlotStatus(work).exists).toBe(true);
  },
);

// --- the device flow -----------------------------------------------------------------------------

// GitHub's two device-flow endpoints, where the library's requests leave the program.
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** GitHub's two device-flow endpoints, answering per `polls` in order (the last answer repeats). */
function stubDeviceFlow(polls: Array<Record<string, unknown>>): void {
  let poll = 0;
  setGithubLoginFetch((input, init) => {
    const body = JSON.parse(String(init?.body));
    if (input === GITHUB_GRAPHQL_URL) {
      // The landed token's account line: the device-flow token reads as octocat's.
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
      return Promise.resolve(
        token === "gho_device"
          ? Response.json({ data: { viewer: { login: "octocat" } } })
          : new Response('{"message":"Bad credentials"}', { status: 401 }),
      );
    }
    if (input === GITHUB_DEVICE_CODE_URL) {
      expect(body).toEqual({ client_id: COPILOT_OAUTH_CLIENT_ID, scope: COPILOT_OAUTH_SCOPE });
      return Promise.resolve(
        Response.json({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        }),
      );
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
  stubDeviceFlow([
    { error: "authorization_pending" },
    {
      access_token: "gho_device",
      scope: "read:user",
    },
  ]);
  const announced = await captureStderr(() => runAuth({ provider: "copilot" }));
  expect(announced).toContain("https://github.com/login/device");
  expect(announced).toContain("ABCD-EFGH");
  expect(announced).toContain("Using the device-flow token as octocat.");
  expect(new CopilotEnvState().read()).toMatchObject({
    githubToken: "gho_device",
    authProvider: "copilot",
  });
  // The store is the ONLY landing: nothing under the root home or the daemon home carries the token.
  const root = new CopilotApiPaths();
  for (const home of [dir, root.home]) {
    expect(existsSync(join(home, "github_token"))).toBe(false);
  }
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
});

test("githubDeviceFlowLogin: GitHub's refusal surfaces with its own description, not the library's wrapper", async () => {
  isolate();
  // The library wraps a refusal as `<description> (<error>, <uri>)` on a RequestError; the user
  // reads GitHub's sentence alone.
  stubDeviceFlow([
    {
      error: "access_denied",
      error_description: "The user denied the request.",
      error_uri: "https://docs.github.com/apps/oauth",
    },
  ]);
  await expect(githubDeviceFlowLogin({ announce: () => {} })).rejects.toThrow(
    /^device-flow login failed: The user denied the request\.$/,
  );
});
