// The credential domain is the `Credential` class (src/copilot_api/credential.ts); this is the
// command and interactive layer. The agent Direct configs shell into `agent auth --get` at fetch
// time, so this command is also their resolver.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { consola } from "consola";
import { wireBothAgents } from "../agents/profile_wiring.ts";
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { refreshCodexCatalogAndSync } from "../codex/catalog_reference.ts";
import { codexUserAgent } from "../codex/user_agent.ts";
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
import { stopTrackedProxy, trackedDaemonAlive } from "../copilot_api/daemon.ts";
import {
  CODEX_IDENTITY_NAME,
  configKeyDef,
  CopilotEnvConfig,
  parseIntegrationIdPin,
} from "../copilot_api/env_config.ts";
import {
  assertProfileSlot,
  CopilotEnvState,
  type ProvisionedCredential,
  type StoredCredential,
  type StoredDirectPair,
} from "../copilot_api/env_state.ts";
import {
  activeGhLogin,
  GH_COPILOT_HOST,
  GH_LOGIN_RE,
  type GhEnvToken,
  ghTokenEnvVarsLabel,
  ghTokenEnvVarsList,
  ghTokensInEnv,
} from "../copilot_api/gh_cli.ts";
import { type GithubLoginLook, githubLoginLook } from "../copilot_api/github_login.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  directIdentity,
  identityCandidates,
  type IdentityHostSurvey,
  type IdentitySurvey,
  type IdentityVerdict,
  INTEGRATION_ID_HEADER,
  type IntegrationIdentity,
  pinnedIdentityCandidates,
  selectDirectIdentityAndHost,
  surveyIntegrationIdentities,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../copilot_api/integration_identity.ts";
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
import { cyan } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { withFileLockSync } from "../utils/file_lock.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { formatTable, printTable, terminalWidth, wrapLine } from "../utils/table.ts";
import { removeReported } from "../utils/report_write.ts";

// Narration to stderr so `--get`'s stdout stays a clean machine-readable token.
const logger = createStderrLogger();

// Derived from AUTH_PROVIDERS (env_state.ts owns the list) so the flag hints can never drift.
const PROVIDER_CHOICES = AUTH_PROVIDERS.join("|");

export interface AuthArgs {
  provider?: string;
  set?: string;
  ghUser?: string;
  get?: boolean;
  del?: boolean;
  check?: boolean;
  printProxyToken?: boolean;
  profile?: string;
  list?: boolean;
  identities?: boolean;
  /** `true` is the bare flag (interactive choice); a string is the id to pin, or `auto`. */
  identity?: string | boolean;
}

function asProvider(provider: string): AuthProvider {
  const p = provider.trim().toLowerCase();
  if ((AUTH_PROVIDERS as readonly string[]).includes(p)) return p as AuthProvider;
  throw new Error(`--provider must be one of: ${AUTH_PROVIDERS.join(", ")} (got '${provider}')`);
}

/** Auto is never a flag value: it is what `choose` may SETTLE to (SettledGhAccount), carrying the
 *  active login so the narration names the account in use when gh reports one. */
type GhCliAccountChoice =
  | { kind: "pinned"; login: string }
  | { kind: "choose" };

/** PINNING IS THE ONLY DEFAULT: the credential must never follow an account the user did not
 *  choose, or their Copilot credit would burn on it after a `gh auth login`. Auto is solely the
 *  picker's explicit last option. */
type SettledGhAccount =
  | { kind: "auto"; activeLogin: string | null }
  | { kind: "pinned"; login: string };

/** gh-token's null token means "prompt for a paste"; the env read is gh-env's whole job. */
type ResolvedAcquisition =
  | { kind: "copilot" }
  | { kind: "gh-cli"; account: GhCliAccountChoice }
  | { kind: "gh-token"; token: string | null }
  | { kind: "gh-env" };

/** A `--set` token can only travel inside the gh-token variant, and a `--gh-user` pin inside the
 *  gh-cli one, so `authenticate` cannot receive either under the wrong provider and silently drop
 *  it. */
export type CredentialAcquisition = { kind: "choose" } | ResolvedAcquisition;

function acquisitionForProvider(provider: AuthProvider): ResolvedAcquisition {
  switch (provider) {
    case "gh-token":
      return { kind: "gh-token", token: null };
    case "gh-env":
      return { kind: "gh-env" };
    case "gh-cli":
      return { kind: "gh-cli", account: { kind: "choose" } };
    case "copilot":
      return { kind: "copilot" };
    default:
      return assertNever(provider);
  }
}

/** The one place "--set implies gh-token" and "--gh-user implies gh-cli" live, shared by `agent
 *  auth` and `agent profile --add`. The two differ on `--set x --provider bogus`: `agent auth`
 *  validates the provider name first, `agent profile --add` treats any non-gh-token string as the
 *  --set conflict (`setConflictWins`). */
export function parseAcquisition(
  provider: string | undefined,
  set: string | undefined,
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
    return { kind: "gh-token", token: set };
  }
  if (provider === undefined) return { kind: "choose" };
  return acquisitionForProvider(asProvider(provider));
}

/** Keyed exhaustively on AuthProvider so a vocabulary change fails the compile here. */
const PROVIDER_PICKER_DETAIL: Record<AuthProvider, string> = {
  "copilot": "device-flow browser login (read:user scope)",
  "gh-cli": "use the machine's `gh auth login`",
  "gh-token": "paste a GitHub token",
  "gh-env": `copy a token from ${ghTokenEnvVarsLabel(" / ")} (headless)`,
};

async function chooseProvider(): Promise<AuthProvider> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `not a terminal - store a credential first with \`agent auth --provider ${PROVIDER_CHOICES}\` ` +
        "(e.g. `agent auth --provider gh-env`) or `agent auth --set <token>`",
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
 * Pinning is the only default: a later `gh auth login` must never switch whose Copilot credit gets
 * spent. When nothing can be pinned honestly this throws naming the escape hatches; never auto.
 *   one login        -> pins itself, unless env-only under a TTY: its pin may fail verification
 *                       with nothing to escape to, so the user decides
 *   several, no TTY  -> pins the active one when pickable, else errors
 *   several, TTY     -> the picker lists the accounts first, auto as the explicit LAST option
 * `look` is a test seam.
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
  // The SOURCE never filters the menu: gh's status shows only the winning source per login, so an
  // exported GH_TOKEN shadows a saved keyring credential the pick may still land on.
  //
  //   another host               -> excluded, it cannot be served
  //   broken                     -> excluded, pinning it could never verify
  //   every listing an env token -> kept; the menu notes it, loginWithGhCli verifies the pick
  const github = accounts.filter((a) => a.host === GH_COPILOT_HOST && a.broken !== true);
  const logins = [...new Set(github.map((a) => a.login))];
  // Broken entries still count when deciding whether there is a choice: a broken active login is
  // never abandoned for a healthy bystander without asking.
  const allLogins = [
    ...new Set(accounts.filter((a) => a.host === GH_COPILOT_HOST).map((a) => a.login)),
  ];
  const active = activeGhLogin(accounts);
  // A login whose EVERY listing is an env-token source may have no saved credential behind it.
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
    // A sole env-only login's pin can fail verification with no other account to escape to;
    // interactively the user decides, without a TTY the pin proceeds and a failure names the
    // recovery.
    if (!process.stdin.isTTY || envOnly(only) === null) {
      return { kind: "pinned", login: only };
    }
  }
  if (!process.stdin.isTTY) {
    // Anything but the active account would guess whose credit to spend, so it is an error, never a
    // fallback.
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
  // The active account leads (the default selection); auto is LAST and explicit.
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

/** The INSTALLED copilot-api runs the device flow, not `npx @latest`, which would bypass the
 *  supply-chain cooldown and the float. It writes its own github_token file, which is read and
 *  scrubbed here. */
function loginWithCopilot(): string {
  const entry = resolveCopilotApiEntry();
  if (entry.kind === "package" && installedProxyVersion() === null) {
    throw new Error(
      "cannot run the device-flow login - copilot-api is not installed. " +
        "Re-run the agent launcher to install dependencies, or use `agent auth --provider gh-token`.",
    );
  }
  const { githubTokenFile: tokenFile, githubTokenLoginLock: lockPath } = new CopilotApiPaths();
  // Every profile's device flow funnels through the ONE github_token file, so two concurrent logins
  // could read each other's token into the wrong slot. Dead-holder-only reclaim: an interactive
  // login holds it for minutes.
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
    // Scrub copilot-api's copy so the token rests only in our state (the proxy receives it via
    // `--github-token` from there).
    //   the removal fails                  -> best-effort, that file stays on disk
    //   a crash before the caller persists -> one re-login, since the scrub already ran
    try {
      removeReported(tokenFile);
    } catch {
      // best-effort
    }
    return token;
  });
}

/** consola's text prompt echoes input and has no masked variant, and its confirm takes two lines, so
 *  readline serves both: `secret` mutes the echo. The query goes to stderr, keeping `--get`'s stdout
 *  contract untouched. */
function readAnswer(query: string, secret: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = createInterface({
      input: process.stdin,
      output: secret ? muted : process.stderr,
      terminal: true,
    });
    if (secret) process.stderr.write(query);
    rl.question(secret ? "" : query, (answer) => {
      if (secret) process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("cancelled"));
    });
  });
}

async function confirmLine(question: string): Promise<boolean> {
  const answer = (await readAnswer(`? ${question} [Y/n] `, false)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/** `$VAR as login`, or when GitHub could not name the account, a glimpse of the token (its ends) so the
 *  user can still tell which one it is, plus why. `subject` is the var or the pasted-token label. */
function tokenLabel(subject: string, token: string, look: GithubLoginLook): string {
  if (look.login !== null) return `${subject} as ${cyan(look.login)}`;
  const glimpse = token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-4)}` : token;
  return `${subject} = ${glimpse}, unverified (${look.detail})`;
}

async function promptForGhToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "no GitHub token given: pass `--set <token>`, or use `--provider gh-env` to copy one of " +
        ghTokenEnvVarsList(),
    );
  }
  return await readAnswer("Paste your Copilot-enabled GitHub token: ", true);
}

// The account is a LABEL, never a gate: a look that missed says why and the token is used anyway.
// "Using", never "Stored": persistence is the caller's single store write, which `agent profile
// --add` commits later, atomically with the profile's mode, and which could still fail after this
// prints.
async function loginWithGhToken(inline: string | null): Promise<string> {
  const token = (inline ?? await promptForGhToken()).trim();
  if (token === "") throw new Error("the provided GitHub token is empty");
  const look = await githubLoginLook(token);
  logger.success(`  Using ${tokenLabel("the provided GitHub token", token, look)}.`);
  return token;
}

/** A terminal sees the var and its account before the token is used; headless cannot ask, so it takes
 *  the most specific var and says so. */
async function chooseEnvToken(): Promise<GhEnvToken & { look: GithubLoginLook }> {
  const found = ghTokensInEnv();
  const first = found[0];
  if (first === undefined) {
    throw new Error(`no GitHub token in the environment: set one of ${ghTokenEnvVarsList()}`);
  }
  if (!process.stdin.isTTY) {
    if (found.length > 1) {
      logger.info(
        `  ${found.length} of ${ghTokenEnvVarsLabel(", ")} are set; taking $${first.name} ` +
          "(the most specific). Run this in a terminal to pick another.",
      );
    }
    return { ...first, look: await githubLoginLook(first.token) };
  }
  const looked = await Promise.all(
    found.map(async (candidate) => ({
      ...candidate,
      look: await githubLoginLook(candidate.token),
    })),
  );
  const row = (candidate: (typeof looked)[number]): string =>
    tokenLabel(`$${candidate.name}`, candidate.token, candidate.look);
  const only = looked.length === 1 ? looked[0] : undefined;
  if (only !== undefined) {
    if (!(await confirmLine(`Use ${row(only)}?`))) throw new Error("cancelled");
    return only;
  }
  const value = await consola.prompt("Which token should GitHub Copilot use?", {
    type: "select",
    options: looked.map((candidate) => ({ label: row(candidate), value: candidate.name })),
    cancel: "reject",
  });
  const chosen = looked.find((candidate) => candidate.name === String(value));
  if (chosen === undefined) throw new Error(`no such environment token: ${String(value)}`);
  return chosen;
}

async function loginWithGhEnv(): Promise<string> {
  const chosen = await chooseEnvToken();
  logger.success(`  Using ${tokenLabel(`$${chosen.name}`, chosen.token, chosen.look)}.`);
  return chosen.token;
}

/** `activeLogin` names the account an auto slot follows right now, when the account list was
 *  readable: the user sees WHICH account their credential follows whenever that is known. `look` is
 *  a test seam; exported for the wording tests. */
export function loginWithGhCli(
  ghUser: string | null,
  look: (ghUser: string | null) => GhTokenLook = ghAuthTokenLook,
  activeLogin: string | null = null,
): void {
  // Verified BEFORE recording, or a failed check would point `--get` at a `gh` that cannot produce
  // a token. An UNPROVEN look wears its own words: "not authenticated" and the `gh auth login`
  // advice are wrong when gh was never asked.
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

/** Never persists: the caller owns the single store write (`authenticate` into an existing slot,
 *  `agent profile --add` atomically with the profile's mode). `seams` are test substitutes for the
 *  gh lookups. */
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
    return { kind: "stored", provider: "gh-token", token: await loginWithGhToken(resolved.token) };
  }
  if (resolved.kind === "gh-env") {
    return { kind: "stored", provider: "gh-env", token: await loginWithGhEnv() };
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

/** A named profile's slot must already exist (`agent profile --add` is the only creator), and the
 *  gate fires BEFORE the acquisition so a typo'd name never costs a device flow. A complete Direct
 *  profile is rebaked here with a fresh selection: the credential write took the previous
 *  credential's stored pair with it, and every re-render bakes the slot's pair, so the landing is
 *  where the new one is probed and stored. */
export async function authenticate(
  acquisition: CredentialAcquisition,
  profile: Profile,
): Promise<AuthProvider> {
  if (profile !== null) assertProfileSlot(profile);
  const credential = await acquireCredential(acquisition);
  new Credential(undefined, profile).record(credential);
  if (profile !== null) {
    const slot = new CopilotEnvState().readProfileSlot(profile);
    if (slot.kind === "complete" && slot.mode === "direct") {
      await wireBothAgents(profile, "direct", false, "probe");
    }
  }
  return credential.kind === "gh-cli" ? "gh-cli" : credential.provider;
}

// --- sub-actions ------------------------------------------------------------

/** The read-back sub-actions report instead of hard-failing, so their repair hint must branch the
 *  way the store's write gate does: an existing slot re-auths via `agent auth --profile`, a
 *  nonexistent name can only be created by `agent profile --add`. */
function profileSlotMissing(profile: ProfileName): boolean {
  return !new CopilotEnvState().profileSlotStatus(profile).exists;
}

/** A half-created profile (a daemon home without a store slot) reports itself the way
 *  missingProfileSlotError in env_state.ts does, never as "no such profile". */
function noSuchProfileHint(profile: ProfileName): string {
  if (profileHomeNames().includes(profile)) {
    return `profile '${profile}' has no store slot (half-created; its daemon home exists) - ` +
      `re-create it with \`agent profile --add ${profile} --direct|--proxy\``;
  }
  return `no such profile '${profile}' - create it with ` +
    `\`agent profile --add ${profile} --direct|--proxy\``;
}

async function runGet(profile: Profile, catalogDeps?: CodexCatalogDeps): Promise<void> {
  const { token, reason } = new Credential(undefined, profile).resolveWithReason();
  if (token === null) {
    logger.error(
      profile !== null && profileSlotMissing(profile) ? noSuchProfileHint(profile) : reason,
    );
    process.exitCode = 1;
    return;
  }
  // codeql[js/clear-text-logging] -- emitting the token on stdout IS this command's
  // contract (like `gh auth token`); the agent configs consume it.
  process.stdout.write(`${token}\n`);
  // Codex re-runs `auth --get` every 300s, which makes it the freshness hook for the model catalog:
  // AFTER the token is on stdout, best-effort, stderr-only. Default profile only: the account-wide
  // catalog belongs to the default credential, and a named profile's token would let one account's
  // limits overwrite another's.
  if (profile !== null) return;
  // The sync half runs on EVERY call: enabled, it heals a config whose seed failed without waiting
  // out the daily throttle; disabled, it removes the artifacts within one auth cycle.
  await refreshCodexCatalogAndSync("direct", { directToken: token, ...catalogDeps });
}

/** The key line is the ENTIRE stdout contract. `agent proxy-token` must come through here, not bare
 *  ensureApiKey, or the catalog freshness hook silently dies. */
export async function runPrintProxyToken(
  profile: Profile,
  catalogDeps?: CodexCatalogDeps,
): Promise<void> {
  const key = CopilotApiConfig.forProfile(profile).ensureApiKey();
  // codeql[js/clear-text-logging] -- emitting the proxy key on stdout IS this command's
  // contract (the proxy-mode agents' auth.command / apiKeyHelper consume it).
  process.stdout.write(`${key}\n`);
  if (profile !== null) return; // the account-wide catalog belongs to the default credential
  // Sourced from the local proxy's /models: a raw gh-cli token can 403 upstream, so proxy mode
  // never fetches Copilot directly.
  await refreshCodexCatalogAndSync("proxy", catalogDeps);
}

async function runDel(profile: Profile): Promise<void> {
  if (new Credential(undefined, profile).clear()) {
    // A running daemon has already exchanged the token for a Copilot bearer and would keep serving
    // until it idled out; the SIGKILL grace VERIFIES it died so access is never falsely reported as
    // revoked.
    const { signalled, stopped } = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, profile);
    if (profile === null) {
      // The wordings are an output contract. `stopped` first: a stop REFUSED (unprovable pid,
      // nothing signalled) must report the still-running daemon, never the plain success.
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
    } else {
      const again = `\`agent auth --profile ${profile}\``;
      if (!stopped) {
        logger.warn(
          `De-authenticated ${
            profileLabel(profile)
          }, but its proxy is still running and may keep ` +
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
  // Whatever the store held, a baked copy may still sit in the agent configs.
  noteStaticKeyStale(profile);
}

/** BRACKET-FREE by contract: a surface that wants parens adds its own, and `--list` prints it
 *  bare. Exported for `agent profile`'s credential-reuse line. */
export function credentialSourceLabel(credential: StoredCredential): string | null {
  switch (credential.kind) {
    case "none":
    case "stored":
      return credential.provider;
    case "gh-cli":
      return credential.ghUser === null ? "gh-cli" : `gh-cli as ${credential.ghUser}`;
  }
}

/** An AUTO gh-cli slot names the account it follows right now and every account it may use, so a
 *  read-back through here says whose credit the credential can spend; an unproven or empty look
 *  never guesses. Batch callers (--list) pass one memoized `look`. */
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
  // The exit code is the machine contract; the status line goes to stdout like its peers `agent
  // codex/claude --check`. The default output is byte-identical to before profiles existed (flag
  // and label are empty).
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
  printTable(rows, { indent: "", wrap: [false, true] });
}

// --- integration identities -------------------------------------------------

/** `auto` has its own variant so clearing the pin never depends on a credential resolving; `pin`
 *  carries a domain-validated id; `choose` is the bare `--identity` in a terminal. */
export type IdentityChoice = { kind: "pin"; id: string } | { kind: "auto" } | { kind: "choose" };

export function parseIdentityChoice(raw: string): IdentityChoice {
  const id = parseIntegrationIdPin(raw);
  return id.toLowerCase() === "auto" ? { kind: "auto" } : { kind: "pin", id };
}

const IDENTITY_NOTES: Record<string, string> = {
  [CODEX_IDENTITY_NAME]: `the default: no ${INTEGRATION_ID_HEADER} header (auto only)`,
  [COPILOT_CLI_INTEGRATION_ID]: "GitHub Copilot CLI; accepts fine-grained PATs",
  [VSCODE_CHAT_INTEGRATION_ID]: "copilot-api's former default",
};

/** The cell carries the verdict and a tag (status or "network error"); the full reason follows the
 *  table, so a 160-char rejection body never widens it. `mark` is `*` (in use) or `>` (the next
 *  landing's pick). */
function verdictCell(verdict: IdentityVerdict | undefined, mark = ""): string {
  if (verdict === undefined) return "-";
  const suffix = mark === "" ? "" : ` ${mark}`;
  const tag = (detail: string): string =>
    detail.startsWith("network error") ? "network error" : detail.split(" ")[0] ?? "";
  switch (verdict.kind) {
    case "accepted":
      return `accepted${
        verdict.models === null
          ? ""
          : ` (${verdict.models} ${verdict.models === 1 ? "model" : "models"})`
      }${suffix}`;
    case "rejected":
      return `rejected (${tag(verdict.detail)})${suffix}`;
    case "inconclusive":
      return `unclear (${tag(verdict.detail)})${suffix}`;
    default:
      return assertNever(verdict);
  }
}

/** A column's header: the host, tagged with why it is shown (and whether it is the host in use).
 *  The configured column is the `host` literal, or under `auto` the slot's stored host. */
function hostLabel(column: IdentityHostSurvey, inUse = false, literal = true): string {
  const tags: string[] = [];
  if (column.role === "designated") tags.push("account");
  if (column.role === "configured") tags.push(literal ? "host" : "stored");
  if (inUse) tags.push("in use");
  const host = new URL(column.apiBase).host;
  return tags.length === 0 ? host : `${host} (${tags.join(", ")})`;
}

function sameOrigin(a: string, b: string): boolean {
  return URL.canParse(a) && URL.canParse(b) && new URL(a).origin === new URL(b).origin;
}

/** What the slot decides for this credential, resolved once where the pair is read (surveyAndTable)
 *  so the table never re-derives it from the halves. */
type SlotReading =
  /** Both halves known: the pin over the stored identity, on the literal over the stored host;
   *  what every Direct re-render bakes AND what a daemon launch sends. */
  | { kind: "in-use"; identity: string }
  /** No pin and nothing stored: the next landing selects afresh on the host in use, so its pick
   *  (the first candidate accepted there, in probe order; null when none is) can be previewed. */
  | { kind: "empty"; wouldPick: string | null }
  /** One half known (a pin without a stored host, or a stored half whose overlay cleared): the
   *  next landing probes again from the generic host, so there is no pick to preview here. */
  | { kind: "half"; missing: "identity" | "host" };

interface IdentityTableInput {
  /** Every row under the one header set every mode sends (directClientHeaders). */
  survey: IdentitySurvey;
  pinned: string | null;
  /** The `host` literal, or null for `auto`. */
  configuredHost: string | null;
  /** The slot's probed halves; a half undefined while never probed. */
  stored: StoredDirectPair;
  /** The host every request goes to: the literal, else the stored host, else the generic host
   *  a first probe starts on. */
  hostInUse: string;
  slot: SlotReading;
  /** A running daemon keeps the identity and host it launched with, so the mark is not what is
   *  being sent right now. */
  daemonRunning: boolean;
  profile: Profile;
}

/** One column per host, one row per identity. `*` marks the one identity in use, on the host in
 *  use, or `>` the next landing's pick while the slot is empty; the notes name what would move it. */
function identityTableLines(input: IdentityTableInput): string[] {
  const width = terminalWidth();
  const { survey, pinned, configuredHost, stored, hostInUse, slot, daemonRunning } = input;
  const inUse = slot.kind === "in-use" ? slot.identity : null;
  const wouldPick = slot.kind === "empty" ? slot.wouldPick : null;
  const inUseColumn = survey.hosts.find((h) => sameOrigin(h.apiBase, hostInUse)) ?? null;
  const names = [...new Set(survey.hosts.flatMap((h) => h.verdicts.map((v) => v.name)))];
  const verdictOf = (column: IdentityHostSurvey, name: string): IdentityVerdict | undefined =>
    column.verdicts.find((v) => v.name === name)?.verdict;
  const mark = (column: IdentityHostSurvey, name: string): string => {
    if (column !== inUseColumn) return "";
    if (inUse === name) return "*";
    return wouldPick === name ? ">" : "";
  };
  const rows = names.map((name) => [
    name,
    ...survey.hosts.map((c) => verdictCell(verdictOf(c, name), mark(c, name))),
    IDENTITY_NOTES[name] ?? "",
  ]);
  // Every rejection behind a rendered cell.
  const reasons = names.flatMap((name) =>
    survey.hosts.flatMap((c) => {
      const verdict = verdictOf(c, name);
      return verdict === undefined || verdict.kind === "accepted" ? [] : wrapLine(
        `${name} on ${hostLabel(c, false, configuredHost !== null)}: ${verdict.detail}`,
        width,
        "  ",
        "    ",
      );
    })
  );
  const inUseHost = new URL(hostInUse).host;
  const flag = input.profile === null ? "" : ` --profile ${input.profile}`;
  const restart = `\`agent stop${flag}\`, then \`agent start${flag}\``;
  const landing = input.profile === null
    ? "`agent init`"
    : `\`agent profile --add ${input.profile} --direct\``;
  const legend = "* = in use: the pin, else the slot's probed identity; what every Direct " +
    "re-render bakes and a daemon launch sends, on the host in use" +
    (wouldPick === null ? "" : "; > = would be picked by the next landing (nothing stored yet)");
  const notes = [
    ...(survey.designatedUnknown
      ? [
        "Host: the account's designated host could not be looked up (transient); only the hosts " +
        "above were surveyed.",
      ]
      : []),
    ...(slot.kind === "empty"
      ? [
        `Nothing stored yet for this profile: run ${landing} (or \`agent start${flag}\`) once; ` +
        "it probes on the host in use and stores the identity and host it lands on.",
      ]
      : slot.kind === "half"
      ? [
        `The ${slot.missing} is not stored yet for this profile: run ${landing} (or ` +
        `\`agent start${flag}\`) once; it probes and stores what it lands on.`,
      ]
      : pinned !== null && stored.integrationId !== undefined &&
          pinned !== (stored.integrationId ?? CODEX_IDENTITY_NAME)
      ? [
        `Slot: the probed identity is ${stored.integrationId ?? CODEX_IDENTITY_NAME}; the pin ` +
        `overlays it at every re-render and daemon start.`,
      ]
      : []),
    ...(daemonRunning
      ? [
        "Proxy: a daemon is running and keeps the identity and host it launched with; restart it " +
        `to apply a change: ${restart}.`,
      ]
      : []),
  ];
  return [
    ...wrapLine(
      pinned === null ? "identity: auto" : `identity: pinned to ${pinned}`,
      width,
      "",
      "  ",
    ),
    ...wrapLine(
      configuredHost === null ? `host: auto (${inUseHost} in use)` : `host: ${configuredHost}`,
      width,
      "",
      "  ",
    ),
    ...wrapLine(legend, width, "", "  "),
    ...formatTable(rows, {
      header: [
        "identity",
        ...survey.hosts.map((c) => hostLabel(c, c === inUseColumn, configuredHost !== null)),
        "note",
      ],
      wrap: [false, ...survey.hosts.map(() => false), true],
      indent: "",
      width,
    }),
    ...notes.flatMap((note) => wrapLine(note, width, "", "  ")),
    ...reasons,
  ];
}

/** Null when nothing resolves; the reason has already been reported and the exit code set. */
function resolveForProbe(profile: Profile): string | null {
  const { token, reason } = new Credential(undefined, profile).resolveWithReason();
  if (token === null) {
    logger.error(
      profile !== null && profileSlotMissing(profile) ? noSuchProfileHint(profile) : reason,
    );
    process.exitCode = 1;
  }
  return token;
}

/** `ids` not already among `builtins` are appended, so a row the star or the pin lands on always
 *  carries a probed verdict, whether or not it is a built-in candidate on that host. */
function withExtraCandidates(
  builtins: readonly IntegrationIdentity[],
  ids: readonly (string | null)[],
  build: (id: string) => IntegrationIdentity,
): IntegrationIdentity[] {
  const seen = new Set(builtins.map((c) => c.name));
  const extras: IntegrationIdentity[] = [];
  for (const id of ids) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    extras.push(build(id));
  }
  return [...builtins, ...extras];
}

/** The identity a landing on `hostInUse` would select from these verdicts: the first candidate
 *  accepted there, in candidate order (probeIntegrationIdentity's rule). Null when none is. */
function nextLandingPick(
  survey: IdentitySurvey,
  hostInUse: string,
  candidates: readonly IntegrationIdentity[],
): string | null {
  const column = survey.hosts.find((h) => sameOrigin(h.apiBase, hostInUse));
  if (column === undefined) return null;
  const accepted = (name: string): boolean =>
    column.verdicts.find((v) => v.name === name)?.verdict.kind === "accepted";
  return candidates.find((c) => accepted(c.name))?.name ?? null;
}

async function surveyAndTable(
  profile: Profile,
  token: string,
  pinned: string | null,
): Promise<IdentitySurvey> {
  const userAgent = codexUserAgent();
  const configuredHost = new CopilotEnvConfig().copilotHost(profile);
  // THE identity in use and where, as every re-render and daemon launch read it: the pin over the
  // slot's stored pair, the literal over its host. The survey itself never probes to select and
  // never writes: a slot with no pair reads as none, and the landing that probes stores it.
  const stored = new CopilotEnvState().readProfileDirectPair(profile);
  const identity = pinned ?? stored.integrationId;
  const host = configuredHost ?? stored.host;
  const hostInUse = host ?? DEFAULT_COPILOT_API_BASE;
  // Rows: the candidates in the one header set every mode sends, plus the pin and the stored
  // identity when they are not candidates (a pin lands them there), so the row the mark lands on
  // always carries a probed verdict.
  const rows = withExtraCandidates(
    identityCandidates(userAgent),
    [
      pinned,
      stored.integrationId === undefined ? null : stored.integrationId ?? CODEX_IDENTITY_NAME,
    ],
    (id) => directIdentity(userAgent, id),
  );
  const survey = await surveyIntegrationIdentities(token, rows, { configuredHost: hostInUse });
  // A pinned landing stores only the host and a landing under a literal only the identity, so a
  // cleared overlay leaves ONE half: the next landing then re-selects from the generic host, not
  // the host in use, and only the empty slot's pick is previewed.
  const slot: SlotReading = identity !== undefined && host !== undefined
    ? { kind: "in-use", identity: identity ?? CODEX_IDENTITY_NAME }
    : pinned === null && stored.integrationId === undefined && stored.host === undefined
    ? {
      kind: "empty",
      wouldPick: nextLandingPick(survey, hostInUse, identityCandidates(userAgent)),
    }
    : { kind: "half", missing: host === undefined ? "host" : "identity" };
  for (
    const line of identityTableLines({
      survey,
      pinned,
      configuredHost,
      stored,
      hostInUse,
      slot,
      daemonRunning: trackedDaemonAlive(profile),
      profile,
    })
  ) {
    console.log(line);
  }
  return survey;
}

async function runIdentities(profile: Profile): Promise<void> {
  const token = resolveForProbe(profile);
  if (token === null) return;
  await surveyAndTable(profile, token, new CopilotEnvConfig().pinnedIntegrationId(profile));
}

/** The survey shows the rows; the picker offers every identity at least one host accepted, plus
 *  auto, each labelled with the same verdicts the table showed. `codex` is never offered: it is
 *  not a pin (see INTEGRATION_ID_DOMAIN), auto yields it. */
async function chooseIdentity(
  survey: IdentitySurvey,
  pinned: string | null,
): Promise<IdentityChoice> {
  const verdictOn = (column: IdentityHostSurvey, name: string): IdentityVerdict | undefined =>
    column.verdicts.find((v) => v.name === name)?.verdict;
  const names = [...new Set(survey.hosts.flatMap((h) => h.verdicts.map((v) => v.name)))]
    .filter((name) =>
      name !== CODEX_IDENTITY_NAME &&
      survey.hosts.some((c) => verdictOn(c, name)?.kind === "accepted")
    );
  const cell = (column: IdentityHostSurvey, name: string): string => {
    const verdict = verdictOn(column, name);
    return verdict === undefined ? "not probed" : verdictCell(verdict);
  };
  const current = (name: string): string => name === pinned ? " (current pin)" : "";
  const value = await consola.prompt("Which Copilot client identity should be pinned?", {
    type: "select",
    options: [
      {
        label: `auto - probe per credential${pinned === null ? " (current)" : ""}`,
        value: "auto",
      },
      ...names.map((name) => ({
        label: `${name} - ${
          survey.hosts.map((c) => `${hostLabel(c)} ${cell(c, name)}`).join(", ")
        }${current(name)}`,
        value: name,
      })),
    ],
    cancel: "reject",
  });
  return parseIdentityChoice(String(value));
}

function noteIdentityApplies(): void {
  const hint = configKeyDef("identity")?.applyHint;
  if (hint !== undefined) logger.info(hint);
}

/** Pins `id` unless the host its requests would go to rejects it definitively (the `host`
 *  literal, else the slot's stored host, else what `auto` selects for it), or every surveyed host
 *  does. Otherwise the other hosts' verdicts are narrated, and with no acceptance at all (an
 *  unresolvable credential, every probe inconclusive, the account's host unknown) the pin lands
 *  unverified and says so. */
async function pinIdentity(
  id: string,
  profile: Profile,
  credential: Credential,
): Promise<void> {
  const { token, reason } = credential.resolveWithReason();
  if (token === null) {
    logger.warn(`Pinning \`${id}\` unverified: ${reason}.`);
  } else {
    const configuredHost = new CopilotEnvConfig().copilotHost(profile);
    // The host the pin's requests go to: the `host` literal, else the slot's stored host (what
    // every re-render bakes under the pin), else the pin's own selection (a slot never probed: the
    // next re-render probes and stores). Surveyed as the configured column, so it always has a
    // row whatever the account lookup answers.
    const inUseHost = configuredHost ??
      new CopilotEnvState().readProfileDirectPair(profile)?.host ??
      (await selectDirectIdentityAndHost(token, codexUserAgent(), {
        pinned: id,
        fixedHost: configuredHost,
        narrator: logger,
      })).apiBase;
    const survey = await surveyIntegrationIdentities(
      token,
      pinnedIdentityCandidates(id, codexUserAgent()),
      { configuredHost: inUseHost },
    );
    const inUseIndex = survey.hosts.findIndex((h) => sameOrigin(h.apiBase, inUseHost));
    const hosts = survey.hosts.map((column, i) => ({
      // Under `auto` the selection's host rides in as the configured column; its label says so.
      label: configuredHost === null && column.role === "configured"
        ? `${new URL(column.apiBase).host} (in use for this identity)`
        : hostLabel(column, configuredHost !== null && i === inUseIndex),
      verdict: column.verdicts[0]?.verdict,
    }));
    // "Every host" needs the account's host to be known: a transient lookup failure hides that
    // column, so the surveyed hosts' rejections alone cannot say so.
    if (!survey.designatedUnknown && hosts.every((h) => h.verdict?.kind === "rejected")) {
      throw new Error(
        [
          `every host rejects this credential under \`${id}\`; not pinned:`,
          ...hosts.map((h) =>
            `  - ${h.label}: ${h.verdict?.kind === "rejected" ? h.verdict.detail : ""}`
          ),
        ].join("\n"),
      );
    }
    // The host in use decides alone: acceptance elsewhere cannot carry a pin its requests never reach.
    const inUse = hosts[inUseIndex];
    if (inUse?.verdict?.kind === "rejected") {
      const why = configuredHost === null
        ? "the host auto selects for this identity"
        : "the host in use";
      throw new Error(
        `${inUse.label} rejects this credential under \`${id}\`; not pinned, every request ` +
          `goes to ${why}: ${inUse.verdict.detail}`,
      );
    }
    const accepted = hosts.filter((h) => h.verdict?.kind === "accepted").map((h) => h.label);
    const ground = accepted.length === 0
      ? "pinning unverified"
      : `pinning on ${accepted.join(" and ")} accepting it`;
    if (survey.designatedUnknown) {
      logger.warn(`The account's designated host could not be looked up (transient); ${ground}.`);
    }
    for (const h of hosts) {
      if (h.verdict === undefined || h.verdict.kind === "accepted") continue;
      const outcome = h.verdict.kind === "rejected" ? "rejects" : "could not verify";
      logger.warn(`${h.label}: ${outcome} \`${id}\` (${h.verdict.detail}); ${ground}.`);
    }
  }
  new CopilotEnvConfig().setProfile(profile, { identity: id });
  logger.success(
    `identity = ${id} (pinned; \`agent auth --identity auto\` restores probing).`,
  );
  noteIdentityApplies();
}

async function runIdentity(
  profile: Profile,
  choice: IdentityChoice,
): Promise<void> {
  switch (choice.kind) {
    case "auto":
      // The same literal `agent config --set identity auto` stores; the store reads it as no pin.
      new CopilotEnvConfig().setProfile(profile, { identity: "auto" });
      logger.success("identity = auto: the identity is probed per credential again.");
      noteIdentityApplies();
      return;
    case "pin":
      await pinIdentity(choice.id, profile, new Credential(undefined, profile));
      return;
    case "choose": {
      if (!process.stdin.isTTY) {
        throw new Error(
          "not a terminal - pass the identity: `agent auth --identity <id|auto>` " +
            "(see `agent auth --identities`)",
        );
      }
      const token = resolveForProbe(profile);
      if (token === null) return;
      const pinned = new CopilotEnvConfig().pinnedIntegrationId(profile);
      const survey = await surveyAndTable(profile, token, pinned);
      await runIdentity(profile, await chooseIdentity(survey, pinned));
      return;
    }
    default:
      assertNever(choice);
  }
}

/** Throws if acquisition fails, so `agent init` and `agent start` error out rather than proceed
 *  unauthenticated. */
export async function ensureAuthenticated(profile: Profile = null): Promise<void> {
  if (new Credential(undefined, profile).isAuthenticated()) return;
  logger.log(
    profile === null
      ? "  Not authenticated yet - let's log in to GitHub Copilot."
      : `  ${profileLabel(profile)} is not authenticated yet - let's log in to GitHub Copilot.`,
  );
  await authenticate({ kind: "choose" }, profile);
}

export type AuthAction =
  | { kind: "get"; profile: Profile }
  | { kind: "del"; profile: Profile }
  | { kind: "check"; profile: Profile }
  | { kind: "print-proxy-token"; profile: Profile }
  | { kind: "list" }
  | { kind: "identities"; profile: Profile }
  | { kind: "identity"; profile: Profile; choice: IdentityChoice }
  | { kind: "authenticate"; profile: Profile; acquisition: CredentialAcquisition };

const SUB_ACTION_FLAGS = "--get/--del/--check/--list/--identities/--identity/--print-proxy-token";

function providerConflictError(): Error {
  return new Error(
    `--provider selects how to authenticate and cannot combine with ${SUB_ACTION_FLAGS}`,
  );
}

function ghUserConflictError(): Error {
  return new Error(
    `--gh-user pins the gh account for authentication and cannot combine with ${SUB_ACTION_FLAGS}`,
  );
}

export function parseAuthAction(args: AuthArgs): AuthAction {
  const subActions = [
    args.get,
    args.del,
    args.check,
    args.printProxyToken,
    args.list,
    args.identities,
    args.identity !== undefined,
  ].filter(Boolean).length;
  if (subActions > 1) {
    throw new Error(
      "--get, --del, --check, --list, --identities, --identity, and --print-proxy-token are mutually exclusive",
    );
  }
  if (args.set !== undefined && subActions > 0) {
    throw new Error(`--set provisions a token and cannot combine with ${SUB_ACTION_FLAGS}`);
  }
  if (args.list) {
    if (args.profile !== undefined) {
      throw new Error("--list reports every profile; it does not combine with --profile");
    }
    if (args.provider !== undefined) throw providerConflictError();
    if (args.ghUser !== undefined) throw ghUserConflictError();
    return { kind: "list" };
  }
  // Ahead of the provider conflict, so an invalid name keeps reporting itself when a stray
  // --provider rides along.
  const profile: Profile = parseProfileFlag(args.profile);
  if (args.provider !== undefined && subActions > 0) throw providerConflictError();
  if (args.ghUser !== undefined && subActions > 0) throw ghUserConflictError();
  if (args.printProxyToken) return { kind: "print-proxy-token", profile };
  if (args.get) return { kind: "get", profile };
  if (args.del) return { kind: "del", profile };
  if (args.check) return { kind: "check", profile };
  if (args.identities) return { kind: "identities", profile };
  if (args.identity !== undefined) {
    // Validated here, like --provider, so a bad id fails before any probe or prompt.
    const choice: IdentityChoice = args.identity === true
      ? { kind: "choose" }
      : parseIdentityChoice(String(args.identity));
    return { kind: "identity", profile, choice };
  }
  return {
    kind: "authenticate",
    profile,
    acquisition: parseAcquisition(args.provider, args.set, args.ghUser),
  };
}

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
    case "identities":
      await runIdentities(action.profile);
      return;
    case "identity":
      await runIdentity(action.profile, action.choice);
      return;
    case "authenticate":
      await runAuthenticate(action.profile, action.acquisition);
      return;
    default:
      assertNever(action);
  }
}

/** Bare `agent auth` is idempotent only while the recorded provider STILL RESOLVES; a broken one
 *  (gh-cli after gh logout) re-prompts. An explicit `--provider` always runs, so it can switch the
 *  source. */
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
      noteStaticKeyStale(profile);
      return;
    }
  }

  // A complete Direct profile is rebaked by authenticate itself; anything else still needs the
  // `--add` that wires (or re-wires) it.
  const rebakes = profile !== null &&
    new CopilotEnvState().readProfileSlot(profile).mode === "direct";
  const provider = await authenticate(acquisition, profile);
  logger.success(
    profile === null
      ? `Authenticated (${provider}). Run \`agent init\` to configure Codex and Claude.`
      : rebakes
      ? `Authenticated ${profileLabel(profile)} (${provider}); its Direct wiring is rebaked for ` +
        "this credential."
      : `Authenticated ${profileLabel(profile)} (${provider}). Wire it into both agents with ` +
        `\`agent profile --add ${profile} --direct|--proxy\`.`,
  );
  if (!rebakes) noteStaticKeyStale(profile);
}

/** A baked value (static-key) never follows the store, so only the rewire brings it up to date. */
function noteStaticKeyStale(profile: Profile): void {
  const scope = new CopilotEnvConfig().staticKeyScope(profile);
  if (scope === "none") return;
  const whose = scope === "all"
    ? "Claude's and Codex's"
    : scope === "claude"
    ? "Claude's"
    : "Codex's";
  const rewire = profile === null
    ? "agent init"
    : `agent profile --add ${profile} --direct|--proxy`;
  logger.info(
    `static-key is ${scope}: ${whose} baked value stays as it is until \`${rewire}\` rewrites it.`,
  );
}
