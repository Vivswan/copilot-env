// The credential domain is the `Credential` class (src/copilot_api/credential.ts); this is the
// command and interactive layer. The agent Direct configs shell into `agent auth --get` at fetch
// time, so this command is also their resolver.
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

// Derived from AUTH_PROVIDERS (env_state.ts owns the list) so the flag hints can never drift.
const PROVIDER_CHOICES = AUTH_PROVIDERS.join("|");

export interface AuthArgs {
  provider?: string;
  set?: string | boolean;
  ghUser?: string;
  get?: boolean;
  del?: boolean;
  check?: boolean;
  printProxyToken?: boolean;
  profile?: string;
  list?: boolean;
}

function asProvider(provider: string): AuthProvider {
  const p = provider.trim().toLowerCase();
  if ((AUTH_PROVIDERS as readonly string[]).includes(p)) return p as AuthProvider;
  throw new Error(`--provider must be one of: ${AUTH_PROVIDERS.join(", ")} (got '${provider}')`);
}

/** `env` (bare `--set`) is headless and never prompts; `env-or-prompt` (no `--set`) falls back to a
 *  TTY prompt. The token itself is read at acquisition time, not here. */
type GhTokenSource =
  | { kind: "inline"; token: string }
  | { kind: "env" }
  | { kind: "env-or-prompt" };

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

type ResolvedAcquisition =
  | { kind: "copilot" }
  | { kind: "gh-cli"; account: GhCliAccountChoice }
  | { kind: "gh-token"; source: GhTokenSource };

/** A `--set` token can only travel inside the gh-token variant, and a `--gh-user` pin inside the
 *  gh-cli one, so `authenticate` cannot receive either under the wrong provider and silently drop
 *  it. */
export type CredentialAcquisition = { kind: "choose" } | ResolvedAcquisition;

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

/** The one place "--set implies gh-token" and "--gh-user implies gh-cli" live, shared by `agent
 *  auth` and `agent profile --add`. The two differ on `--set x --provider bogus`: `agent auth`
 *  validates the provider name first, `agent profile --add` treats any non-gh-token string as the
 *  --set conflict (`setConflictWins`). */
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
    // Commander's `--set [token]` never produces `false`, but a negatable flag must not silently
    // turn into "read the env".
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

/** Keyed exhaustively on AuthProvider so a vocabulary change fails the compile here. */
const PROVIDER_PICKER_DETAIL: Record<AuthProvider, string> = {
  "copilot": "device-flow browser login (read:user scope)",
  "gh-cli": "use the machine's `gh auth login`",
  "gh-token": `store ${ghTokenEnvVarsLabel(" / ")} (headless)`,
};

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

/** consola's text prompt echoes input and has no masked variant, so readline runs with a muted
 *  output stream and the query goes to stderr, keeping `--get`'s stdout contract untouched. */
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

async function loginWithGhToken(source: GhTokenSource): Promise<string> {
  let token: string;
  let fromEnv = true;
  if (source.kind === "env-or-prompt") {
    const envToken = ghTokenFromEnv();
    if (envToken) {
      token = envToken;
    } else {
      token = await promptForGhToken();
      fromEnv = false;
    }
  } else {
    token = tokenFromSetFlag(source.kind === "inline" ? source.token : true);
    fromEnv = source.kind !== "inline";
  }
  // "Using", never "Stored": persistence is the caller's single store write, which `agent profile
  // --add` commits later, atomically with the profile's mode, and which could still fail after this
  // prints.
  logger.success(
    fromEnv
      ? "  Using the GitHub token from the environment."
      : "  Using the provided GitHub token.",
  );
  return token;
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

/** A named profile's slot must already exist (`agent profile --add` is the only creator), and the
 *  gate fires BEFORE the acquisition so a typo'd name never costs a device flow. */
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
  printTable(rows, { indent: "" });
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
  | { kind: "authenticate"; profile: Profile; acquisition: CredentialAcquisition };

function providerConflictError(): Error {
  return new Error(
    "--provider selects how to authenticate and cannot combine with " +
      "--get/--del/--check/--list/--print-proxy-token",
  );
}

function ghUserConflictError(): Error {
  return new Error(
    "--gh-user pins the gh account for authentication and cannot combine with " +
      "--get/--del/--check/--list/--print-proxy-token",
  );
}

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
  // Ahead of the provider conflict, so an invalid name keeps reporting itself when a stray
  // --provider rides along.
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
