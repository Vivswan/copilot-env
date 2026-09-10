// `agent auth`: the single front door for the Direct-mode GitHub credential. It
// ONLY manages the credential -- acquiring it, reading it back, checking status,
// clearing it. Configuring Codex/Claude (direct vs proxy) is `agent init`'s job.
// The credential domain (provider-driven resolution, status, state writes) lives in
// the `Credential` class (`src/copilot_api/credential.ts`); this module is the thin
// command + interactive layer on top: provider prompt, device-flow spawn, `runAuth`.
// The agent Direct configs call `agent auth --get` at fetch time, so this command is
// also the resolver they shell into.
//
// Bare `agent auth` (no --provider) prompts you to choose a provider; `--provider`
// picks one non-interactively:
//   - copilot  : interactive GitHub device flow, run via the installed copilot-api
//                (`<entry> auth login --provider copilot`, scope read:user). It
//                writes copilot-api's own github_token file; we copy that into our
//                store and scrub it, so the token rests only in our state.
//   - gh-cli   : rely on the machine's `gh` login (stores nothing; `--get` runs
//                `gh auth token`).
//   - gh-token : store a token. `--set <token>` provides it inline (no UI), `--set`
//                (bare) reads $COPILOT_GITHUB_TOKEN/$GH_TOKEN/$GITHUB_TOKEN (headless
//                `--set` it prefers those env vars, else prompts for the token in a TTY.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { consola } from "consola";
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { refreshCodexCatalogAndSync } from "../codex/catalog_reference.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import {
  AUTH_PROVIDERS,
  type AuthProvider,
  Credential,
  type GhAccountsLook,
  ghAccountsLook,
  ghAuthTokenLook,
  type GhTokenLook,
} from "../copilot_api/credential.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import {
  assertProfileSlot,
  CopilotEnvState,
  type ProvisionedCredential,
  type StoredCredential,
} from "../copilot_api/env_state.ts";
import {
  activeGhLogin,
  GH_COPILOT_HOST,
  GH_LOGIN_RE,
  ghTokenEnvVarsLabel,
  ghTokenEnvVarsList,
  ghTokenFromEnv,
  tokenFromSetFlag,
} from "../copilot_api/gh_cli.ts";
import { CopilotApiPaths, profileHomeNames } from "../copilot_api/paths.ts";
import {
  copilotApiArgv,
  copilotApiEnv,
  DAEMON_SIGKILL_GRACE_MS,
  resolveCopilotApiEntry,
} from "../copilot_api/process.ts";
import { resolveDenoBin } from "../copilot_api/sidecar.ts";
import {
  parseProfileFlag,
  type Profile,
  profileLabel,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { installedProxyVersion } from "../copilot_api/version.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { withFileLockSync } from "../utils/file_lock.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { printTable } from "../utils/table.ts";
import { removeReported } from "../utils/report_write.ts";

// Narration to stderr so `--get`'s stdout stays a clean machine-readable token.
const logger = createStderrLogger();

// The provider vocabulary rendered for flag hints ("copilot|gh-cli|gh-token"), derived
// from AUTH_PROVIDERS (env_state.ts owns the list) so these messages can never drift.
const PROVIDER_CHOICES = AUTH_PROVIDERS.join("|");

export interface AuthArgs {
  /** `--provider`: which provider to authenticate with (no flag => interactive choice). */
  provider?: string;
  /** `--set [token]`: provide the gh-token value non-interactively (verbatim, or env when bare). */
  set?: string | boolean;
  /** `--gh-user <login>`: pin gh-cli to that logged-in gh account (implies `--provider gh-cli`). */
  ghUser?: string;
  /** `--get`: print the resolved token to stdout (what the agent configs call). */
  get?: boolean;
  /** `--del`: clear the stored token (de-authenticate). */
  del?: boolean;
  /** `--check`: report auth status; exit 0 authenticated, 1 not. */
  check?: boolean;
  /** `--print-proxy-token`: print the local proxy's API key to stdout (for proxy-mode agents). */
  printProxyToken?: boolean;
  /** `--profile <name>`: address a NAMED credential profile instead of the default. */
  profile?: string;
  /** `--list`: list the default + named credential profiles (providers only, never tokens). */
  list?: boolean;
}

function asProvider(provider: string): AuthProvider {
  const p = provider.trim().toLowerCase();
  if ((AUTH_PROVIDERS as readonly string[]).includes(p)) return p as AuthProvider;
  throw new Error(`--provider must be one of: ${AUTH_PROVIDERS.join(", ")} (got '${provider}')`);
}

/** Where a gh-token comes from: `--set <token>` (verbatim, no UI / no env), bare `--set`
 *  (the GH token env vars only -- headless, never prompts), or no `--set` at all (prefer
 *  the env vars, else prompt for it in a TTY). The token itself is read at acquisition
 *  time (loginWithGhToken), not here. */
type GhTokenSource =
  | { kind: "inline"; token: string }
  | { kind: "env" }
  | { kind: "env-or-prompt" };

/** Which gh account a gh-cli acquisition uses, as PARSED from the flags:
 *  `pinned` records one login (`gh auth token --user`); `choose` asks (the
 *  bare/interactive flow). Auto is never a flag value -- it is what `choose`
 *  SETTLES to (SettledGhAccount below), carrying the active login so the
 *  narration can always name the account in use. */
type GhCliAccountChoice =
  | { kind: "pinned"; login: string }
  | { kind: "choose" };

/** A gh-cli account choice after settling. PINNING IS THE ONLY DEFAULT: the
 *  credential must never follow an account the user did not choose (their
 *  Copilot credit would burn on it after a `gh auth login`/switch). Auto exists
 *  solely as the picker's explicit last option; every settle path either pins a
 *  named login or errors with the escape hatches. */
type SettledGhAccount =
  | { kind: "auto"; activeLogin: string | null }
  | { kind: "pinned"; login: string };

/** A credential acquisition with the provider already settled (interactively or by flag). */
type ResolvedAcquisition =
  | { kind: "copilot" }
  | { kind: "gh-cli"; account: GhCliAccountChoice }
  | { kind: "gh-token"; source: GhTokenSource };

/**
 * How to acquire a credential, parsed ONCE from the raw `--provider`/`--set`/
 * `--gh-user` flags by `parseAcquisition` (the shared boundary for `agent auth`
 * and `agent profile --add`). A `--set` token can only ever travel inside the
 * gh-token variant (and a `--gh-user` pin inside the gh-cli one), so
 * `authenticate` cannot receive either under the wrong provider and silently
 * drop it.
 */
export type CredentialAcquisition = { kind: "choose" } | ResolvedAcquisition;

/** Map a settled provider name onto its acquisition: gh-token logs in via the
 *  env-else-prompt token flow; gh-cli asks which gh account (settling to auto
 *  when there is no real choice); copilot carries the provider itself. */
function acquisitionForProvider(provider: AuthProvider): ResolvedAcquisition {
  switch (provider) {
    case "gh-token":
      return { kind: "gh-token", source: { kind: "env-or-prompt" } };
    case "gh-cli":
      return { kind: "gh-cli", account: { kind: "choose" } };
    case "copilot":
      return { kind: "copilot" };
    default:
      return assertNever(provider);
  }
}

/**
 * Parse the raw `--provider [name]` / `--set [token]` / `--gh-user [login]` flags into a
 * CredentialAcquisition: the ONE place "--set implies gh-token" and "--gh-user implies
 * gh-cli" live (each rejecting a conflicting provider, and one another), shared by
 * `agent auth` and `agent profile --add`. The two differ on which error wins for
 * `--set x --provider bogus`: `agent auth` validates the provider name first, while
 * `agent profile --add` treats ANY non-gh-token string as the --set conflict
 * (`setConflictWins`). Both keep their exact messages.
 */
export function parseAcquisition(
  provider: string | undefined,
  set: string | boolean | undefined,
  ghUser: string | undefined,
  opts: { setConflictWins?: boolean } = {},
): CredentialAcquisition {
  if (ghUser !== undefined) {
    if (set !== undefined) {
      throw new Error(
        "--gh-user only applies to `--provider gh-cli` (--set implies gh-token)",
      );
    }
    if (provider !== undefined && asProvider(provider) !== "gh-cli") {
      throw new Error("--gh-user only applies to `--provider gh-cli`");
    }
    const login = ghUser.trim();
    if (!GH_LOGIN_RE.test(login)) {
      throw new Error(
        "--gh-user must be a GitHub login (1-39 letters, digits, dashes, or underscores)",
      );
    }
    return { kind: "gh-cli", account: { kind: "pinned", login } };
  }
  if (set !== undefined) {
    const isGhToken = provider === undefined ||
      (opts.setConflictWins
        ? provider.trim().toLowerCase() === "gh-token"
        : asProvider(provider) === "gh-token");
    if (!isGhToken) {
      throw new Error("--set only applies to `--provider gh-token`");
    }
    // Commander's `--set [token]` never produces `false` today, but a future
    // negatable flag must not silently turn into "read the env".
    if (set === false) {
      throw new Error("`--set` requires a token value");
    }
    return {
      kind: "gh-token",
      source: typeof set === "string" ? { kind: "inline", token: set } : { kind: "env" },
    };
  }
  if (provider === undefined) return { kind: "choose" };
  return acquisitionForProvider(asProvider(provider));
}

/** Per-provider picker labels, keyed EXHAUSTIVELY on AuthProvider so a vocabulary
 *  change fails the compile here instead of silently missing a picker option. */
const PROVIDER_PICKER_DETAIL: Record<AuthProvider, string> = {
  "copilot": "device-flow browser login (read:user scope)",
  "gh-cli": "use the machine's `gh auth login`",
  "gh-token": `store ${ghTokenEnvVarsLabel(" / ")} (headless)`,
};

/** Interactive provider picker for bare `agent auth`. Errors out without a TTY. */
async function chooseProvider(): Promise<AuthProvider> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `not a terminal - pass --provider ${PROVIDER_CHOICES} (e.g. \`agent auth --provider gh-token\`)`,
    );
  }
  const value = await consola.prompt("How should GitHub Copilot authenticate?", {
    type: "select",
    options: AUTH_PROVIDERS.map((provider) => ({
      label: `${provider} - ${PROVIDER_PICKER_DETAIL[provider]}`,
      value: provider,
    })),
    cancel: "reject",
  });
  return asProvider(String(value));
}

/**
 * Settle which gh account a gh-cli acquisition uses. PINNING IS THE ONLY DEFAULT (see
 * SettledGhAccount): the sole login pins itself (unless it is env-only under a TTY: its
 * pin may fail verification with nothing to escape to, so the user decides), several
 * logins pin the active one when no TTY can ask, and the picker lists the accounts first
 * with auto as the explicit LAST option -- a later `gh auth login` must never switch whose
 * Copilot credit gets spent. When nothing can be pinned HONESTLY (unreadable account list,
 * no accounts, unknowable active account), this THROWS naming the escape hatches rather
 * than recording auto. `look` is a test seam; exported for the settle-rule tests.
 */
export async function chooseGhAccount(
  look: () => GhAccountsLook = ghAccountsLook,
): Promise<SettledGhAccount> {
  const { accounts, unproven } = look();
  if (unproven) {
    throw new Error(
      "could not list gh accounts (`gh auth status` did not run to completion) - " +
        "retry `agent auth`, or pass --gh-user <login>",
    );
  }
  // Copilot authenticates against GH_COPILOT_HOST: another host's login is a
  // menu entry the pinned resolver cannot serve. The SOURCE never filters the
  // menu (no hidden information) -- gh's status shows only the winning source
  // per login, so an exported GH_TOKEN shadows a saved keyring credential
  // ("Vivswan (GH_TOKEN)" with a perfectly pinnable login underneath). The menu
  // notes an env-token source instead, and loginWithGhCli verifies the chosen
  // account before anything is recorded, so a genuinely unservable pick fails
  // there with its own actionable error instead of being hidden here. A BROKEN
  // login (a failed/timed-out credential) is the one exclusion -- pinning it
  // could never verify -- yet it still names the active account below.
  const github = accounts.filter((a) => a.host === GH_COPILOT_HOST && a.broken !== true);
  const logins = [...new Set(github.map((a) => a.login))];
  // Broken entries still count as ACCOUNTS when deciding whether there is a
  // choice to make: a broken active login is never abandoned for a healthy
  // bystander without asking (its owner never chose to stop spending on it).
  const allLogins = [
    ...new Set(accounts.filter((a) => a.host === GH_COPILOT_HOST).map((a) => a.login)),
  ];
  const active = activeGhLogin(accounts);
  // A login whose EVERY listing is an env-token source may not have a saved
  // credential behind it; say so on the option rather than hiding it.
  const envOnly = (login: string): string | null => {
    const sources = github.filter((a) => a.login === login).map((a) => a.source);
    const envSource = sources.find((s) => /_TOKEN$/.test(s));
    return envSource !== undefined && sources.every((s) => /_TOKEN$/.test(s)) ? envSource : null;
  };
  if (logins.length === 0) {
    throw new Error(
      "gh has no logged-in github.com account - run `gh auth login`, then retry `agent auth`",
    );
  }
  if (logins.length === 1 && allLogins.length === 1) {
    const only = logins[0] ?? "";
    // A sole ENV-ONLY login may have no saved credential behind its token, so
    // its pin can fail verification with no other account to escape to --
    // interactively the user decides (try the pin, or explicit auto); without
    // a TTY the pin proceeds and a failure names the recovery.
    if (!process.stdin.isTTY || envOnly(only) === null) {
      return { kind: "pinned", login: only };
    }
  }
  if (!process.stdin.isTTY) {
    // No TTY to ask: pin the active account when it is pickable; anything else
    // would guess whose credit to spend, so it is an error, never a fallback.
    if (active !== null && logins.includes(active)) {
      logger.info(
        `gh has ${allLogins.length} logged-in accounts; pinning the active one (${active}). ` +
          "Pass --gh-user <login> to pin another, or run interactively to choose (auto included).",
      );
      return { kind: "pinned", login: active };
    }
    throw new Error(
      `gh has ${allLogins.length} logged-in accounts and no pinnable active one - pass ` +
        `--gh-user <login> (pinnable: ${logins.join(", ")}), or run ` +
        "`agent auth --provider gh-cli` in a terminal",
    );
  }
  // Accounts first (the active one leading -- it is the default selection),
  // auto LAST and explicit: pinning is the default posture.
  const ordered = [...logins].sort((a, b) => Number(b === active) - Number(a === active));
  const activeLabel = active === null ? "" : ` (currently ${active})`;
  const value = await consola.prompt("Which gh account should Direct auth use?", {
    type: "select",
    options: [
      ...ordered.map((login) => {
        const env = envOnly(login);
        const notes = [
          login === active ? "currently active" : null,
          env === null ? null : `via $${env}; pinning needs a saved login`,
        ].filter((n) => n !== null).join("; ");
        return {
          label: `${login} - always use this account${notes ? ` (${notes})` : ""}`,
          value: login,
        };
      }),
      // A GitHub login is never empty, so "" cannot collide with a real choice.
      {
        label: `auto - follow gh's active account${activeLabel}; switches when you switch gh`,
        value: "",
      },
    ],
    cancel: "reject",
  });
  const login = String(value);
  return login === "" ? { kind: "auto", activeLogin: active } : { kind: "pinned", login };
}

// --- provider acquisition ---------------------------------------------------

/**
 * `copilot`: run the INSTALLED/floated copilot-api's device-flow login (not `npx @latest`,
 * which would bypass the supply-chain cooldown + the float). It writes its own github_token
 * file; return that token for the caller's single store write and scrub copilot-api's copy.
 * Interactive: inherits stdio so the device-code URL and prompt are shown.
 */
function loginWithCopilot(): string {
  const entry = resolveCopilotApiEntry();
  if (entry.kind === "package" && installedProxyVersion() === null) {
    throw new Error(
      "cannot run the device-flow login - copilot-api is not installed. " +
        "Re-run the agent launcher to install dependencies, or use `agent auth --provider gh-token`.",
    );
  }
  const { githubTokenFile: tokenFile, githubTokenLoginLock: lockPath } = new CopilotApiPaths();
  // The WHOLE spawn+read+scrub sequence holds a lock on the shared github_token file: every
  // profile's device flow funnels through that ONE file, so two concurrent logins (default +
  // a profile, or two profiles) could otherwise read each other's token into the wrong slot.
  // Dead-holder-only reclaim (Infinity): an interactive login legitimately holds it for
  // minutes.
  return withFileLockSync(lockPath, {
    staleMs: Number.POSITIVE_INFINITY,
    waitMs: Number.POSITIVE_INFINITY,
    retryMs: 500,
    onWait: () =>
      logger.info("Another device-flow login is in progress; waiting for it to finish ..."),
  }, () => {
    const result = spawnSync(
      resolveDenoBin(),
      copilotApiArgv(["auth", "login", "--provider", "copilot"], [], entry),
      {
        stdio: "inherit",
        windowsHide: true,
        env: { ...process.env, ...copilotApiEnv(entry) },
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `device-flow login failed${
          result.error ? `: ${result.error.message}` : ` (exit ${result.status})`
        }`,
      );
    }
    let token: string;
    try {
      token = readFileSync(tokenFile, "utf8").trim();
    } catch (e) {
      throw new Error(
        `login succeeded but its GitHub token wasn't found at ${tokenFile}: ${errMessage(e)}`,
      );
    }
    if (!token) throw new Error("the device-flow login did not produce a GitHub token");
    // Scrub copilot-api's copy so the token rests only in our state (the proxy
    // receives it via `--github-token` from there, so this file is redundant).
    // The caller persists AFTER this scrub (the commit is the caller's, so it
    // can land atomically with a profile's mode); a crash in between costs one
    // re-login, never a leaked token file.
    try {
      removeReported(tokenFile);
    } catch {
      // best-effort
    }
    return token;
  });
}

/**
 * Read a line from the terminal WITHOUT echoing it -- for pasting a secret token so
 * it never lingers on screen or in scrollback. consola's text prompt echoes input
 * and has no masked variant, so we drive readline with a muted output stream (echo
 * is discarded) and print the query to stderr ourselves, keeping `--get`'s stdout
 * contract untouched.
 */
function readSecret(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stderr.write(query);
    rl.question("", (answer) => {
      process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("cancelled"));
    });
  });
}

/** Interactive masked prompt for a gh-token. Errors out without a TTY. */
async function promptForGhToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `no GitHub token found: pass \`--set <token>\` or set one of ${ghTokenEnvVarsList()}`,
    );
  }
  const token = (await readSecret("Paste your Copilot-enabled GitHub token: ")).trim();
  if (token === "") throw new Error("the provided GitHub token is empty");
  return token;
}

/**
 * `gh-token`: resolve the token to store, from wherever `source` says it comes:
 *   - inline (`--set <token>`) : the value verbatim (no UI / no env).
 *   - env (bare `--set`)       : read $COPILOT_GITHUB_TOKEN/$GH_TOKEN/$GITHUB_TOKEN, error if none set (headless).
 *   - env-or-prompt (no `--set`): prefer those env vars, else prompt for it in a TTY.
 */
async function loginWithGhToken(source: GhTokenSource): Promise<string> {
  let token: string;
  let fromEnv = true;
  if (source.kind === "env-or-prompt") {
    // Interactive / no-`--set` path: prefer the environment, but when no token var is
    // set, prompt for the token instead of erroring out.
    const envToken = ghTokenFromEnv();
    if (envToken) {
      token = envToken;
    } else {
      token = await promptForGhToken();
      fromEnv = false;
    }
  } else {
    // `--set <token>` (verbatim) or `--set` bare (env-only, headless): never prompts.
    token = tokenFromSetFlag(source.kind === "inline" ? source.token : true);
    fromEnv = source.kind !== "inline";
  }
  // Narrate the acquisition only ("Using", never "Stored"): persistence is the
  // CALLER's single store write -- `agent profile --add` commits the token
  // later, atomically with the profile's mode, and could still fail after this
  // prints. The caller's own success line reports the stored outcome.
  logger.success(
    fromEnv
      ? "  Using the GitHub token from the environment."
      : "  Using the provided GitHub token.",
  );
  return token;
}

/** `gh-cli`: rely on the machine's gh login (store nothing, verify gh works).
 *  `ghUser` verifies THAT account (`gh auth token --user`); null = gh's active
 *  account, with `activeLogin` naming it in the narration when the account list
 *  was readable (no hidden information: the user always sees WHICH account
 *  their credential follows). `look` is a test seam; exported for its wording
 *  tests. */
export function loginWithGhCli(
  ghUser: string | null,
  look: (ghUser: string | null) => GhTokenLook = ghAuthTokenLook,
  activeLogin: string | null = null,
): void {
  // Verify gh works BEFORE recording -- otherwise a failed gh check would point
  // `--get` at a `gh` that can't produce a token. Either miss throws (the
  // provider is never recorded); an UNPROVEN look wears its own words, because
  // "not authenticated" and the `gh auth login` advice are wrong when gh was
  // never actually asked.
  const gh = look(ghUser);
  if (gh.token === null) {
    if (gh.unproven) {
      throw new Error(
        "could not check gh authentication (`gh auth token` did not run to completion) - retry `agent auth`",
      );
    }
    throw new Error(
      ghUser === null
        ? "gh is not authenticated - run `gh auth login`, then retry `agent auth`"
        : `gh has no saved credential for account '${ghUser}' (pinning needs a saved ` +
          "login; an env GH_TOKEN cannot serve `gh auth token --user`) - run " +
          `\`gh auth login\` for that account, pass --gh-user <login> for another, ` +
          "or choose auto interactively via `agent auth --provider gh-cli`",
    );
  }
  logger.success(
    ghUser !== null
      ? `  Using the gh CLI login (account ${ghUser}) as the Direct credential.`
      : activeLogin !== null
      ? `  Using the gh CLI login on AUTO (currently account ${activeLogin}; follows gh ` +
        "account switches) as the Direct credential."
      : "  Using the gh CLI login on AUTO (follows gh account switches) as the Direct credential.",
  );
}

/**
 * Acquire a credential WITHOUT persisting it: settle the provider (a parsed
 * acquisition, or the interactive choice for `choose`) and run its flow. The
 * caller owns the single store write -- `authenticate` records it into an
 * existing slot, `agent profile --add` commits it atomically together with the
 * profile's mode. Throws on failure. `seams` are test-only substitutes for the
 * gh lookups.
 */
export async function acquireCredential(
  acquisition: CredentialAcquisition,
  seams: {
    look?: (ghUser: string | null) => GhTokenLook;
    chooseAccount?: () => Promise<SettledGhAccount>;
  } = {},
): Promise<ProvisionedCredential> {
  const resolved = acquisition.kind === "choose"
    ? acquisitionForProvider(await chooseProvider())
    : acquisition;
  if (resolved.kind === "gh-token") {
    return { kind: "stored", provider: "gh-token", token: await loginWithGhToken(resolved.source) };
  }
  if (resolved.kind === "copilot") {
    return { kind: "stored", provider: "copilot", token: loginWithCopilot() };
  }
  const look = seams.look ?? ghAuthTokenLook;
  const account: SettledGhAccount = resolved.account.kind === "choose"
    ? await (seams.chooseAccount ?? chooseGhAccount)()
    : resolved.account;
  if (account.kind === "pinned") {
    loginWithGhCli(account.login, look);
    return { kind: "gh-cli", ghUser: account.login };
  }
  loginWithGhCli(null, look, account.activeLogin);
  return { kind: "gh-cli", ghUser: null };
}

/**
 * Authenticate: acquire a credential (acquireCredential) and record it into
 * `profile`'s slot. Does NOT configure the agents -- that is `agent init` /
 * `agent profile`'s job. A NAMED profile's store slot must already exist (this
 * is the re-auth path; `agent profile --add` is the only creator), and the gate
 * fires BEFORE the acquisition so a typo'd name never costs a device flow (the
 * store's own in-update check backstops it at the write). Throws on failure.
 */
export async function authenticate(
  acquisition: CredentialAcquisition,
  profile: Profile,
): Promise<AuthProvider> {
  if (profile !== null) assertProfileSlot(profile);
  const credential = await acquireCredential(acquisition);
  new Credential(undefined, profile).record(credential);
  return credential.kind === "gh-cli" ? "gh-cli" : credential.provider;
}

// --- sub-actions ------------------------------------------------------------

/** True when the named profile has NO store slot at all. The read-back
 *  sub-actions (--get/--del/--check) report instead of hard-failing, so their
 *  repair hint must branch the way the store's write gate does: an existing
 *  slot (complete or partial) re-auths via `agent auth --profile`, while a
 *  nonexistent name can only be created by `agent profile --add`
 *  (assertProfileSlot would refuse the re-auth). */
function profileSlotMissing(profile: ProfileName): boolean {
  return !new CopilotEnvState().profileSlotStatus(profile).exists;
}

/** The store's missing-slot phrasing, reused as a hint pointing at the one
 *  command that creates a profile: a half-created profile (a daemon home
 *  without a store slot) reports itself the way missingProfileSlotError in
 *  env_state.ts does -- never as "no such profile" -- and a never-created name
 *  gets the plain unknown-profile wording. The repair command is the same
 *  atomic re-add either way. */
function noSuchProfileHint(profile: ProfileName): string {
  if (profileHomeNames().includes(profile)) {
    return `profile '${profile}' has no store slot (half-created; its daemon home exists) - ` +
      `re-create it with \`agent profile --add ${profile} --direct|--proxy\``;
  }
  return `no such profile '${profile}' - create it with ` +
    `\`agent profile --add ${profile} --direct|--proxy\``;
}

async function runGet(profile: Profile, catalogDeps?: CodexCatalogDeps): Promise<void> {
  const token = new Credential(undefined, profile).resolve();
  if (token === null) {
    if (profile === null) {
      logger.error("no GitHub credential - run `agent auth` to log in");
    } else if (profileSlotMissing(profile)) {
      logger.error(noSuchProfileHint(profile));
    } else {
      logger.error(
        `no GitHub credential for ${
          profileLabel(profile)
        } - run \`agent auth --profile ${profile}\` ` +
          "to log in (a named profile never falls back to the default credential)",
      );
    }
    process.exitCode = 1;
    return;
  }
  // codeql[js/clear-text-logging] -- emitting the token on stdout IS this command's
  // contract (like `gh auth token`); the agent configs consume it.
  process.stdout.write(`${token}\n`);
  // Codex re-runs `auth --get` every 300s, making it the freshness hook for the
  // patched model catalog. AFTER the token is on stdout, best-effort + throttled
  // (one attempt per day), never throws, stderr-only -- the token contract stays
  // safe. The just-resolved token is reused so the refresh never re-runs `gh`.
  // DEFAULT profile only: the account-wide catalog (and its throttle) belongs to
  // the default credential; refreshing it with a named profile's token would let
  // one account's limits overwrite another's.
  if (profile !== null) return;
  // The sync half runs on EVERY auth call (one cheap TOML read): enabled, it heals a
  // config whose seed failed (e.g. during mobile pairing) without waiting out the
  // throttle; disabled, it removes the artifacts within one 300s auth cycle.
  await refreshCodexCatalogAndSync("direct", { directToken: token, ...catalogDeps });
}

/**
 * `--print-proxy-token`: print the local copilot-api proxy's API key on stdout; the
 * proxy-mode resolver (`agent proxy-token`) runs this last, once the proxy is up. Distinct
 * from `--get` (the upstream GitHub credential). `--profile` reads the key from that
 * profile daemon's own config.json. The key line is the ENTIRE stdout contract; after it
 * this runs the same best-effort daily model-catalog refresh as `--get` (stderr-only, never
 * throws, default profile only), sourced from the running proxy's /models. `agent
 * proxy-token` must come through here, not bare ensureApiKey, or the catalog freshness
 * hook silently dies.
 */
export async function runPrintProxyToken(
  profile: Profile,
  catalogDeps?: CodexCatalogDeps,
): Promise<void> {
  const key = CopilotApiConfig.forProfile(profile).ensureApiKey();
  // codeql[js/clear-text-logging] -- emitting the proxy key on stdout IS this command's
  // contract (the proxy-mode agents' auth.command / apiKeyHelper consume it).
  process.stdout.write(`${key}\n`);
  if (profile !== null) return; // account-wide catalog: default-profile concern only
  // Same freshness hook as `--get`, sourced from the local proxy's /models (the
  // resolver guarantees the proxy is up before this prints; a raw gh-cli token
  // can 403 upstream, so proxy mode never fetches Copilot directly). The same
  // every-call sync as `--get` follows (see runGet: self-heal when the catalog
  // is enabled, artifact cleanup when disabled).
  await refreshCodexCatalogAndSync("proxy", catalogDeps);
}

async function runDel(profile: Profile): Promise<void> {
  if (new Credential(undefined, profile).clear()) {
    // A running daemon holds the (now-cleared) token in memory and has already exchanged it
    // for a Copilot bearer, so it would keep serving inference until it idled out. De-auth
    // must sever that too -- stop THIS profile's tracked daemon, escalating to SIGKILL and
    // VERIFYING it died (graceMs > 0) so we never falsely report the credential's access as
    // revoked.
    const { signalled, stopped } = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, profile);
    if (profile === null) {
      // The wordings are an output contract -- keep each byte-identical. Branch on
      // `stopped` first: a stop REFUSED (unprovable pid, nothing signalled) must report
      // the still-running daemon, never the plain success.
      if (!stopped) {
        logger.warn(
          "De-authenticated, but the proxy is still running and may keep serving the old " +
            "credential -- stop it with `agent stop`.",
        );
      } else if (signalled) {
        logger.success("De-authenticated and stopped the proxy. Run `agent auth` to log in again.");
      } else {
        logger.success("De-authenticated. Run `agent auth` to log in again.");
      }
      return;
    }
    const again = `\`agent auth --profile ${profile}\``;
    if (!stopped) {
      logger.warn(
        `De-authenticated ${profileLabel(profile)}, but its proxy is still running and may keep ` +
          `serving the old credential -- stop it with \`agent stop --profile ${profile}\`.`,
      );
    } else if (signalled) {
      logger.success(
        `De-authenticated ${
          profileLabel(profile)
        } and stopped its proxy. Run ${again} to log in again.`,
      );
    } else {
      logger.success(`De-authenticated ${profileLabel(profile)}. Run ${again} to log in again.`);
    }
  } else if (profile === null) {
    logger.info("Nothing to clear - not authenticated. Run `agent auth` to log in.");
  } else if (profileSlotMissing(profile)) {
    logger.info(`Nothing to clear - ${noSuchProfileHint(profile)}.`);
  } else {
    logger.info(
      `Nothing to clear for ${profileLabel(profile)} - not authenticated. Run ` +
        `\`agent auth --profile ${profile}\` to log in.`,
    );
  }
}

/** The provider label for the read-back lines (`--check`, `--list`, "Already
 *  authenticated"): the provider name, wearing the gh-cli account pin when one
 *  is recorded ("gh-cli as <login>"). Null = never chosen. BRACKET-FREE by
 *  contract: every surface wraps this in its own parens, and nested brackets
 *  are unreadable. Exported for `agent profile`'s credential-reuse line. */
export function credentialSourceLabel(credential: StoredCredential): string | null {
  switch (credential.kind) {
    case "none":
    case "stored":
      return credential.provider;
    case "gh-cli":
      return credential.ghUser === null ? "gh-cli" : `gh-cli as ${credential.ghUser}`;
  }
}

/** credentialSourceLabel with an AUTO gh-cli slot SAYING it is auto, naming the
 *  account it follows RIGHT NOW, and listing every account it may use (one live
 *  `gh auth status`; an unproven or empty look keeps the bare "gh-cli on auto" --
 *  the accounts are never guessed). No hidden information: every read-back
 *  surface says whose credit the credential can spend. `look` is a test seam;
 *  batch callers (--list) pass one memoized look. */
export function liveCredentialSourceLabel(
  credential: StoredCredential,
  look: () => GhAccountsLook = ghAccountsLook,
): string | null {
  if (credential.kind === "gh-cli" && credential.ghUser === null) {
    const accounts = look().accounts;
    const active = activeGhLogin(accounts);
    const logins = [
      ...new Set(
        accounts
          .filter((a) => a.host === GH_COPILOT_HOST && a.login !== "")
          .map((a) => a.login),
      ),
    ];
    const parts = [
      active === null ? null : `currently ${active}`,
      logins.length === 0 ? null : `may use ${logins.join(", ")}`,
    ].filter((part) => part !== null);
    // Bracket-free like credentialSourceLabel: the callers add the one paren level.
    return `gh-cli on auto${parts.length === 0 ? "" : `: ${parts.join("; ")}`}`;
  }
  return credentialSourceLabel(credential);
}

function runCheck(profile: Profile): void {
  // The exit code is the machine contract; the status line is a human convenience
  // printed to stdout (the one stdout exception besides `--get`, like its peers
  // `agent codex/claude --check`). Default output stays byte-identical (flag/label
  // are empty strings there).
  const credential = new Credential(undefined, profile);
  const { provider, resolves } = credential.status();
  const flag = profile === null ? "" : ` --profile ${profile}`;
  const label = profile === null ? "" : ` (${profileLabel(profile)})`;
  if (provider === null) {
    if (profile !== null && profileSlotMissing(profile)) {
      console.log(noSuchProfileHint(profile));
    } else {
      console.log(`not authenticated${label} - run \`agent auth${flag}\``);
    }
    process.exitCode = 1;
    return;
  }
  const source = liveCredentialSourceLabel(credential.read()) ?? provider;
  if (resolves) {
    console.log(`authenticated (${source})${label}`);
    process.exitCode = 0;
  } else {
    // e.g. gh-cli selected but `gh` is no longer authenticated (as the pinned account).
    console.log(
      `provider '${source}' selected but no credential resolves${label} - run \`agent auth${flag}\``,
    );
    process.exitCode = 1;
  }
}

/** `--list`: the default + every named credential profile, providers only (never tokens). */
function runList(): void {
  const state = new CopilotEnvState();
  const rows: Array<[string, string]> = [];
  const describe = (source: string | null, resolves: boolean): string =>
    source === null ? "not authenticated" : `${source}${resolves ? "" : " (does not resolve)"}`;
  // One memoized account look serves every auto gh-cli row (one spawn, not N).
  let accounts: GhAccountsLook | undefined;
  const look = (): GhAccountsLook => (accounts ??= ghAccountsLook());
  const defaultCred = new Credential(state);
  rows.push([
    "default",
    describe(liveCredentialSourceLabel(defaultCred.read(), look), defaultCred.isAuthenticated()),
  ]);
  for (const name of state.profileNames()) {
    const cred = new Credential(state, name);
    rows.push([
      name,
      describe(liveCredentialSourceLabel(cred.read(), look), cred.isAuthenticated()),
    ]);
  }
  printTable(rows, { indent: "" });
}

/**
 * Ensure a credential exists for `profile` WITHOUT configuring the agents -- used by
 * `agent init` and `agent start`. No-op when already authenticated; otherwise runs the
 * auth flow (interactive provider choice) into the addressed slot. Throws if acquisition
 * fails, so callers error out rather than proceeding unauthenticated.
 */
export async function ensureAuthenticated(profile: Profile = null): Promise<void> {
  if (new Credential(undefined, profile).isAuthenticated()) return;
  logger.log(
    profile === null
      ? "  Not authenticated yet - let's log in to GitHub Copilot."
      : `  ${profileLabel(profile)} is not authenticated yet - let's log in to GitHub Copilot.`,
  );
  await authenticate({ kind: "choose" }, profile);
}

/**
 * What ONE `agent auth` invocation does -- exactly one read-back/maintenance
 * sub-action, the profile listing, or an authentication -- parsed ONCE by
 * `parseAuthAction` at the CLI boundary. `--provider`/`--set` travel only inside
 * the authenticate arm's acquisition, so `--get --provider bogus` is a rejection
 * here instead of a silently dropped (and never validated) provider.
 */
export type AuthAction =
  | { kind: "get"; profile: Profile }
  | { kind: "del"; profile: Profile }
  | { kind: "check"; profile: Profile }
  | { kind: "print-proxy-token"; profile: Profile }
  | { kind: "list" }
  | { kind: "authenticate"; profile: Profile; acquisition: CredentialAcquisition };

// The rejection for `--provider` alongside a sub-action: the provider steers
// only an authentication, so combining it with a read-back/maintenance flag
// used to silently drop (and never validate) it.
function providerConflictError(): Error {
  return new Error(
    "--provider selects how to authenticate and cannot combine with " +
      "--get/--del/--check/--list/--print-proxy-token",
  );
}

// The rejection for `--gh-user` alongside a sub-action, mirroring
// providerConflictError: the pin steers only a gh-cli authentication.
function ghUserConflictError(): Error {
  return new Error(
    "--gh-user pins the gh account for authentication and cannot combine with " +
      "--get/--del/--check/--list/--print-proxy-token",
  );
}

/** Parse the raw `agent auth` flags into an AuthAction (the CLI boundary). */
export function parseAuthAction(args: AuthArgs): AuthAction {
  const subActions = [args.get, args.del, args.check, args.printProxyToken, args.list].filter(
    Boolean,
  ).length;
  if (subActions > 1) {
    throw new Error(
      "--get, --del, --check, --list, and --print-proxy-token are mutually exclusive",
    );
  }
  if (args.set !== undefined && subActions > 0) {
    throw new Error(
      "--set provisions a token and cannot combine with --get/--del/--check/--list/--print-proxy-token",
    );
  }
  if (args.list) {
    if (args.profile !== undefined) {
      throw new Error("--list reports every profile; it does not combine with --profile");
    }
    if (args.provider !== undefined) throw providerConflictError();
    if (args.ghUser !== undefined) throw ghUserConflictError();
    return { kind: "list" };
  }
  // Profile-name validation stays ahead of the provider conflict, so an invalid
  // name keeps reporting itself even when a stray --provider rides along.
  const profile: Profile = parseProfileFlag(args.profile);
  if (args.provider !== undefined && subActions > 0) throw providerConflictError();
  if (args.ghUser !== undefined && subActions > 0) throw ghUserConflictError();
  if (args.printProxyToken) return { kind: "print-proxy-token", profile };
  if (args.get) return { kind: "get", profile };
  if (args.del) return { kind: "del", profile };
  if (args.check) return { kind: "check", profile };
  return {
    kind: "authenticate",
    profile,
    acquisition: parseAcquisition(args.provider, args.set, args.ghUser),
  };
}

/**
 * `agent auth`: manage the GitHub credential ONLY (never configures agents).
 * `--get`/`--del`/`--check`/`--list` are standalone, mutually exclusive
 * sub-actions; `--profile <name>` addresses a named credential slot (named
 * profiles never fall back to the default credential). Otherwise it
 * authenticates: bare (no `--provider`) is idempotent when a credential already
 * resolves and prompts for the provider when not; an explicit `--provider`
 * always runs (so it can switch the credential source). `--set [token]` is the
 * non-interactive gh-token path (provide the token inline, or via env).
 */
export async function runAuth(args: AuthArgs, catalogDeps?: CodexCatalogDeps): Promise<void> {
  const action = parseAuthAction(args);
  switch (action.kind) {
    case "list":
      runList();
      return;
    case "print-proxy-token":
      await runPrintProxyToken(action.profile, catalogDeps);
      return;
    case "get":
      await runGet(action.profile, catalogDeps);
      return;
    case "del":
      await runDel(action.profile);
      return;
    case "check":
      runCheck(action.profile);
      return;
    case "authenticate":
      await runAuthenticate(action.profile, action.acquisition);
      return;
    default:
      assertNever(action);
  }
}

/**
 * The authenticate arm: `--set` is the non-interactive gh-token path (parseAcquisition
 * made it imply `--provider gh-token` and rejected a conflicting provider). Bare
 * `agent auth` (no --provider, no --set) is idempotent only when the recorded provider
 * STILL RESOLVES: then report it and how to change it; otherwise run the auth flow
 * (prompt), covering both "no provider yet" and "provider chosen but broken (e.g. gh-cli
 * after gh logout)". `gh` is never silently used without the `gh-cli` choice, and
 * `agent auth --del` clears the provider so the next run starts fresh. An explicit
 * `--provider` always runs.
 */
async function runAuthenticate(
  profile: Profile,
  acquisition: CredentialAcquisition,
): Promise<void> {
  if (acquisition.kind === "choose") {
    const credential = new Credential(undefined, profile);
    const { provider, resolves } = credential.status();
    if (provider !== null && resolves) {
      const source = liveCredentialSourceLabel(credential.read()) ?? provider;
      if (profile === null) {
        // The default wording is an output contract -- keep it byte-identical.
        logger.success(
          `Already authenticated (${source}). Switch with ` +
            `\`agent auth --provider <${PROVIDER_CHOICES}>\`, or clear it with \`agent auth --del\`.`,
        );
      } else {
        logger.success(
          `Already authenticated (${source}, ${profileLabel(profile)}). Switch with ` +
            `\`agent auth --profile ${profile} --provider <${PROVIDER_CHOICES}>\`, or clear it ` +
            `with \`agent auth --profile ${profile} --del\`.`,
        );
      }
      return;
    }
  }

  const provider = await authenticate(acquisition, profile);
  logger.success(
    profile === null
      ? `Authenticated (${provider}). Run \`agent init\` to configure Codex and Claude.`
      : `Authenticated ${profileLabel(profile)} (${provider}). Wire it into both agents with ` +
        `\`agent profile --add ${profile} --direct|--proxy\`.`,
  );
}
