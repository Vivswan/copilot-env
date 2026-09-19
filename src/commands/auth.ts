// The credential domain is the `Credential` class (src/copilot_api/credential.ts); this is the
// command and interactive layer. The agent Direct configs shell into `agent auth --get` at fetch
// time, so this command is also their resolver.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { wireBothAgents } from "../agents/profile_wiring.ts";
import {
  AUTH_PROVIDERS,
  type AuthProvider,
  Credential,
  type GhAccountsLook,
  ghAccountsLook,
  ghAuthTokenLook,
  type GhTokenLook,
  liveCredentialSourceLabel,
} from "../copilot_api/credential.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { configSetCommand, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  assertProfileSlot,
  CopilotEnvState,
  type ProvisionedCredential,
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
import {
  githubDeviceFlowLogin,
  type GithubLoginLook,
  githubLoginLook,
} from "../copilot_api/github_login.ts";
import { profileHomeNames } from "../copilot_api/paths.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import {
  agentStopCommand,
  parseProfileFlag,
  type Profile,
  profileLabel,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { cyan } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { createStderrLogger, prompt } from "../utils/logger.ts";
import { printWrapped, terminalWidth, wrapMessage } from "../utils/table.ts";
import { PLANNED_SECRET } from "../utils/dry_run.ts";
import { dryRunActive } from "../utils/fs_facade.ts";
import { runDryRun } from "./dry_run.ts";
import {
  chooseIdentity,
  type IdentityChoice,
  parseIdentityChoice,
  runIdentities,
  runIdentity,
} from "./identity.ts";

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
  profile?: string;
  identities?: boolean;
  /** `true` is the bare flag (interactive choice); a string is the id to pin, or `auto`. */
  identity?: string | boolean;
  /** Print what the credential landing would write (the slot, a Direct profile's rebake) and write
   *  nothing. No login and no prompt run; the read-only lookups do (gh-cli's `gh auth token`
   *  resolve and the saved-account look, gh-env's env read), so the slot is planned from what the
   *  flags and those reads carry (plannedAcquisition), and the flow the real command would run is
   *  named. */
  dryRun?: boolean;
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
 *  profile auth` and `agent profile <name> add`. The two differ on `--set x --provider bogus`:
 *  `agent auth` validates the provider name first, `agent profile <name> add` treats any
 *  non-gh-token string as the --set conflict (`setConflictWins`). */
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
  const value = await prompt("How should GitHub Copilot authenticate?", {
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
/** How the chooser may settle: `interactive` asks; `headless` (no TTY) and `dry-run` (a preview
 *  never asks) pin the active account or refuse with the flag that answers. */
export type GhAccountChooserMode = "interactive" | "headless" | "dry-run";

export async function chooseGhAccount(
  look: () => GhAccountsLook = ghAccountsLook,
  mode: GhAccountChooserMode = process.stdin.isTTY ? "interactive" : "headless",
): Promise<SettledGhAccount> {
  const interactive = mode === "interactive";
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
    if (!interactive || envOnly(only) === null) {
      return { kind: "pinned", login: only };
    }
  }
  if (!interactive) {
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
        `--gh-user <login> (pinnable: ${logins.join(", ")})` +
        (mode === "dry-run"
          ? " to plan that landing (a dry run never prompts)"
          : ", or run `agent auth --provider gh-cli` in a terminal"),
    );
  }
  // The active account leads (the default selection); auto is LAST and explicit.
  const ordered = [...logins].sort((a, b) => Number(b === active) - Number(a === active));
  const activeLabel = active === null ? "" : ` (currently ${active})`;
  const value = await prompt("Which gh account should Direct auth use?", {
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

/** copilot-env runs GitHub's device flow itself (github_login.ts) and RETURNS the token: the caller's
 *  single store write is the only place it lands, so no proxy-side token file exists to drift from
 *  the store. The prompt goes to stderr like every other narration. */
async function loginWithCopilot(): Promise<string> {
  return await githubDeviceFlowLogin({
    announce: (code) => {
      logger.info(
        `  Open ${cyan(code.verificationUri)} and enter the code ${cyan(code.userCode)} ` +
          `(valid ${Math.round(code.expiresInS / 60)} minutes); waiting for GitHub ...`,
      );
    },
  });
}

/** consola's text prompt echoes input and has no masked variant, and its confirm takes two lines, so
 *  readline serves both: `secret` mutes the echo. The query goes to stderr, keeping `--get`'s stdout
 *  contract untouched. */
function readAnswer(rawQuery: string, secret: boolean): Promise<string> {
  const query = wrapMessage(rawQuery, terminalWidth(process.stderr));
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
// <name> add` commits later, atomically with the profile's mode, and which could still fail after
// this prints.
async function loginWithGhToken(inline: string | null): Promise<string> {
  const token = providedToken(inline ?? await promptForGhToken());
  const look = await githubLoginLook(token);
  logger.success(`  Using ${tokenLabel("the provided GitHub token", token, look)}.`);
  return token;
}

/** The one reading of a `--set` (or typed) token, shared by the login and the dry run's plan so a
 *  blank refuses in both before anything else runs. */
function providedToken(raw: string): string {
  const token = raw.trim();
  if (token === "") throw new Error("the provided GitHub token is empty");
  return token;
}

function noEnvTokenError(): Error {
  return new Error(`no GitHub token in the environment: set one of ${ghTokenEnvVarsList()}`);
}

/** A terminal sees the var and its account before the token is used; headless cannot ask, so it takes
 *  the most specific var and says so. */
async function chooseEnvToken(): Promise<GhEnvToken & { look: GithubLoginLook }> {
  const found = ghTokensInEnv();
  const first = found[0];
  if (first === undefined) throw noEnvTokenError();
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
  const value = await prompt("Which token should GitHub Copilot use?", {
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
  assertGhCliResolves(ghUser, look);
  logger.success(
    ghUser !== null
      ? `  Using the gh CLI login (account ${ghUser}) as the Direct credential.`
      : activeLogin !== null
      ? `  Using the gh CLI login on AUTO (currently account ${activeLogin}; follows gh ` +
        "account switches) as the Direct credential."
      : "  Using the gh CLI login on AUTO (follows gh account switches) as the Direct credential.",
  );
}

/** Verified BEFORE recording, or a failed check would point `--get` at a `gh` that cannot produce
 *  a token. An UNPROVEN look wears its own words: "not authenticated" and the `gh auth login`
 *  advice are wrong when gh was never asked. Every miss quotes the gh call and its stderr: the
 *  fix differs by cause (an old gh, a missing login, a switched account, an env token), and the
 *  look named it. Read-only, so a dry run runs it too. */
function assertGhCliResolves(
  ghUser: string | null,
  look: (ghUser: string | null) => GhTokenLook,
): void {
  const gh = look(ghUser);
  if (gh.token === null) {
    const detail = gh.detail ?? "`gh auth token` gave no token";
    if (gh.unproven) {
      throw new Error(
        `could not check gh authentication (${detail}) - retry \`agent auth\``,
      );
    }
    throw new Error(
      ghUser === null
        ? `gh is not authenticated (${detail}) - run \`gh auth login\`, then retry \`agent auth\``
        : `gh has no saved credential for account '${ghUser}' (${detail}) - ` +
          `run \`gh auth login\` for that account, pass --gh-user <login> for another, ` +
          "or choose auto interactively via `agent auth --provider gh-cli`",
    );
  }
}

/** Whether `credential` is a dry run's stand-in for a login that did not run (PLANNED_SECRET).
 *  Only inside a dry run: a real token spelled like the placeholder is a token. */
export function isPlannedCredential(credential: ProvisionedCredential): boolean {
  return dryRunActive() && credential.kind === "stored" && credential.token === PLANNED_SECRET;
}

/** A dry run acquires nothing: no device flow, no GitHub lookup, no prompt. It plans the slot
 *  write from what the flags carry (a `--set` token, a gh-cli pin), from the same read-only account
 *  resolution the real command runs (gh-cli's saved accounts, never a prompt), or from
 *  PLANNED_SECRET, and says what the real command would do for `profile`'s slot. A bare
 *  acquisition names no provider to plan from. */
async function plannedAcquisition(
  acquisition: CredentialAcquisition,
  profile: Profile,
  look: (ghUser: string | null) => GhTokenLook,
  chooseAccount: () => Promise<SettledGhAccount>,
): Promise<ProvisionedCredential> {
  const slot = profile === null
    ? "the default profile's credential slot"
    : `${profileLabel(profile)}'s credential slot`;
  switch (acquisition.kind) {
    case "choose":
      throw new Error(
        `a dry run never prompts: pass --provider <${PROVIDER_CHOICES}> (or --set <token>) to ` +
          `plan the credential landing for ${slot}`,
      );
    case "gh-token": {
      if (acquisition.token === null) {
        throw new Error(
          `a dry run never prompts: pass --set <token> to plan the landing for ${slot}`,
        );
      }
      // The login's own reading, refusal included, before any plan row is landed.
      const token = providedToken(acquisition.token);
      logger.log(
        `  Would store the provided token in ${slot} (its GitHub account is looked up when the landing is real).`,
      );
      return { kind: "stored", provider: "gh-token", token };
    }
    case "gh-env": {
      // The same environment read as the real command, refused the same way when nothing is set;
      // with several set, the headless rule (the most specific) rather than a prompt.
      const found = ghTokensInEnv();
      const first = found[0];
      if (first === undefined) throw noEnvTokenError();
      logger.log(
        `  Would take the token from $${first.name}${
          found.length > 1 ? ` (the most specific of ${found.length} set)` : ""
        } and land it in ${slot}; its GitHub account is looked up when the landing is real.`,
      );
      return { kind: "stored", provider: "gh-env", token: first.token };
    }
    case "copilot":
      logger.log(`  Would run GitHub's device flow and land the token in ${slot}.`);
      return { kind: "stored", provider: "copilot", token: PLANNED_SECRET };
    case "gh-cli": {
      // The real command's pin resolution, off gh's saved accounts (a read); the arm that would
      // prompt says to pass --gh-user instead.
      const account = acquisition.account.kind === "choose"
        ? await chooseAccount()
        : acquisition.account;
      const pinned = account.kind === "pinned" ? account.login : null;
      // The same read-only `gh auth token` check, refused the same way (an env-only account has no
      // saved credential to pin).
      assertGhCliResolves(pinned, look);
      logger.log(
        `  Would record the gh CLI login (${
          pinned === null ? "the active account" : `account ${pinned}`
        }) as ${slot}.`,
      );
      return { kind: "gh-cli", ghUser: pinned };
    }
    default:
      return assertNever(acquisition);
  }
}

/** Never persists: the caller owns the single store write (`authenticate` into an existing slot,
 *  whose mode `agent profile <name> add` recorded first). `profile` names the slot a dry run's
 *  narration speaks of; `seams` are test substitutes for the gh lookups. */
export async function acquireCredential(
  acquisition: CredentialAcquisition,
  profile: Profile = null,
  seams: {
    look?: (ghUser: string | null) => GhTokenLook;
    chooseAccount?: () => Promise<SettledGhAccount>;
  } = {},
): Promise<ProvisionedCredential> {
  if (dryRunActive()) {
    return plannedAcquisition(
      acquisition,
      profile,
      seams.look ?? ghAuthTokenLook,
      seams.chooseAccount ?? (() => chooseGhAccount(undefined, "dry-run")),
    );
  }
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
    return { kind: "stored", provider: "copilot", token: await loginWithCopilot() };
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

/** A named profile's slot must already exist (`agent profile <name> add` is the only creator), and the
 *  gate fires BEFORE the acquisition so a typo'd name never costs a device flow. A complete Direct
 *  profile is rebaked here with a fresh selection: the credential write took the previous
 *  credential's stored pair with it, and every re-render bakes the slot's pair, so the landing is
 *  where the new one is probed and stored. */
export async function authenticate(
  acquisition: CredentialAcquisition,
  profile: Profile,
): Promise<AuthProvider> {
  if (profile !== null) assertProfileSlot(profile);
  const credential = await acquireCredential(acquisition, profile);
  new Credential(undefined, profile).record(credential);
  if (profile !== null) {
    // The landing completes the profile `add` recorded, or rebakes one already wired: both agents
    // from the slot. A Direct write selects the identity WITH the token, and a dry run's stand-in
    // selects nothing, so the wiring is named, not planned.
    const slot = new CopilotEnvState().readProfileSlot(profile);
    if (slot.kind === "complete") {
      if (isPlannedCredential(credential)) {
        logger.log(
          `  Would wire ${profileLabel(profile)}'s ${slot.mode} mode into both agents for the ` +
            "landed token" +
            (slot.mode === "direct" ? " (the Direct identity selected with it)." : "."),
        );
      } else {
        await wireBothAgents(profile, slot.mode, false, "probe");
      }
    }
  }
  return credential.kind === "gh-cli" ? "gh-cli" : credential.provider;
}

// --- sub-actions ------------------------------------------------------------

/** The read-back sub-actions report instead of hard-failing, so their repair hint must branch the
 *  way the store's write gate does: an existing slot re-auths via `agent profile <name> auth`, a
 *  nonexistent name can only be created by `agent profile <name> add`. */
function profileSlotMissing(profile: ProfileName): boolean {
  return !new CopilotEnvState().profileSlotStatus(profile).exists;
}

/** A half-created profile (a daemon home without a store slot) reports itself the way
 *  missingProfileSlotError in env_state.ts does, never as "no such profile". */
function noSuchProfileHint(profile: ProfileName): string {
  if (profileHomeNames().includes(profile)) {
    return `profile '${profile}' has no store slot (half-created; its daemon home exists) - ` +
      `re-create it with \`agent profile ${profile} add --direct|--proxy\``;
  }
  return `no such profile '${profile}' - create it with ` +
    `\`agent profile ${profile} add --direct|--proxy\``;
}

/** Null when nothing resolves; the reason has already been reported and the exit code set. */
function resolveOrReport(profile: Profile): string | null {
  const { token, reason } = new Credential(undefined, profile).resolveWithReason();
  if (token === null) {
    logger.error(
      profile !== null && profileSlotMissing(profile) ? noSuchProfileHint(profile) : reason,
    );
    process.exitCode = 1;
  }
  return token;
}

/** Codex re-runs this every 300s through auth.command, so it returns the token and nothing more: a
 *  token-returning command writes no agent file. The catalog and its config.toml reference are the
 *  wiring and launch commands' to keep. */
async function runGet(profile: Profile): Promise<void> {
  const token = resolveOrReport(profile);
  if (token === null) return;
  // codeql[js/clear-text-logging] -- emitting the token on stdout IS this command's
  // contract (like `gh auth token`); the agent configs consume it.
  process.stdout.write(`${token}\n`);
}

/** The de-auth and the daemon stop, with what to say once they are real (a dry run prints the plan
 *  in their place). */
async function runDel(profile: Profile): Promise<() => void> {
  const cleared = new Credential(undefined, profile).clear();
  // A running daemon has already exchanged the token for a Copilot bearer and would keep serving
  // until it idled out; the SIGKILL grace VERIFIES it died so access is never falsely reported as
  // revoked.
  const stop = cleared ? await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, profile) : null;
  return () => {
    if (stop !== null) {
      const { signalled, stopped } = stop;
      if (profile === null) {
        // The wordings are an output contract. `stopped` first: a stop REFUSED (unprovable pid,
        // nothing signalled) must report the still-running daemon, never the plain success.
        if (!stopped) {
          logger.warn(
            "De-authenticated, but the proxy is still running and may keep serving the old " +
              "credential -- stop it with `agent stop`.",
          );
        } else if (signalled) {
          logger.success(
            "De-authenticated and stopped the proxy. Run `agent auth` to log in again.",
          );
        } else {
          logger.success("De-authenticated. Run `agent auth` to log in again.");
        }
      } else {
        const again = `\`agent profile ${profile} auth\``;
        if (!stopped) {
          logger.warn(
            `De-authenticated ${
              profileLabel(profile)
            }, but its proxy is still running and may keep ` +
              `serving the old credential -- stop it with \`${agentStopCommand(profile)}\`.`,
          );
        } else if (signalled) {
          logger.success(
            `De-authenticated ${
              profileLabel(profile)
            } and stopped its proxy. Run ${again} to log in again.`,
          );
        } else {
          logger.success(
            `De-authenticated ${profileLabel(profile)}. Run ${again} to log in again.`,
          );
        }
      }
    } else if (profile === null) {
      logger.info("Nothing to clear - not authenticated. Run `agent auth` to log in.");
    } else if (profileSlotMissing(profile)) {
      logger.info(`Nothing to clear - ${noSuchProfileHint(profile)}.`);
    } else {
      logger.info(
        `Nothing to clear for ${profileLabel(profile)} - not authenticated. Run ` +
          `\`agent profile ${profile} auth\` to log in.`,
      );
    }
    // Whatever the store held, a baked copy may still sit in the agent configs.
    noteStaticKeyStale(profile);
  };
}

function runCheck(profile: Profile): void {
  // The exit code is the machine contract; the status line goes to stdout like its peers `agent
  // profile check --codex|--claude`. The default output is byte-identical to before profiles existed (flag
  // and label are empty).
  const credential = new Credential(undefined, profile);
  const { provider, resolves } = credential.status();
  const authCommand = profile === null ? "agent auth" : `agent profile ${profile} auth`;
  const label = profile === null ? "" : ` (${profileLabel(profile)})`;
  if (provider === null) {
    if (profile !== null && profileSlotMissing(profile)) {
      printWrapped(noSuchProfileHint(profile));
    } else {
      printWrapped(`not authenticated${label} - run \`${authCommand}\``);
    }
    process.exitCode = 1;
    return;
  }
  const source = liveCredentialSourceLabel(credential.read()) ?? provider;
  if (resolves) {
    printWrapped(`authenticated (${source})${label}`);
    process.exitCode = 0;
  } else {
    // e.g. gh-cli selected but `gh` is no longer authenticated (as the pinned account).
    printWrapped(
      `provider '${source}' selected but no credential resolves${label} - run \`${authCommand}\``,
    );
    process.exitCode = 1;
  }
}

/** Throws if acquisition fails, so `agent init` (and every wiring command) errors out rather than
 *  proceed unauthenticated; `agent start` never asks, it refuses (readLaunchToken). */
export async function ensureAuthenticated(profile: Profile = null): Promise<void> {
  if (new Credential(undefined, profile).isAuthenticated()) return;
  // A dry run never logs in, and the wiring it previews is decided with the credential.
  if (dryRunActive()) {
    const authCommand = profile === null ? "agent auth" : `agent profile ${profile} auth`;
    throw new Error(
      `${profileLabel(profile)} is not authenticated, and a dry run never logs in; run ` +
        `\`${authCommand}\` first, then re-run with --dry-run`,
    );
  }
  logger.log(
    profile === null
      ? "  Not authenticated yet - let's log in to GitHub Copilot."
      : `  ${profileLabel(profile)} is not authenticated yet - let's log in to GitHub Copilot.`,
  );
  await authenticate({ kind: "choose" }, profile);
}

/** `choose` is the bare flag: the interactive pick, in a terminal (src/commands/identity.ts). */
type IdentityRequest = IdentityChoice | { kind: "choose" };

export type AuthAction =
  | { kind: "get"; profile: Profile }
  | { kind: "del"; profile: Profile; dryRun: boolean }
  | { kind: "check"; profile: Profile }
  | { kind: "identities"; profile: Profile }
  | { kind: "identity"; profile: Profile; choice: IdentityRequest }
  | {
    kind: "authenticate";
    profile: Profile;
    acquisition: CredentialAcquisition;
    dryRun: boolean;
  };

const SUB_ACTION_FLAGS = "--get/--del/--check";

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
    args.identities,
    args.identity !== undefined,
  ].filter(Boolean).length;
  if (subActions > 1) {
    throw new Error(
      "--get, --del, and --check are mutually exclusive",
    );
  }
  if (args.set !== undefined && subActions > 0) {
    throw new Error(`--set provisions a token and cannot combine with ${SUB_ACTION_FLAGS}`);
  }
  // The two writers preview; the reads have nothing to preview.
  if (args.dryRun && subActions > 0 && !args.del) {
    throw new Error(
      "--dry-run previews the credential landing or --del and cannot combine with the read-only " +
        "--get/--check",
    );
  }
  // Ahead of the provider conflict, so an invalid name keeps reporting itself when a stray
  // --provider rides along.
  const profile: Profile = parseProfileFlag(args.profile);
  if (args.provider !== undefined && subActions > 0) throw providerConflictError();
  if (args.ghUser !== undefined && subActions > 0) throw ghUserConflictError();
  if (args.get) return { kind: "get", profile };
  if (args.del) return { kind: "del", profile, dryRun: Boolean(args.dryRun) };
  if (args.check) return { kind: "check", profile };
  if (args.identities) return { kind: "identities", profile };
  if (args.identity !== undefined) {
    // Validated here, like --provider, so a bad id fails before any probe or prompt.
    const choice: IdentityRequest = args.identity === true
      ? { kind: "choose" }
      : parseIdentityChoice(String(args.identity));
    return { kind: "identity", profile, choice };
  }
  return {
    kind: "authenticate",
    profile,
    acquisition: parseAcquisition(args.provider, args.set, args.ghUser),
    dryRun: Boolean(args.dryRun),
  };
}

export async function runAuth(args: AuthArgs): Promise<void> {
  const action = parseAuthAction(args);
  switch (action.kind) {
    case "get":
      await runGet(action.profile);
      return;
    case "del":
      if (action.dryRun) {
        await runDryRun(() => runDel(action.profile));
      } else {
        (await runDel(action.profile))();
      }
      return;
    case "check":
      runCheck(action.profile);
      return;
    case "identities": {
      const token = resolveOrReport(action.profile);
      if (token !== null) await runIdentities(action.profile, token);
      return;
    }
    case "identity": {
      if (action.choice.kind !== "choose") {
        await runIdentity(action.profile, action.choice);
        return;
      }
      if (!process.stdin.isTTY) {
        throw new Error(
          `not a terminal - pass the identity: \`${
            configSetCommand("identity", "<id|auto>", action.profile)
          }\` (see \`agent profile identity\`)`,
        );
      }
      const token = resolveOrReport(action.profile);
      if (token !== null) {
        await runIdentity(action.profile, await chooseIdentity(action.profile, token));
      }
      return;
    }
    case "authenticate": {
      // The landing narrates only once it landed: a dry run prints the plan in its place.
      if (action.dryRun) {
        await runDryRun(() => runAuthenticate(action.profile, action.acquisition));
      } else {
        (await runAuthenticate(action.profile, action.acquisition))();
      }
      return;
    }
    default:
      assertNever(action);
  }
}

/** Bare `agent auth` is idempotent only while the recorded provider STILL RESOLVES; a broken one
 *  (gh-cli after gh logout) re-prompts. An explicit `--provider` always runs, so it can switch the
 *  source. Returns what to say once the landing is real. */
async function runAuthenticate(
  profile: Profile,
  acquisition: CredentialAcquisition,
): Promise<() => void> {
  if (acquisition.kind === "choose") {
    const credential = new Credential(undefined, profile);
    const { provider, resolves } = credential.status();
    if (provider !== null && resolves) {
      const source = liveCredentialSourceLabel(credential.read()) ?? provider;
      return () => {
        if (profile === null) {
          // The default wording is an output contract -- keep it byte-identical.
          logger.success(
            `Already authenticated (${source}). Switch with ` +
              `\`agent auth --provider <${PROVIDER_CHOICES}>\`, or clear it with \`agent auth --del\`.`,
          );
        } else {
          logger.success(
            `Already authenticated (${source}, ${profileLabel(profile)}). Switch with ` +
              `\`agent profile ${profile} auth --provider <${PROVIDER_CHOICES}>\`, or clear it ` +
              `with \`agent profile ${profile} auth --del\`.`,
          );
        }
        noteStaticKeyStale(profile);
      };
    }
  }

  // A named profile with a recorded mode is wired by authenticate itself; one without (a daemon
  // home and no slot) still needs the `add` that records it.
  const mode = profile === null ? null : new CopilotEnvState().readProfileSlot(profile).mode;
  const provider = await authenticate(acquisition, profile);
  return () => {
    if (profile === null) {
      logger.success(
        `Authenticated (${provider}). Run \`agent init\` to configure Codex and Claude.`,
      );
    } else if (mode !== null) {
      logger.success(
        `Authenticated ${profileLabel(profile)} (${provider}); both agents are wired for its ` +
          `${mode} mode.`,
      );
      logger.log(`  Launch it:  cl --profile ${profile}  /  cx --profile ${profile}`);
    } else {
      logger.success(
        `Authenticated ${profileLabel(profile)} (${provider}). Wire it into both agents with ` +
          `\`agent profile ${profile} add --direct|--proxy\`.`,
      );
    }
    if (mode === null) noteStaticKeyStale(profile);
  };
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
  const rewire = profile === null ? "agent init" : `agent profile ${profile} add --direct|--proxy`;
  logger.info(
    `static-key is ${scope}: ${whose} baked value stays as it is until \`${rewire}\` rewrites it.`,
  );
}
