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
import { consola } from "consola";
import {
  AUTH_PROVIDERS,
  type AuthProvider,
  Credential,
  ghAuthToken,
} from "../copilot_api/credential.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { resolveCopilotApiEntry } from "../copilot_api/process.ts";
import { GH_TOKEN_ENV_VARS, ghTokenFromEnv, tokenFromSetFlag } from "../utils/direct_probe.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";

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
  const tokenFile = new CopilotApiPaths().githubTokenFile;
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
}

/**
 * Read a line from the terminal WITHOUT echoing it -- for pasting a secret token so
 * it never lingers on screen or in scrollback. consola's text prompt echoes input
 * and has no masked variant, so we drive readline directly and suppress its output
 * write (the canonical `_writeToOutput` hook: print the one-time query, swallow the
 * echoed keystrokes). Narration stays on stderr like the rest of this command, so
 * `--get`'s stdout contract is untouched.
 */
function readSecret(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let prompted = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {
      if (!prompted) {
        process.stderr.write(query);
        prompted = true;
      }
      // Swallow everything else (the echoed keystrokes / line re-renders).
    };
    rl.question(query, (answer) => {
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
    token = tokenFromSetFlag(setValue) as string;
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
 * choice), acquire + record the credential. `setValue` is the `--set [token]` value
 * for gh-token (verbatim string, or true/undefined => env). Does NOT configure the
 * agents -- that is `agent init`'s job. Throws on failure.
 */
async function authenticate(
  providerArg: string | undefined,
  setValue: string | boolean | undefined,
): Promise<AuthProvider> {
  const provider = providerArg !== undefined ? asProvider(providerArg) : await chooseProvider();
  const cred = new Credential();
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

function runGet(): void {
  const token = new Credential().resolve();
  if (token === null) {
    logger.error("no GitHub credential — run `agent auth` to log in");
    process.exitCode = 1;
    return;
  }
  // codeql[js/clear-text-logging] -- emitting the token on stdout IS this command's
  // contract (like `gh auth token`); the agent configs consume it.
  process.stdout.write(`${token}\n`);
}

function runDel(): void {
  if (new Credential().clear()) {
    logger.success("De-authenticated. Run `agent auth` to log in again.");
  } else {
    logger.info("Nothing to clear — not authenticated. Run `agent auth` to log in.");
  }
}

function runCheck(): void {
  // The exit code is the machine contract; the status line is a human convenience
  // printed to stdout (the one stdout exception besides `--get`, like its peers
  // `agent codex/claude --check`).
  const { provider, resolves } = new Credential().status();
  if (provider === null) {
    console.log("not authenticated — run `agent auth`");
    process.exitCode = 1;
  } else if (resolves) {
    console.log(`authenticated (${provider})`);
    process.exitCode = 0;
  } else {
    // e.g. gh-cli selected but `gh` is no longer authenticated.
    console.log(`provider '${provider}' selected but no credential resolves — run \`agent auth\``);
    process.exitCode = 1;
  }
}

/**
 * Ensure a credential exists WITHOUT configuring the agents -- used by `agent init`
 * and `agent start`. No-op when already authenticated; otherwise runs the auth flow
 * (interactive provider choice). Throws if acquisition fails, so callers error out
 * rather than proceeding unauthenticated.
 */
export async function ensureAuthenticated(): Promise<void> {
  if (new Credential().isAuthenticated()) return;
  logger.log("  Not authenticated yet — let's log in to GitHub Copilot.");
  await authenticate(undefined, undefined);
}

/**
 * `agent auth`: manage the GitHub credential ONLY (never configures agents).
 * `--get`/`--del`/`--check` are standalone, mutually exclusive sub-actions.
 * Otherwise it authenticates: bare (no `--provider`) is idempotent when a
 * credential already resolves and prompts for the provider when not; an explicit
 * `--provider` always runs (so it can switch the credential source). `--set [token]`
 * is the non-interactive gh-token path (provide the token inline, or via env).
 */
export async function runAuth(args: AuthArgs): Promise<void> {
  const subActions = [args.get, args.del, args.check].filter(Boolean).length;
  if (subActions > 1) {
    throw new Error("--get, --del, and --check are mutually exclusive");
  }
  if (args.set !== undefined && subActions > 0) {
    throw new Error("--set provisions a token and cannot combine with --get/--del/--check");
  }
  if (args.get) {
    runGet();
    return;
  }
  if (args.del) {
    runDel();
    return;
  }
  if (args.check) {
    runCheck();
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
    const { provider, resolves } = new Credential().status();
    if (provider !== null && resolves) {
      logger.success(
        `Already authenticated (${provider}). Switch with ` +
          "`agent auth --provider <copilot|gh-cli|gh-token>`, or clear it with `agent auth --del`.",
      );
      return;
    }
  }

  const provider = await authenticate(
    args.set !== undefined ? "gh-token" : args.provider,
    args.set,
  );
  logger.success(`Authenticated (${provider}). Run \`agent init\` to configure Codex and Claude.`);
}
