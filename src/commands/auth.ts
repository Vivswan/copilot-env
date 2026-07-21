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
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { resolveCopilotApiEntry } from "../copilot_api/process.ts";
import { assertProfileName, type Profile, profileLabel } from "../copilot_api/profile.ts";
import { GH_TOKEN_ENV_VARS, ghTokenFromEnv, tokenFromSetFlag } from "../utils/direct_probe.ts";
import { errMessage } from "../utils/error.ts";
import { releaseFileLock, tryAcquireFileLock } from "../utils/file_lock.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { sleepSync } from "../utils/time.ts";
import { stopTrackedProxy } from "./stop.ts";

// Narration to stderr so `--get`'s stdout stays a clean machine-readable token.
const logger = createStderrLogger();

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

/** Interactive provider picker for bare `agent auth`. Errors out without a TTY. */
async function chooseProvider(): Promise<AuthProvider> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "not a terminal — pass --provider copilot|gh-cli|gh-token (e.g. `agent auth --provider gh-token`)",
    );
  }
  const value = await consola.prompt("How should GitHub Copilot authenticate?", {
    type: "select",
    options: [
      { label: "copilot — device-flow browser login (read:user scope)", value: "copilot" },
      { label: "gh-cli — use the machine's `gh auth login`", value: "gh-cli" },
      {
        label: "gh-token — store $COPILOT_GITHUB_TOKEN / $GH_TOKEN / $GITHUB_TOKEN (headless)",
        value: "gh-token",
      },
    ],
    cancel: "reject",
  });
  return asProvider(String(value));
}

// --- provider acquisition ---------------------------------------------------

/**
 * `copilot`: run the INSTALLED/floated copilot-api's device-flow login (not
 * `npx @latest`, which would bypass the supply-chain cooldown + the float). It
 * writes its own github_token file; copy that into our single-source store and
 * scrub copilot-api's copy. Interactive: inherits stdio so the device-code URL
 * and prompt are shown.
 *
 * The WHOLE spawn+read+scrub sequence holds a lock on the shared github_token
 * file: every profile's device flow funnels through that ONE file, so two
 * concurrent logins (default + a profile, or two profiles) could otherwise read
 * each other's token into the wrong slot. Dead-holder-only reclaim (Infinity):
 * an interactive login legitimately holds it for minutes.
 */
function loginWithCopilot(cred: Credential): void {
  let entry: string;
  try {
    entry = resolveCopilotApiEntry();
  } catch (e) {
    throw new Error(
      `cannot run the device-flow login — copilot-api is not installed (${errMessage(e)}). ` +
        "Re-run the agent launcher to install dependencies, or use `agent auth --provider gh-token`.",
    );
  }
  const tokenFile = new CopilotApiPaths().githubTokenFile;
  const lockPath = `${tokenFile}.login.lock`;
  let noticed = false;
  while (!tryAcquireFileLock(lockPath, Number.POSITIVE_INFINITY)) {
    if (!noticed) {
      logger.info("Another device-flow login is in progress; waiting for it to finish ...");
      noticed = true;
    }
    sleepSync(500);
  }
  try {
    const result = spawnSync(process.execPath, [entry, "auth", "login", "--provider", "copilot"], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env },
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `device-flow login failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`,
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
    cred.store("copilot", token);
    // Scrub copilot-api's copy so the token rests only in our state (the proxy
    // receives it via `--github-token` from there, so this file is redundant).
    try {
      rmSync(tokenFile, { force: true });
    } catch {
      // best-effort
    }
  } finally {
    releaseFileLock(lockPath);
  }
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
      `no GitHub token found: pass \`--set <token>\` or set one of ${GH_TOKEN_ENV_VARS.join(" / ")}`,
    );
  }
  const token = (await readSecret("Paste your Copilot-enabled GitHub token: ")).trim();
  if (token === "") throw new Error("the provided GitHub token is empty");
  return token;
}

/**
 * `gh-token`: store a token.
 *   - `--set <token>` : the value verbatim (no UI / no env).
 *   - `--set` (bare)  : read $COPILOT_GITHUB_TOKEN/$GH_TOKEN/$GITHUB_TOKEN, error if none set (headless).
 *   - no `--set`      : prefer those env vars, else prompt for it in a TTY.
 */
async function loginWithGhToken(
  cred: Credential,
  setValue: string | boolean | undefined,
): Promise<void> {
  let token: string;
  let fromEnv = true;
  if (setValue === undefined) {
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
    // setValue is non-undefined here, so tokenFromSetFlag only returns null for the
    // literal `false` (which a boolean flag never produces) -- prove it rather than cast.
    const setToken = tokenFromSetFlag(setValue);
    if (setToken === null) throw new Error("`--set` requires a token value");
    token = setToken;
    fromEnv = typeof setValue !== "string";
  }
  cred.store("gh-token", token);
  logger.success(
    fromEnv
      ? "  Stored the GitHub token from the environment."
      : "  Stored the provided GitHub token.",
  );
}

/** `gh-cli`: rely on the machine's gh login (store nothing, verify gh works). */
function loginWithGhCli(cred: Credential): void {
  // Verify gh works BEFORE recording -- otherwise a failed gh check would point
  // `--get` at a `gh` that can't produce a token.
  if (ghAuthToken() === null) {
    throw new Error("gh is not authenticated — run `gh auth login`, then retry `agent auth`");
  }
  cred.useGhCli();
  logger.success("  Using the gh CLI login as the Direct credential.");
}

/**
 * Authenticate: pick the provider (explicit `--provider`, else interactive
 * choice), acquire + record the credential into `profile`'s slot. `setValue` is
 * the `--set [token]` value for gh-token (verbatim string, or true/undefined =>
 * env). Does NOT configure the agents -- that is `agent init` / `agent profile`'s
 * job (`agent profile --add` reuses this to attach a profile's own credential).
 * Throws on failure.
 */
export async function authenticate(
  providerArg: string | undefined,
  setValue: string | boolean | undefined,
  profile: Profile,
): Promise<AuthProvider> {
  const provider = providerArg !== undefined ? asProvider(providerArg) : await chooseProvider();
  const cred = new Credential(undefined, profile);
  if (provider === "copilot") {
    loginWithCopilot(cred);
  } else if (provider === "gh-token") {
    await loginWithGhToken(cred, setValue);
  } else {
    loginWithGhCli(cred);
  }
  return provider;
}

// --- sub-actions ------------------------------------------------------------

async function runGet(profile: Profile, catalogDeps?: CodexCatalogDeps): Promise<void> {
  const token = new Credential(undefined, profile).resolve();
  if (token === null) {
    logger.error(
      profile === null
        ? "no GitHub credential — run `agent auth` to log in"
        : `no GitHub credential for ${profileLabel(profile)} — run \`agent auth --profile ${profile}\` ` +
            "to log in (a named profile never falls back to the default credential)",
    );
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
 * proxy-mode resolver (`src/scripts/proxy-token.sh`) runs this last, after it has
 * ensured the proxy is up. Distinct from `--get` (the upstream GitHub credential).
 * `--profile` reads the key from that profile daemon's own config.json. The key
 * line is the ENTIRE stdout contract; after printing it this also runs the same
 * best-effort daily model-catalog refresh as `--get` (stderr-only, never throws,
 * default profile only), sourced from the running proxy's /models.
 */
async function runPrintProxyToken(profile: Profile, catalogDeps?: CodexCatalogDeps): Promise<void> {
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
    const { signalled, stopped } = await stopTrackedProxy(2000, profile);
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
        `De-authenticated ${profileLabel(profile)} and stopped its proxy. Run ${again} to log in again.`,
      );
    } else {
      logger.warn(
        `De-authenticated ${profileLabel(profile)}, but its proxy is still running and may keep ` +
          `serving the old credential -- stop it with \`agent stop --profile ${profile}\`.`,
      );
    }
  } else if (profile === null) {
    logger.info("Nothing to clear — not authenticated. Run `agent auth` to log in.");
  } else {
    logger.info(
      `Nothing to clear for ${profileLabel(profile)} — not authenticated. Run ` +
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
    console.log(`not authenticated${label} — run \`agent auth${flag}\``);
    process.exitCode = 1;
  } else if (resolves) {
    console.log(`authenticated (${provider})${label}`);
    process.exitCode = 0;
  } else {
    // e.g. gh-cli selected but `gh` is no longer authenticated.
    console.log(
      `provider '${provider}' selected but no credential resolves${label} — run \`agent auth${flag}\``,
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
  for (const name of Object.keys(state.read().profiles).sort()) {
    const cred = new Credential(state, name);
    rows.push([name, describe(cred.provider(), cred.isAuthenticated())]);
  }
  const width = rows.reduce((m, [name]) => Math.max(m, name.length), 0);
  for (const [name, detail] of rows) {
    console.log(`${name.padEnd(width)}  ${detail}`);
  }
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
      ? "  Not authenticated yet — let's log in to GitHub Copilot."
      : `  ${profileLabel(profile)} is not authenticated yet — let's log in to GitHub Copilot.`,
  );
  await authenticate(undefined, undefined, profile);
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
    runList();
    return;
  }
  const profile: Profile = args.profile ?? null;
  if (profile !== null) assertProfileName(profile);
  if (args.printProxyToken) {
    await runPrintProxyToken(profile, catalogDeps);
    return;
  }
  if (args.get) {
    await runGet(profile, catalogDeps);
    return;
  }
  if (args.del) {
    await runDel(profile);
    return;
  }
  if (args.check) {
    runCheck(profile);
    return;
  }

  // `--set` is the non-interactive gh-token path: it implies `--provider gh-token`
  // (and rejects a conflicting provider). Bare `agent auth` (no --provider, no --set)
  // is idempotent only when the recorded provider STILL RESOLVES: if so, report it
  // and how to change it; otherwise run the auth flow (prompt) -- covering both "no
  // provider yet" and "provider chosen but broken (e.g. gh-cli after gh logout)".
  // `gh` is never silently used without the `gh-cli` choice, and `agent auth --del`
  // clears the provider so the next run starts fresh. An explicit `--provider` always runs.
  if (args.set !== undefined) {
    if (args.provider !== undefined && asProvider(args.provider) !== "gh-token") {
      throw new Error("--set only applies to `--provider gh-token`");
    }
  } else if (args.provider === undefined) {
    const { provider, resolves } = new Credential(undefined, profile).status();
    if (provider !== null && resolves) {
      if (profile === null) {
        // The default wording is an output contract -- keep it byte-identical.
        logger.success(
          `Already authenticated (${provider}). Switch with ` +
            "`agent auth --provider <copilot|gh-cli|gh-token>`, or clear it with `agent auth --del`.",
        );
      } else {
        logger.success(
          `Already authenticated (${provider}, ${profileLabel(profile)}). Switch with ` +
            `\`agent auth --profile ${profile} --provider <copilot|gh-cli|gh-token>\`, or clear it ` +
            `with \`agent auth --profile ${profile} --del\`.`,
        );
      }
      return;
    }
  }

  const provider = await authenticate(
    args.set !== undefined ? "gh-token" : args.provider,
    args.set,
    profile,
  );
  logger.success(
    profile === null
      ? `Authenticated (${provider}). Run \`agent init\` to configure Codex and Claude.`
      : `Authenticated ${profileLabel(profile)} (${provider}). Wire it into both agents with ` +
          `\`agent profile --add ${profile} --direct|--proxy\`.`,
  );
}
