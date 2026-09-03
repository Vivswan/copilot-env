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
import { readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { consola } from "consola";
import { type CodexCatalogDeps, refreshCodexModelCatalogIfStale } from "../codex/catalog.ts";
import { syncCodexCatalogReference } from "../codex/config.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import {
  AUTH_PROVIDERS,
  type AuthProvider,
  Credential,
  ghAuthToken,
} from "../copilot_api/credential.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import {
  assertProfileSlot,
  CopilotEnvState,
  type ProvisionedCredential,
} from "../copilot_api/env_state.ts";
import {
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

/** A credential acquisition with the provider already settled (interactively or by flag). */
type ResolvedAcquisition =
  | { kind: "provider"; provider: Exclude<AuthProvider, "gh-token"> }
  | { kind: "gh-token"; source: GhTokenSource };

/**
 * How to acquire a credential, parsed ONCE from the raw `--provider`/`--set` flag pair by
 * `parseAcquisition` (the shared boundary for `agent auth` and `agent profile --add`).
 * A `--set` token can only ever travel inside the gh-token variant, so `authenticate`
 * cannot receive one under a non-gh-token provider and silently drop it.
 */
export type CredentialAcquisition = { kind: "choose" } | ResolvedAcquisition;

/** Map a settled provider name onto its acquisition: gh-token logs in via the
 *  env-else-prompt token flow; copilot/gh-cli carry the provider itself. */
function acquisitionForProvider(provider: AuthProvider): ResolvedAcquisition {
  return provider === "gh-token"
    ? { kind: "gh-token", source: { kind: "env-or-prompt" } }
    : { kind: "provider", provider };
}

/**
 * Parse the raw `--provider [name]` / `--set [token]` flag pair into a
 * CredentialAcquisition -- the ONE place the "--set implies gh-token (and rejects a
 * conflicting provider)" rule lives, shared by `agent auth` and `agent profile --add`.
 *
 * The two commands intentionally differ on which error wins for `--set x --provider
 * bogus`: `agent auth` validates the provider name first (so an unknown name gets the
 * "--provider must be one of" error), while `agent profile --add` treats ANY non-gh-token
 * string as the --set conflict (`setConflictWins`). Both keep their exact messages.
 */
export function parseAcquisition(
  provider: string | undefined,
  set: string | boolean | undefined,
  opts: { setConflictWins?: boolean } = {},
): CredentialAcquisition {
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

// --- provider acquisition ---------------------------------------------------

/**
 * `copilot`: run the INSTALLED/floated copilot-api's device-flow login (not
 * `npx @latest`, which would bypass the supply-chain cooldown + the float). It
 * writes its own github_token file; return that token for the caller's single
 * store write and scrub copilot-api's copy. Interactive: inherits stdio so the
 * device-code URL and prompt are shown.
 *
 * The WHOLE spawn+read+scrub sequence holds a lock on the shared github_token
 * file: every profile's device flow funnels through that ONE file, so two
 * concurrent logins (default + a profile, or two profiles) could otherwise read
 * each other's token into the wrong slot. Dead-holder-only reclaim (Infinity):
 * an interactive login legitimately holds it for minutes.
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
      rmSync(tokenFile, { force: true });
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

/** `gh-cli`: rely on the machine's gh login (store nothing, verify gh works). */
function loginWithGhCli(): void {
  // Verify gh works BEFORE recording -- otherwise a failed gh check would point
  // `--get` at a `gh` that can't produce a token.
  if (ghAuthToken() === null) {
    throw new Error("gh is not authenticated - run `gh auth login`, then retry `agent auth`");
  }
  logger.success("  Using the gh CLI login as the Direct credential.");
}

/**
 * Acquire a credential WITHOUT persisting it: settle the provider (a parsed
 * acquisition, or the interactive choice for `choose`) and run its flow. The
 * caller owns the single store write -- `authenticate` records it into an
 * existing slot, `agent profile --add` commits it atomically together with the
 * profile's mode. Throws on failure.
 */
export async function acquireCredential(
  acquisition: CredentialAcquisition,
): Promise<ProvisionedCredential> {
  const resolved = acquisition.kind === "choose"
    ? acquisitionForProvider(await chooseProvider())
    : acquisition;
  if (resolved.kind === "gh-token") {
    return { kind: "stored", provider: "gh-token", token: await loginWithGhToken(resolved.source) };
  }
  if (resolved.provider === "copilot") {
    return { kind: "stored", provider: "copilot", token: loginWithCopilot() };
  }
  loginWithGhCli();
  return { kind: "gh-cli" };
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
  await refreshCodexModelCatalogIfStale("direct", { directToken: token, ...catalogDeps });
  // Keep the managed config in step with the opt-in catalog preference on EVERY
  // auth call (one cheap TOML read), not just after a regeneration: enabled, it
  // self-heals a config whose wiring-time seed failed (e.g. a catalog generated
  // during mobile pairing -- provider stripped => the add is skipped -- must get
  // referenced on the next call after pairing restores the provider, without
  // waiting out the daily refresh throttle); disabled, it removes the catalog
  // artifacts -- Codex re-runs auth every 300s, so a disable lands within minutes.
  syncCodexCatalogReference();
}

/**
 * `--print-proxy-token`: print the local copilot-api proxy's API key on stdout. The
 * proxy-mode resolver (`agent proxy-token`) runs this last, after it has ensured the
 * proxy is up. Distinct from `--get` (the upstream GitHub credential). `--profile`
 * reads the key from that profile daemon's own config.json. The key line is the
 * ENTIRE stdout contract; after printing it this also runs the same best-effort
 * daily model-catalog refresh as `--get` (stderr-only, never throws, default
 * profile only), sourced from the running proxy's /models. Exported because it IS
 * the resolver's print-key primitive -- `agent proxy-token` must come through here,
 * not bare ensureApiKey, or the catalog freshness hook silently dies.
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
  await refreshCodexModelCatalogIfStale("proxy", catalogDeps);
  syncCodexCatalogReference();
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
      // The default wording is an output contract -- keep it byte-identical.
      if (!signalled) {
        logger.success("De-authenticated. Run `agent auth` to log in again.");
      } else if (stopped) {
        logger.success("De-authenticated and stopped the proxy. Run `agent auth` to log in again.");
      } else {
        logger.warn(
          "De-authenticated, but the proxy is still running and may keep serving the old " +
            "credential -- stop it with `agent stop`.",
        );
      }
      return;
    }
    const again = `\`agent auth --profile ${profile}\``;
    if (!signalled) {
      logger.success(`De-authenticated ${profileLabel(profile)}. Run ${again} to log in again.`);
    } else if (stopped) {
      logger.success(
        `De-authenticated ${
          profileLabel(profile)
        } and stopped its proxy. Run ${again} to log in again.`,
      );
    } else {
      logger.warn(
        `De-authenticated ${profileLabel(profile)}, but its proxy is still running and may keep ` +
          `serving the old credential -- stop it with \`agent stop --profile ${profile}\`.`,
      );
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

function runCheck(profile: Profile): void {
  // The exit code is the machine contract; the status line is a human convenience
  // printed to stdout (the one stdout exception besides `--get`, like its peers
  // `agent codex/claude --check`). Default output stays byte-identical (flag/label
  // are empty strings there).
  const { provider, resolves } = new Credential(undefined, profile).status();
  const flag = profile === null ? "" : ` --profile ${profile}`;
  const label = profile === null ? "" : ` (${profileLabel(profile)})`;
  if (provider === null) {
    if (profile !== null && profileSlotMissing(profile)) {
      console.log(noSuchProfileHint(profile));
    } else {
      console.log(`not authenticated${label} - run \`agent auth${flag}\``);
    }
    process.exitCode = 1;
  } else if (resolves) {
    console.log(`authenticated (${provider})${label}`);
    process.exitCode = 0;
  } else {
    // e.g. gh-cli selected but `gh` is no longer authenticated.
    console.log(
      `provider '${provider}' selected but no credential resolves${label} - run \`agent auth${flag}\``,
    );
    process.exitCode = 1;
  }
}

/** `--list`: the default + every named credential profile, providers only (never tokens). */
function runList(): void {
  const state = new CopilotEnvState();
  const rows: Array<[string, string]> = [];
  const describe = (provider: string | null, resolves: boolean): string =>
    provider === null ? "not authenticated" : `${provider}${resolves ? "" : " (does not resolve)"}`;
  const defaultCred = new Credential(state);
  rows.push(["default", describe(defaultCred.provider(), defaultCred.isAuthenticated())]);
  for (const name of state.profileNames()) {
    const cred = new Credential(state, name);
    rows.push([name, describe(cred.provider(), cred.isAuthenticated())]);
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
    return { kind: "list" };
  }
  // Profile-name validation stays ahead of the provider conflict, so an invalid
  // name keeps reporting itself even when a stray --provider rides along.
  const profile: Profile = parseProfileFlag(args.profile);
  if (args.provider !== undefined && subActions > 0) throw providerConflictError();
  if (args.printProxyToken) return { kind: "print-proxy-token", profile };
  if (args.get) return { kind: "get", profile };
  if (args.del) return { kind: "del", profile };
  if (args.check) return { kind: "check", profile };
  return { kind: "authenticate", profile, acquisition: parseAcquisition(args.provider, args.set) };
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
 * The authenticate arm: `--set` is the non-interactive gh-token path
 * (parseAcquisition made it imply `--provider gh-token` and rejected a
 * conflicting provider). Bare `agent auth` (no --provider, no --set) is
 * idempotent only when the recorded provider STILL RESOLVES: if so, report it
 * and how to change it; otherwise run the auth flow (prompt) -- covering both
 * "no provider yet" and "provider chosen but broken (e.g. gh-cli after gh
 * logout)". `gh` is never silently used without the `gh-cli` choice, and
 * `agent auth --del` clears the provider so the next run starts fresh. An
 * explicit `--provider` always runs.
 */
async function runAuthenticate(
  profile: Profile,
  acquisition: CredentialAcquisition,
): Promise<void> {
  if (acquisition.kind === "choose") {
    const { provider, resolves } = new Credential(undefined, profile).status();
    if (provider !== null && resolves) {
      if (profile === null) {
        // The default wording is an output contract -- keep it byte-identical.
        logger.success(
          `Already authenticated (${provider}). Switch with ` +
            `\`agent auth --provider <${PROVIDER_CHOICES}>\`, or clear it with \`agent auth --del\`.`,
        );
      } else {
        logger.success(
          `Already authenticated (${provider}, ${profileLabel(profile)}). Switch with ` +
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
