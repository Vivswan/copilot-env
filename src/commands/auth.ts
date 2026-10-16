// The credential domain is the `Credential` class (src/copilot_api/credential.ts); this is the
// command and interactive layer. The agent Direct configs shell into `agent auth --get` at fetch
// time, so this command is also their resolver.
import { wireBothAgents } from "../agents/profile_wiring.ts";
import {
  accountSourceLabel,
  Credential,
  type GhAccountsLook,
  type GhTokenLook,
  ghAccountsLook,
  ghAuthTokenLook,
} from "../copilot_api/credential.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig, configSetCommand } from "../copilot_api/env_config.ts";
import {
  AUTH_PROVIDERS,
  type AuthProvider,
  assertProfileSlot,
  CopilotEnvState,
  missingProfileSlotError,
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
  type GithubLoginLook,
  githubDeviceFlowLogin,
  githubLoginLook,
} from "../copilot_api/github_login.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import {
  agentAuthCommand,
  agentStopCommand,
  type Profile,
  type ProfileName,
  parseProfileFlag,
  profileLabel,
} from "../copilot_api/profile.ts";
import { colorEnabled, cyan, paintFor } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { PLANNED_SECRET } from "../utils/dry_run.ts";
import { errMessage } from "../utils/error.ts";
import { dryRunActive } from "../utils/fs_facade.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { scannable } from "../utils/message.ts";
import { prompt, promptSecret } from "../utils/prompt.ts";
import { printWrapped, terminalWidth } from "../utils/table.ts";
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

/** `auto` is the one `--gh-user` value that is not a login: the user's explicit choice to follow
 *  gh's active account, the same choice as the picker's last entry. A GitHub user of that name
 *  cannot be pinned by this flag. */
const GH_USER_AUTO = "auto";

type GhCliAccountChoice = { kind: "pinned"; login: string } | { kind: "auto" } | { kind: "choose" };

/** PINNING IS THE ONLY DEFAULT: the credential never follows an account the user did not choose,
 *  or their Copilot credit would burn on it after a `gh auth login`. Auto comes from two explicit
 *  choices alone, the picker's last option and `--gh-user auto`; `activeLogin` is the account it
 *  follows right now when the listing named one. The gh looks at write time settle the selection
 *  into the slot (settleGhCliAccount). */
type GhAccountSelection =
  | { kind: "auto"; activeLogin: string | null }
  | { kind: "pinned"; login: string };

type GhCliSlot =
  | { kind: "pinned"; ghUser: string }
  | { kind: "auto"; ghUser: null; activeLogin: string | null };

/** gh-token's null token means "prompt for a paste"; the env read is gh-env's whole job. */
type ResolvedAcquisition =
  | { kind: "copilot" }
  | { kind: "gh-cli"; account: GhCliAccountChoice }
  | { kind: "gh-token"; token: string | null }
  | { kind: "gh-env" };

/** A `--set` token can only travel inside the gh-token variant, and a `--gh-user` pin inside the
 *  gh-cli one, so `authenticate` cannot receive either under the wrong provider and silently drop
 *  it. */
type CredentialAcquisition = { kind: "choose" } | ResolvedAcquisition;

export type { CredentialAcquisition };

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
 *  auth`, `agent profile <name> auth`, and `agent profile [<name>] add` (which carries --gh-user
 *  alone). */
export function parseAcquisition(
  provider: string | undefined,
  set: string | undefined,
  ghUser: string | undefined,
): CredentialAcquisition {
  if (ghUser !== undefined) {
    if (set !== undefined) {
      throw new Error("--gh-user only applies to `--provider gh-cli` (--set implies gh-token)");
    }
    if (provider !== undefined && asProvider(provider) !== "gh-cli") {
      throw new Error("--gh-user only applies to `--provider gh-cli`");
    }
    const login = ghUser.trim();
    if (login.toLowerCase() === GH_USER_AUTO) return { kind: "gh-cli", account: { kind: "auto" } };
    if (!GH_LOGIN_RE.test(login)) {
      throw new Error(
        "--gh-user must be a GitHub login (1-39 letters, digits, dashes, or underscores) or `auto`",
      );
    }
    return { kind: "gh-cli", account: { kind: "pinned", login } };
  }
  if (set !== undefined) {
    if (provider !== undefined && asProvider(provider) !== "gh-token") {
      throw new Error("--set only applies to `--provider gh-token`");
    }
    return { kind: "gh-token", token: set };
  }
  if (provider === undefined) return { kind: "choose" };
  return acquisitionForProvider(asProvider(provider));
}

/** Keyed exhaustively on AuthProvider so a vocabulary change fails the compile here. */
const PROVIDER_PICKER_DETAIL: Record<AuthProvider, string> = {
  copilot: "device-flow browser login (read:user scope)",
  "gh-cli": "use the machine's `gh auth login`",
  "gh-token": "paste a GitHub token",
  "gh-env": `copy a token from ${ghTokenEnvVarsLabel(" / ")} (headless)`,
};

/** `authCommand` is the slot's own `auth` (agentAuthCommand), the one command whose flags the
 *  ways out name: a fresh profile's `add --auto` carries neither --provider nor --set. */
async function chooseProvider(authCommand: string): Promise<AuthProvider> {
  if (!process.stdin.isTTY) {
    throw new Error(
      scannable({
        headline: "not a terminal - store a credential first.",
        lead: "Pick one:",
        actions: [
          [`${authCommand} --provider gh-env`, PROVIDER_PICKER_DETAIL["gh-env"]],
          [`${authCommand} --provider ${PROVIDER_CHOICES}`, "store a credential by provider"],
          [`${authCommand} --set <token>`, "store a GitHub token"],
        ],
      }),
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

/** How the chooser may settle: `interactive` asks; `headless` (no TTY) and `dry-run` (a preview
 *  never asks) pin the active account or refuse with the flag that answers. */
type GhAccountChooserMode = "interactive" | "headless" | "dry-run";

/**
 * Pinning is the only default: a later `gh auth login` must never switch whose Copilot credit gets
 * spent. When nothing can be pinned honestly this throws naming the escape hatches; auto is only
 * ever the picker's explicit last option. `retry` is the command that runs this acquisition again
 * as it was asked (the owner composes it: a bare `auth` on a stored credential is idempotent and
 * asks nothing); every way out is it or extends it, so a named profile's refusal never sends the
 * reader to the default slot. `look` is a test seam.
 */
export async function chooseGhAccount(
  retry: string,
  look: () => GhAccountsLook = ghAccountsLook,
  mode: GhAccountChooserMode = process.stdin.isTTY ? "interactive" : "headless",
): Promise<GhAccountSelection> {
  const interactive = mode === "interactive";
  const listing = look();
  if (listing.kind === "unproven") {
    throw new Error(
      scannable({
        headline: "could not list gh accounts.",
        evidence: ["`gh auth status` did not run to completion"],
        lead: "Pick one:",
        actions: [
          [retry, "run it again"],
          [`${retry} --gh-user <login>`, "pin an account by name, no listing needed"],
        ],
      }),
    );
  }
  const { accounts } = listing;
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
      scannable({
        headline: "gh has no logged-in github.com account.",
        lead: "Fix:",
        actions: [
          ["gh auth login", "log in"],
          [retry, "then run it again"],
        ],
      }),
    );
  }
  if (logins.length === 1 && allLogins.length === 1) {
    const only = logins[0] ?? "";
    // A sole env-only login's pin can fail verification with no other account to escape to;
    // interactively the user decides, without a TTY the pin proceeds and a failure names the
    // recovery.
    if (envOnly(only) === null || !interactive) return { kind: "pinned", login: only };
  }
  if (!interactive) {
    // Anything but the active account would guess whose credit to spend, so it is an error, never a
    // fallback.
    if (active !== null && logins.includes(active)) {
      logger.info(
        scannable({
          headline: `gh has ${allLogins.length} logged-in accounts; pinning the active one.`,
          evidence: [`active account: ${active}`],
          lead: "Pick one:",
          actions: [
            [`${retry} --gh-user <login>`, "pin another account"],
            [retry, "choose in a terminal (auto included)"],
          ],
        }),
      );
      return { kind: "pinned", login: active };
    }
    const dryRun = mode === "dry-run";
    throw new Error(
      scannable({
        headline: `gh has ${allLogins.length} logged-in accounts and no pinnable active one.`,
        evidence: [`pinnable: ${logins.join(", ")}`],
        lead: dryRun ? "Fix:" : "Pick one:",
        actions: dryRun
          ? [["--gh-user <login>", "add it to plan that landing (a dry run never prompts)"]]
          : [
              [`${retry} --gh-user <login>`, "pin one of them"],
              [retry, "choose in a terminal"],
            ],
      }),
    );
  }
  // The active account leads (the default selection); auto is LAST and explicit.
  const ordered = [...logins].sort((a, b) => Number(b === active) - Number(a === active));
  const value = await prompt("Which gh account should Direct auth use?", {
    type: "select",
    options: ghAccountChoices(ordered, active, envOnly),
    cancel: "reject",
  });
  const login = String(value);
  return login === "" ? { kind: "auto", activeLogin: active } : { kind: "pinned", login };
}

/** The picker's rows: each login, then auto, with what picking it means as the row's hint (a
 *  login runs to 39 characters, so the label carries nothing else). `envOnly` names the env var
 *  a login is listed through when it has no saved credential. Exported for the wording test. */
export function ghAccountChoices(
  ordered: readonly string[],
  active: string | null,
  envOnly: (login: string) => string | null,
): { label: string; value: string; hint: string }[] {
  const activeLabel = active === null ? "" : ` (currently ${active})`;
  return [
    ...ordered.map((login) => {
      const env = envOnly(login);
      const notes = [
        "always use this account",
        login === active ? "currently active" : null,
        env === null ? null : `via $${env}; pinning needs a saved login`,
      ]
        .filter((n) => n !== null)
        .join("; ");
      return { label: login, value: login, hint: notes };
    }),
    // A GitHub login is never empty, so "" cannot collide with a real choice.
    {
      label: GH_USER_AUTO,
      value: "",
      hint: `follow gh's active account${activeLabel}; switches when you switch gh`,
    },
  ];
}

// --- provider acquisition ---------------------------------------------------

/** copilot-env runs GitHub's device flow itself (github_login.ts) and RETURNS the token: the caller's
 *  single store write is the only place it lands, so no proxy-side token file exists to drift from
 *  the store. The prompt goes to stderr like every other narration. */
async function loginWithCopilot(): Promise<string> {
  const token = await githubDeviceFlowLogin({
    announce: (code) => {
      logger.info(
        scannable({
          headline: "Waiting for GitHub.",
          evidence: [`the code is valid ${Math.round(code.expiresInS / 60)} minutes`],
          lead: "Then:",
          actions: [
            [code.verificationUri, "open it in a browser"],
            [code.userCode, "enter this code"],
          ],
        }),
      );
    },
  });
  // The same account line as the token providers, so every landing names who it is.
  const look = await githubLoginLook(token);
  logger.success(`  Using ${tokenLabel("the device-flow token", token, look)}.`);
  return token;
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
      scannable({
        headline: "no GitHub token given.",
        lead: "Pick one:",
        actions: [
          ["--set <token>", "pass the token"],
          ["--provider gh-env", `copy one of ${ghTokenEnvVarsList()}`],
        ],
      }),
    );
  }
  const token = await promptSecret("Paste your Copilot-enabled GitHub token");
  if (token === undefined) throw new Error("cancelled");
  return token;
}

// The account is a LABEL, never a gate: a look that missed says why and the token is used anyway.
// "Using", never "Stored": persistence is the caller's single store write, which `agent profile
// <name> add` commits later, atomically with the profile's mode, and which could still fail after
// this prints.
async function loginWithGhToken(inline: string | null): Promise<string> {
  const token = providedToken(inline ?? (await promptForGhToken()));
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
  return new Error(
    scannable({
      headline: "no GitHub token in the environment.",
      lead: "Fix:",
      actions: [[ghTokenEnvVarsList(), "set one of these"]],
    }),
  );
}

/** A terminal sees the var and its account before the token is used; headless cannot ask, so it takes
 *  the most specific var and says so. `rerun` is the command that ran this acquisition. */
async function chooseEnvToken(rerun: string): Promise<GhEnvToken & { look: GithubLoginLook }> {
  const found = ghTokensInEnv();
  const first = found[0];
  if (first === undefined) throw noEnvTokenError();
  if (!process.stdin.isTTY) {
    if (found.length > 1) {
      logger.info(
        scannable({
          headline: `Taking $${first.name} (the most specific).`,
          evidence: [`${found.length} of ${ghTokenEnvVarsLabel(", ")} are set`],
          lead: "Then:",
          actions: [[`${rerun} --provider gh-env`, "pick another in a terminal"]],
        }),
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
    const use = await prompt(`Use ${row(only)}?`, {
      type: "confirm",
      initial: true,
      cancel: "undefined",
    });
    if (use !== true) throw new Error("cancelled");
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

async function loginWithGhEnv(rerun: string): Promise<string> {
  const chosen = await chooseEnvToken(rerun);
  logger.success(`  Using ${tokenLabel(`$${chosen.name}`, chosen.token, chosen.look)}.`);
  return chosen.token;
}

/** The settled slot, verified, then the success line: an auto slot names the account it follows
 *  right now whenever that is known (nothing hidden). `look` is a test seam; exported for the
 *  wording tests. `rerun` is the command that ran this acquisition, which the refusal's auto way
 *  out extends with `--gh-user auto`. */
export function loginWithGhCli(
  account: GhAccountSelection,
  look: (ghUser: string | null) => GhTokenLook = ghAuthTokenLook,
  rerun: string = agentAuthCommand(null),
): GhCliSlot {
  const slot = settleGhCliAccount(account, look, rerun);
  if (slot.kind === "pinned") {
    logger.success(
      scannable({
        headline: "Using the gh CLI login as the Direct credential.",
        evidence: [`pinned to account ${slot.ghUser}`],
      }),
    );
  } else {
    const evidence = slot.activeLogin === null ? [] : [`currently account ${slot.activeLogin}`];
    evidence.push("follows gh account switches");
    logger.success(
      scannable({ headline: "Using the gh CLI login on AUTO as the Direct credential.", evidence }),
    );
  }
  return slot;
}

/** Verified BEFORE recording, or a failed check would point `--get` at a `gh` that cannot produce
 *  a token; read-only, so a dry run runs it too. */
function settleGhCliAccount(
  account: GhAccountSelection,
  look: (ghUser: string | null) => GhTokenLook,
  rerun: string,
): GhCliSlot {
  switch (account.kind) {
    case "auto": {
      const gh = look(null);
      if (gh.kind !== "found") throw ghCliMiss(gh, rerun);
      return { kind: "auto", ghUser: null, activeLogin: account.activeLogin };
    }
    case "pinned":
      return pinGhCliAccount(account.login, look, rerun);
    default:
      return assertNever(account);
  }
}

/** The pin's own `--user` look is the only one asked. The plain call's token is whichever account
 *  gh has active, so a miss never consults it: a hosts.yml gh wrote before 2.40 (no `users:` map)
 *  and a gh older than 2.40 both refuse a login by name while serving the plain call, and the
 *  credential following that account would spend whatever account a later `gh auth login` makes
 *  active. */
function pinGhCliAccount(
  login: string,
  look: (ghUser: string | null) => GhTokenLook,
  rerun: string,
): Extract<GhCliSlot, { kind: "pinned" }> {
  const pinned = look(login);
  switch (pinned.kind) {
    case "found":
      return { kind: "pinned", ghUser: login };
    case "unproven":
      throw ghCliMiss(pinned, rerun);
    case "absent":
      throw ghCannotServeByName(login, pinned.detail, rerun);
    default:
      return assertNever(pinned);
  }
}

/** Color carries meaning: the login and each command the reader can run are cyan, nothing else.
 *  `rerun` is the command that ran this acquisition (a fresh profile's `add` has no slot for
 *  `auth` to address yet). `color` and `width` are the command edge's; exported with them for the
 *  wording test. */
export function ghCannotServeByName(
  login: string,
  detail: string,
  rerun: string,
  color = colorEnabled(),
  width: number | null = terminalWidth(process.stderr),
): Error {
  return new Error(
    scannable({
      headline: "gh cannot serve the pinned account by name.",
      evidence: [`account: ${paintFor(color).cyan(login)}`, detail],
      lead: "Pick one:",
      actions: [
        ["gh auth login", "re-login on gh 2.40 or newer, then retry"],
        [`${rerun} --gh-user ${GH_USER_AUTO}`, "follow gh's active account (switches with gh)"],
      ],
      color,
      width,
    }),
  );
}

/** An UNPROVEN look wears its own words: "not authenticated" and the `gh auth login` advice are
 *  wrong when gh was never asked. `rerun` is the command that ran this acquisition. */
function ghCliMiss(gh: Exclude<GhTokenLook, { kind: "found" }>, rerun: string): Error {
  switch (gh.kind) {
    case "unproven":
      return new Error(
        scannable({
          headline: "could not check gh authentication.",
          evidence: [gh.detail],
          lead: "Fix:",
          actions: [[rerun, "retry"]],
        }),
      );
    case "absent":
      return new Error(
        scannable({
          headline: "gh is not authenticated.",
          evidence: [gh.detail],
          lead: "Fix:",
          actions: [
            ["gh auth login", "log in"],
            [rerun, "then retry"],
          ],
        }),
      );
    default:
      return assertNever(gh);
  }
}

/** The flag's or the picker's choice as the selection the slot write settles. `--gh-user auto`
 *  reads gh's account listing once so the success line can name the account it follows now; a
 *  listing that cannot be read leaves it unnamed, since auto resolves without one. */
async function selectGhAccount(
  choice: GhCliAccountChoice,
  chooseAccount: () => Promise<GhAccountSelection>,
): Promise<GhAccountSelection> {
  switch (choice.kind) {
    case "choose":
      return chooseAccount();
    case "pinned":
      return choice;
    case "auto": {
      const listing = ghAccountsLook();
      return {
        kind: "auto",
        activeLogin: listing.kind === "listed" ? activeGhLogin(listing.accounts) : null,
      };
    }
    default:
      return assertNever(choice);
  }
}

/** Whether `credential` is a dry run's stand-in for a login that did not run (PLANNED_SECRET).
 *  Only inside a dry run: a real token spelled like the placeholder is a token. */
function isPlannedCredential(credential: ProvisionedCredential): boolean {
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
  rerun: string,
  look: (ghUser: string | null) => GhTokenLook,
  chooseAccount: () => Promise<GhAccountSelection>,
): Promise<ProvisionedCredential> {
  const slot =
    profile === null
      ? "the default profile's credential slot"
      : `${profileLabel(profile)}'s credential slot`;
  switch (acquisition.kind) {
    case "choose":
      throw new Error(
        scannable({
          headline: "a dry run never prompts.",
          evidence: [`no provider to plan ${slot} from`],
          lead: "Pick one:",
          actions: [
            [`--provider <${PROVIDER_CHOICES}>`, "plan that provider's landing"],
            ["--set <token>", "plan a gh-token landing"],
          ],
        }),
      );
    case "gh-token": {
      if (acquisition.token === null) {
        throw new Error(
          scannable({
            headline: "a dry run never prompts.",
            evidence: [`no token to plan ${slot} with`],
            lead: "Fix:",
            actions: [["--set <token>", "the token to land"]],
          }),
        );
      }
      // The login's own reading, refusal included, before any plan row is landed.
      const token = providedToken(acquisition.token);
      logger.log(
        scannable({
          headline: "Would store the given token.",
          evidence: [`in ${slot}`, "its GitHub account is looked up when the landing is real"],
        }),
      );
      return { kind: "stored", provider: "gh-token", token };
    }
    case "gh-env": {
      // The same environment read as the real command, refused the same way when nothing is set;
      // with several set, the headless rule (the most specific) rather than a prompt.
      const found = ghTokensInEnv();
      const first = found[0];
      if (first === undefined) throw noEnvTokenError();
      const evidence = found.length > 1 ? [`the most specific of ${found.length} set`] : [];
      evidence.push(`in ${slot}`, "its GitHub account is looked up when the landing is real");
      logger.log(scannable({ headline: `Would land the token from $${first.name}.`, evidence }));
      return { kind: "stored", provider: "gh-env", token: first.token };
    }
    case "copilot":
      logger.log(
        scannable({
          headline: "Would run GitHub's device flow and land the token.",
          evidence: [`in ${slot}`],
        }),
      );
      return { kind: "stored", provider: "copilot", token: PLANNED_SECRET };
    case "gh-cli": {
      // The real command's pin resolution, off gh's saved accounts (a read); the arm that would
      // prompt says to pass --gh-user instead.
      const account = await selectGhAccount(acquisition.account, chooseAccount);
      // The same read-only `gh auth token` looks, refused the same way (an env-only account has
      // no saved credential to pin).
      const settled = settleGhCliAccount(account, look, rerun);
      logger.log(
        scannable({
          headline: "Would record the gh CLI login.",
          evidence: [
            settled.kind === "auto"
              ? "on AUTO: gh's active account"
              : `pinned to account ${settled.ghUser}`,
            `in ${slot}`,
          ],
        }),
      );
      return { kind: "gh-cli", ghUser: settled.ghUser };
    }
    default:
      return assertNever(acquisition);
  }
}

/** Never persists: the caller owns the single store write (`authenticate` into an existing slot,
 *  whose mode `agent profile <name> add` recorded first). `profile` names the slot a dry run's
 *  narration speaks of. `options.rerun` is the command that ran this acquisition when it is not
 *  the profile's `auth` (a fresh profile's `add --auto`); `look` and `chooseAccount` are test
 *  substitutes for the gh lookups. */
export async function acquireCredential(
  acquisition: CredentialAcquisition,
  profile: Profile = null,
  options: {
    rerun?: string;
    look?: (ghUser: string | null) => GhTokenLook;
    chooseAccount?: () => Promise<GhAccountSelection>;
  } = {},
): Promise<ProvisionedCredential> {
  const rerun = options.rerun ?? agentAuthCommand(profile);
  // What runs this acquisition again as asked: `auth` must name the provider once more, since a
  // bare `auth` on a stored credential is idempotent; `add --auto` picks it and takes no --provider.
  const retry = options.rerun ?? `${rerun} --provider gh-cli`;
  if (dryRunActive()) {
    return plannedAcquisition(
      acquisition,
      profile,
      rerun,
      options.look ?? ghAuthTokenLook,
      options.chooseAccount ?? (() => chooseGhAccount(retry, undefined, "dry-run")),
    );
  }
  const resolved =
    acquisition.kind === "choose"
      ? acquisitionForProvider(await chooseProvider(agentAuthCommand(profile)))
      : acquisition;
  if (resolved.kind === "gh-token") {
    return { kind: "stored", provider: "gh-token", token: await loginWithGhToken(resolved.token) };
  }
  if (resolved.kind === "gh-env") {
    return { kind: "stored", provider: "gh-env", token: await loginWithGhEnv(rerun) };
  }
  if (resolved.kind === "copilot") {
    return { kind: "stored", provider: "copilot", token: await loginWithCopilot() };
  }
  const look = options.look ?? ghAuthTokenLook;
  const account = await selectGhAccount(
    resolved.account,
    options.chooseAccount ?? (() => chooseGhAccount(retry)),
  );
  return { kind: "gh-cli", ghUser: loginWithGhCli(account, look, rerun).ghUser };
}

/** A named profile's slot must already exist (`agent profile <name> add` is the only creator), and the
 *  gate fires BEFORE the acquisition so a typo'd name never costs a device flow. A complete Direct
 *  profile is rebaked here with a fresh selection: the credential write took the previous
 *  credential's stored pair with it, and every re-render bakes the slot's pair, so the landing is
 *  where the new one is probed and stored. */
async function authenticate(
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
          scannable({
            headline: "Would wire both agents for the landed token.",
            evidence: [
              `${profileLabel(profile)} in ${slot.mode} mode${
                slot.mode === "direct" ? ", the Direct identity selected with it" : ""
              }`,
            ],
          }),
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
 *  nonexistent name can only be created by `agent profile <name> add`, and the store's own
 *  refusal (missingProfileSlotError) words that hint. */
function profileSlotMissing(profile: ProfileName): boolean {
  return !new CopilotEnvState().profileSlotStatus(profile).exists;
}

function resolveOrReport(profile: Profile): string | null {
  const { token, reason } = new Credential(undefined, profile).resolveWithReason();
  if (token === null) {
    logger.error(
      profile !== null && profileSlotMissing(profile)
        ? errMessage(missingProfileSlotError(profile))
        : reason,
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
  // The default's wording is an output contract; a named profile's names its slot and its daemon.
  const forSlot = profile === null ? [] : [`for ${profileLabel(profile)}`];
  const its = profile === null ? "the" : "its";
  const again = agentAuthCommand(profile);
  return () => {
    if (stop !== null) {
      const { signalled, stopped } = stop;
      // `stopped` first: a stop REFUSED (unprovable pid, nothing signalled) must report the
      // still-running daemon, never the plain success.
      if (!stopped) {
        logger.warn(
          scannable({
            headline: "De-authenticated.",
            evidence: [
              ...forSlot,
              `${its} proxy is still running`,
              "it may keep serving the old credential",
            ],
            lead: "Fix:",
            actions: [[agentStopCommand(profile), "stop it"]],
          }),
        );
      } else {
        const evidence = [...forSlot];
        if (signalled) evidence.push(`stopped ${its} proxy`);
        logger.success(
          scannable({
            headline: "De-authenticated.",
            evidence,
            lead: "Then:",
            actions: [[again, "log in again"]],
          }),
        );
      }
    } else if (profile !== null && profileSlotMissing(profile)) {
      logger.info(errMessage(missingProfileSlotError(profile, ["nothing to clear"])));
    } else {
      logger.info(
        scannable({
          headline: "Nothing to clear.",
          evidence: [...forSlot, "not authenticated"],
          lead: "Then:",
          actions: [[again, "log in"]],
        }),
      );
    }
    // Whatever the store held, a baked copy may still sit in the agent configs.
    noteStaticKeyStale(profile);
  };
}

async function runCheck(profile: Profile): Promise<void> {
  // The exit code is the machine contract; the status line goes to stdout like its peers `agent
  // profile check --codex|--claude` and names the account (a label: a missed look never changes
  // the exit code). The default output has no profile flag or label.
  const credential = new Credential(undefined, profile);
  const { provider, resolves } = credential.status();
  const authCommand = agentAuthCommand(profile);
  const forSlot = profile === null ? [] : [`for ${profileLabel(profile)}`];
  // The status goes to stdout, so the table fits stdout's width, not stderr's.
  const width = terminalWidth();
  if (provider === null) {
    if (profile !== null && profileSlotMissing(profile)) {
      printWrapped(errMessage(missingProfileSlotError(profile)));
    } else {
      printWrapped(
        scannable({
          headline: "not authenticated.",
          evidence: forSlot,
          lead: "Fix:",
          actions: [[authCommand, "log in"]],
          width,
        }),
      );
    }
    process.exitCode = 1;
    return;
  }
  const source = (await accountSourceLabel(credential.read())) ?? provider;
  if (resolves) {
    printWrapped(scannable({ headline: "authenticated.", evidence: [...forSlot, source], width }));
    process.exitCode = 0;
  } else {
    // e.g. gh-cli selected but `gh` is no longer authenticated (as the pinned account).
    printWrapped(
      scannable({
        headline: "no credential resolves.",
        evidence: [...forSlot, `provider '${source}' is selected`],
        lead: "Fix:",
        actions: [[authCommand, "log in again"]],
        width,
      }),
    );
    process.exitCode = 1;
  }
}

/** Throws if acquisition fails, so `agent init` (and every wiring command) errors out rather than
 *  proceed unauthenticated; `agent start` never asks, it refuses (readLaunchToken). `acquisition`
 *  is what `add`'s flags carry; bare, the provider is chosen interactively. A dry run never logs
 *  in: a bare step is refused, and one the flags settle runs the same read-only checks and plans
 *  the landing on the caller's overlay. */
export async function ensureAuthenticated(
  profile: Profile = null,
  acquisition: CredentialAcquisition = { kind: "choose" },
): Promise<void> {
  if (new Credential(undefined, profile).isAuthenticated()) return;
  if (dryRunActive() && acquisition.kind === "choose") {
    const authCommand = agentAuthCommand(profile);
    throw new Error(
      scannable({
        headline: "a dry run never logs in.",
        evidence: [`${profileLabel(profile)} is not authenticated`],
        lead: "Fix:",
        actions: [[authCommand, "log in first, then re-run with --dry-run"]],
      }),
    );
  }
  if (!dryRunActive()) logger.log(loggingInLine(profile));
  await authenticate(acquisition, profile);
}

/** The line before an interactive login runs: indented like the add's other step narrations it
 *  prints among. Shared with `agent profile <name> add --auto`, whose login runs the same way. */
export function loggingInLine(profile: Profile): string {
  return scannable({
    headline: "  Not authenticated yet - let's log in to GitHub Copilot.",
    evidence: profile === null ? [] : [`  for ${profileLabel(profile)}`],
  });
}

/** `choose` is the bare flag: the interactive pick, in a terminal (src/commands/identity.ts). */
type IdentityRequest = IdentityChoice | { kind: "choose" };

type AuthAction =
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

function parseAuthAction(args: AuthArgs): AuthAction {
  const subActions = [
    args.get,
    args.del,
    args.check,
    args.identities,
    args.identity !== undefined,
  ].filter(Boolean).length;
  if (subActions > 1) {
    throw new Error("--get, --del, and --check are mutually exclusive");
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
    const choice: IdentityRequest =
      args.identity === true ? { kind: "choose" } : parseIdentityChoice(String(args.identity));
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
      await runCheck(action.profile);
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
        const { profile } = action;
        throw new Error(
          scannable({
            headline: "no terminal to choose the identity in.",
            lead: "Pick one:",
            actions: [
              [configSetCommand("identity", "<id|auto>", profile), "pin an id, or auto"],
              [
                profile === null ? "agent profile identity" : `agent profile ${profile} identity`,
                "show the current identity",
              ],
            ],
          }),
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
      // Names the account like every landing does; the look is a label, never a gate.
      const source = (await accountSourceLabel(credential.read())) ?? provider;
      return () => {
        const auth = agentAuthCommand(profile);
        logger.success(
          scannable({
            headline: "Already authenticated.",
            evidence: profile === null ? [source] : [`for ${profileLabel(profile)}`, source],
            lead: "Pick one:",
            actions: [
              [`${auth} --provider <${PROVIDER_CHOICES}>`, "switch the provider"],
              [`${auth} --del`, "clear it"],
            ],
          }),
        );
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
        scannable({
          headline: `Authenticated (${provider}).`,
          lead: "Then:",
          actions: [["agent init", "configure Codex and Claude"]],
        }),
      );
    } else if (mode !== null) {
      logger.success(
        scannable({
          headline: `Authenticated (${provider}).`,
          evidence: [`for ${profileLabel(profile)}`, `both agents are wired for its ${mode} mode`],
          lead: "Then:",
          actions: [
            [`cl --profile ${profile}`, "launch Claude"],
            [`cx --profile ${profile}`, "launch Codex"],
          ],
        }),
      );
    } else {
      logger.success(
        scannable({
          headline: `Authenticated (${provider}).`,
          evidence: [`for ${profileLabel(profile)}`],
          lead: "Then:",
          actions: [[`agent profile ${profile} add --direct|--proxy`, "wire it into both agents"]],
        }),
      );
    }
    if (mode === null) noteStaticKeyStale(profile);
  };
}

/** A baked value (static-key) never follows the store, so only the rewire brings it up to date. */
function noteStaticKeyStale(profile: Profile): void {
  const scope = new CopilotEnvConfig().staticKeyScope(profile);
  if (scope === "none") return;
  const whose =
    scope === "all" ? "Claude's and Codex's" : scope === "claude" ? "Claude's" : "Codex's";
  const rewire = profile === null ? "agent init" : `agent profile ${profile} add --direct|--proxy`;
  logger.info(
    scannable({
      headline: `static-key is ${scope}.`,
      evidence: [`${whose} baked value stays as it is`],
      lead: "Fix:",
      actions: [[rewire, "rewrites it"]],
    }),
  );
}
