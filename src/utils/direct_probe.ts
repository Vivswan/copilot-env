// Live "does GitHub Copilot Direct actually work?" probe, shared by `agent codex`
// / `agent claude` (the auto-detect path) and `agent shell --clis`. Direct mode
// resolves its credential via `agent auth --get` (provider-driven: gh-cli -> `gh
// auth token`, copilot/gh-token -> the stored token; no implicit gh fallback), so a
// machine with no credential -- or where Copilot Direct rejects the request -- must
// fall back to the local proxy. Rather than guess, we
// WRITE a throwaway direct config into a temp
// home and run the agent CLI's own read-only smoke prompt against it; exit 0 means
// direct works. Cheap gates (CLI present, gh authenticated) run first so the
// common "no gh auth" case -- e.g. CI -- returns instantly without a model call. Two
// guards keep the live test honest: the child env is SANITIZED (the provider env
// families are dropped) so a leaked shell export can't hijack auth, and the
// single live call is RETRIED so a transient blip doesn't silently flip a working
// Direct setup to proxy.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertNever } from "./assert.ts";
import { childEnvWithPath, cliSpawn, resolveCommand } from "./command.ts";
import { errMessage } from "./error.ts";
import { createStderrLogger } from "./logger.ts";
import type { RequestedMode } from "./provider_mode.ts";
import { sleepSync } from "./time.ts";

// Probe progress goes to stderr (consola), never stdout: the `--check`/`env`
// machine-readable paths never probe, so this narration can't pollute them.
const logger = createStderrLogger();

/** The trivial read-only prompt both CLIs run for the smoke test. */
export const PROBE_PROMPT = "Reply with the single word OK.";

/** A live model call can be slow; cap it and treat a timeout as "direct failed". */
export const PROBE_TIMEOUT_MS = 60_000;

/** Retry the live smoke call this many times before concluding Direct fails. */
export const DEFAULT_PROBE_RETRIES = 3;

/** Base backoff before each retry (multiplied by the attempt index: 600ms, 1200ms). */
export const DEFAULT_PROBE_RETRY_DELAY_MS = 600;

/**
 * A failed attempt that ran for ~this fraction of the timeout was a hang/outage,
 * not a transient blip -- retrying would just burn another PROBE_TIMEOUT_MS, so we
 * stop and fall back immediately. Fast 4xx/5xx blips (the case worth retrying)
 * return well under this.
 */
const TIMEOUT_RETRY_FRACTION = 0.9;

/**
 * How to drive one agent CLI's read-only smoke test: the binary, the env var that
 * points it at a config home, and the argv for a given prompt. Shared by the
 * temp-config detect below and the live health probe (src/health/probe.ts) so the
 * exact command never drifts between them.
 */
export interface ProbeDescriptor {
  cli: string;
  homeEnvVar: string;
  /**
   * Build the smoke-test argv for `prompt`, given the config `home` the probe
   * points the CLI at (the temp dir for detect, the real home for the health
   * probe). Codex auto-loads `$CODEX_HOME/config.toml` and ignores `home`, but
   * Claude's `--bare` disables settings.json auto-discovery, so it must pass
   * `--settings <home>/settings.json` to load its managed apiKeyHelper.
   */
  args: (prompt: string, home: string) => string[];
}

/**
 * Env-var PREFIXES whose every variable is stripped from the probe child, for
 * BOTH agent CLIs: a stray `OPENAI_*`, `ANTHROPIC_*`, `CODEX_*`, or `CLAUDE_*`
 * export (an api key, an org, a base url, an auth token, a config override) must
 * not steer the "does Direct work?" test away from the throwaway temp config. The
 * probe re-sets its own home var (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`) to the temp
 * dir AFTER this clear, so stripping those families here is safe. `GH_*`/`GITHUB_*`
 * are NOT here on purpose -- Direct mints its token via `gh auth token`, so they
 * must survive. The health probe (src/health/probe.ts) deliberately does NOT clear
 * any of this: it tests the user's real, fully-resolved environment.
 */
export const PROVIDER_ENV_PREFIXES = ["OPENAI_", "ANTHROPIC_", "CODEX_", "CLAUDE_"];

export const CODEX_PROBE: ProbeDescriptor = {
  cli: "codex",
  homeEnvVar: "CODEX_HOME",
  // --skip-git-repo-check: the probe runs against a throwaway home with no
  // `[projects]` trust list, so without this codex refuses to run unless the cwd
  // happens to be a git repo ("Not inside a trusted directory and
  // --skip-git-repo-check was not specified.") -- making Direct detection fail
  // purely based on where `agent init` was invoked.
  args: (prompt) => ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", prompt],
};

export const CLAUDE_PROBE: ProbeDescriptor = {
  cli: "claude",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  // --bare forces auth STRICTLY through the apiKeyHelper (OAuth and keychain are
  // never read) so a user's Claude subscription login can't make Direct look
  // available when the managed credential path is actually broken -- but it also disables
  // settings.json auto-discovery from CLAUDE_CONFIG_DIR, so the managed
  // apiKeyHelper is only honored when handed in via --settings. Without it the
  // probe has NO auth path and always fails (apiKeySource "none"). The default
  // settings filename is spelled here (not via claude/config.ts settingsPathFor)
  // because claude/config imports this module -- routing through it would cycle.
  args: (prompt, home) => [
    "--bare",
    "--settings",
    join(home, "settings.json"),
    "--print",
    "--permission-mode",
    "plan",
    "--verbose",
    "--output-format",
    "stream-json",
    prompt,
  ],
};

/**
 * The result of one live smoke call: `ok` is exit 0, and on failure `detail` is a
 * concise, single-line reason (an HTTP status, an auth rejection, a timeout, a
 * stream disconnect, or the raw exit) lifted from the child's stderr/stdout -- so
 * a fallback to the proxy is never silent.
 */
export interface ProbeOutcome {
  ok: boolean;
  detail?: string;
}

/** Injectable I/O so unit tests decide the probe outcome without real model calls. */
export interface DirectProbeDeps {
  /** Resolve a CLI binary on PATH / via nvm (null = not installed). */
  resolveCommand?: (cmd: string) => string | null;
  /** True when `gh auth token` succeeds -- given gh's RESOLVED path (nvm-safe). */
  ghAuthOk?: (ghPath: string) => boolean;
  /** Run the agent CLI's read-only smoke prompt at its RESOLVED path (ok = exit 0). */
  runProbe?: (cliPath: string, args: string[], env: Record<string, string>) => ProbeOutcome;
  /** Extra live-call retries on failure (default DEFAULT_PROBE_RETRIES). */
  retries?: number;
  /** Base backoff ms between retries (default DEFAULT_PROBE_RETRY_DELAY_MS; 0 in tests). */
  retryDelayMs?: number;
}

/**
 * Env var names checked (in order, most specific first) for a `gh-token` value, so
 * the secret stays out of argv / shell history. COPILOT_GITHUB_TOKEN is the
 * Copilot-specific name; GH_TOKEN / GITHUB_TOKEN are the gh CLI's conventional vars.
 */
export const GH_TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * GH_TOKEN_ENV_VARS as a `$VAR` fragment for help text and prompt labels, in
 * resolver order, so user-facing docs can never drift from what ghTokenFromEnv
 * actually reads (and in which precedence).
 */
export function ghTokenEnvVarsLabel(separator = "/"): string {
  return GH_TOKEN_ENV_VARS.map((name) => `$${name}`).join(separator);
}

/** GH_TOKEN_ENV_VARS as bare names for error messages ("COPILOT_GITHUB_TOKEN / GH_TOKEN / ..."),
 *  same resolver order as the label. */
export function ghTokenEnvVarsList(): string {
  return GH_TOKEN_ENV_VARS.join(" / ");
}

/** First non-empty (trimmed) token among GH_TOKEN_ENV_VARS, or null when none is set. */
export function ghTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of GH_TOKEN_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Resolve a GitHub token from `agent auth --provider gh-token`: a bare request
 * (`true`) reads the GH_TOKEN_ENV_VARS in order, so the secret stays out of argv /
 * shell history; a string value is used verbatim (trimmed); `undefined`/`false`
 * => `null` (not requested). Throws when a token was requested but none resolved.
 * The narrow overload proves that a definite request (string | true) always yields
 * a token or throws -- callers holding one never handle a null.
 */
export function tokenFromSetFlag(flag: string | true): string;
export function tokenFromSetFlag(flag: string | boolean | undefined): string | null;
export function tokenFromSetFlag(flag: string | boolean | undefined): string | null {
  // undefined/false = not requested (false should never come from a boolean flag,
  // but treat it as absence rather than the literal token "false").
  if (flag === undefined || flag === false) return null;
  if (flag === true) {
    const fromEnv = ghTokenFromEnv();
    if (fromEnv) return fromEnv;
    throw new Error(`no GitHub token found: set one of ${ghTokenEnvVarsList()}`);
  }
  const token = flag.trim();
  if (token === "") throw new Error("the provided GitHub token is empty");
  return token;
}

/**
 * Decide whether to write DIRECT (true) or PROXY (false), honoring a provisioned
 * token (the shared store's githubToken): "proxy" => proxy, "direct" => direct,
 * and on "auto" a present token selects Direct (we already hold a credential, so
 * no probe is needed) while no token falls back to the live `detectDirect` probe.
 * Total over RequestedMode -- the contradictory flag pair cannot reach here (it is
 * rejected once, at the CLI boundary parse).
 */
export function resolveDirectMode(
  mode: RequestedMode,
  ghToken: string | null,
  detectDirect: () => boolean,
): boolean {
  switch (mode) {
    case "proxy":
      return false;
    case "direct":
      return true;
    case "auto":
      return ghToken !== null || detectDirect();
    default:
      return assertNever(mode);
  }
}

/** Cap on one `gh auth token` call, shared by every "is gh authenticated?" probe. */
export const GH_AUTH_TIMEOUT_MS = 5000;

/**
 * The ONE recipe for probing gh's login: spawn `gh auth token` at gh's RESOLVED
 * path (not the bare name), with gh's bin dir on PATH, so an nvm-only gh (or a
 * node-shim gh) found via the nvm fallback is runnable; cliSpawn routes through
 * cmd.exe on Windows so a .cmd/.exe shim is launchable. Success = exit 0. Shared
 * by the token capture (copilot_api/credential.ts), the detect gate below, and
 * the health probe (health/probe.ts), so the command and its GH_AUTH_TIMEOUT_MS
 * budget never drift between them. Callers pick their own stdio (capture the
 * token vs. keep it out of process memory).
 */
export function ghAuthTokenSpawnSpec(ghPath: string): {
  file: string;
  args: string[];
  shell: boolean;
  timeout: number;
  env: Record<string, string>;
} {
  const s = cliSpawn(ghPath, ["auth", "token"]);
  return { ...s, timeout: GH_AUTH_TIMEOUT_MS, env: childEnvWithPath([dirname(ghPath)]) };
}

function defaultGhAuthOk(ghPath: string): boolean {
  const s = ghAuthTokenSpawnSpec(ghPath);
  const result = spawnSync(s.file, s.args, {
    stdio: "ignore",
    timeout: s.timeout,
    windowsHide: true,
    shell: s.shell,
    env: s.env,
  });
  return !result.error && result.status === 0;
}

/**
 * Recognizes codex's giant model-catalog dump in probe output (noise, never the
 * failure reason). The ONE filter both probe failure formatters apply --
 * summarizeProbeFailure below and formatLiveFailure in src/health/probe.ts -- so
 * a catalog format change upstream is accommodated in one place.
 */
export const CODEX_CATALOG_NOISE_RE = /"capabilities"|"object":\s*"model"|model_picker/;

/** Collapse a probe child's output to one concise, human-readable failure reason. */
export function summarizeProbeFailure(
  status: number | null,
  signal: string | null,
  errorMessage: string | undefined,
  stdout: string,
  stderr: string,
): string {
  // A spawn-level error (notably the spawnSync timeout kill) trumps any output.
  if (errorMessage && /ETIMEDOUT|timed?\s?out/i.test(errorMessage)) {
    return `timed out after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`;
  }
  // Scan stderr (tracing/errors) and the JSON stdout stream -- newest line first --
  // for the most informative failure marker: an HTTP 4xx/5xx, an auth rejection,
  // a stream disconnect, or the "waiting on stdin" hang. Skip codex's giant model
  // catalog lines so they can't drown out the real reason.
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !CODEX_CATALOG_NOISE_RE.test(l));
  const MARKER =
    /\b(error|unauthor|forbidden|denied|invalid|expired|panic|disconnect|refused|quota|rate.?limit|[45]\d\d|stdin)\b/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && MARKER.test(line)) return truncateReason(line);
  }
  // No recognizable marker. A non-timeout spawn error (ENOENT, ENOBUFS, ...) carries
  // the real reason when the output didn't, so prefer it; else report the raw exit
  // plus a hint of the last line.
  if (errorMessage) return truncateReason(errorMessage);
  const last = lines[lines.length - 1];
  const tail = last ? ` - last output: ${truncateReason(last)}` : "";
  if (signal) return `killed by ${signal}${tail}`;
  return `exit ${status ?? "?"}${tail}`;
}

/** One-line, length-bounded reason string (codex error bodies can be huge). */
function truncateReason(line: string): string {
  const MAX = 200;
  return line.length > MAX ? `${line.slice(0, MAX)}...` : line;
}

function defaultRunProbe(
  cliPath: string,
  args: string[],
  env: Record<string, string>,
): ProbeOutcome {
  const s = cliSpawn(cliPath, args);
  // `env` is the COMPLETE child environment (process.env minus the provider env
  // families, plus the temp home + PATH) -- built by probeDirectWorks.
  // Spawn with it verbatim; do NOT re-merge process.env or the cleared vars return.
  // Capture stdout/stderr (not stdio:"ignore") so a failure carries a real reason
  // instead of silently flipping the user to the proxy. A generous maxBuffer keeps
  // a working Direct from being misread as failed: codex prints a large (~tens of
  // KB) model catalog, and the default 1 MB cap would set result.error (ENOBUFS) --
  // failing the probe even on exit 0. 16 MB is far above any real probe output.
  const result = spawnSync(s.file, s.args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    shell: s.shell,
    env,
  });
  if (!result.error && result.status === 0) return { ok: true };
  return {
    ok: false,
    detail: summarizeProbeFailure(
      result.status,
      result.signal,
      result.error?.message,
      result.stdout ?? "",
      result.stderr ?? "",
    ),
  };
}

/**
 * Decide whether GitHub Copilot Direct works for an agent CLI. The CLI must be
 * installed, `gh` must be installed and authenticated, and a throwaway read-only
 * prompt against a temp direct config must exit 0. Any miss => false (the caller
 * configures proxy instead). Never throws; always removes the temp home. The gh
 * and agent-CLI RESOLVED paths are threaded to the spawns so the nvm fallback in
 * resolveCommand isn't defeated by spawning a bare (PATH-only) command name.
 */
export function probeDirectWorks(
  descriptor: ProbeDescriptor,
  writeDirectConfig: (tmpHome: string) => void,
  deps: DirectProbeDeps = {},
): boolean {
  const resolve = deps.resolveCommand ?? resolveCommand;
  const ghAuthOk = deps.ghAuthOk ?? defaultGhAuthOk;
  const runProbe = deps.runProbe ?? defaultRunProbe;
  const retries = deps.retries ?? DEFAULT_PROBE_RETRIES;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_PROBE_RETRY_DELAY_MS;

  logger.log(`  Probing GitHub Copilot Direct for ${descriptor.cli} ...`);

  const cliPath = resolve(descriptor.cli);
  if (cliPath === null) {
    logger.log(`    • ${descriptor.cli} CLI not found → using the local proxy`);
    return false;
  }
  const ghPath = resolve("gh");
  if (ghPath === null) {
    logger.log("    • GitHub CLI (gh) not found → using the local proxy");
    return false;
  }
  logger.log("    • checking gh authentication ...");
  if (!ghAuthOk(ghPath)) {
    logger.log("    • gh is not authenticated (run `gh auth login`) → using the local proxy");
    return false;
  }
  logger.log(
    `    • running a read-only smoke prompt through ${descriptor.cli} (live model call, a few seconds) ...`,
  );

  let tmpHome: string | null = null;
  try {
    tmpHome = mkdtempSync(join(tmpdir(), `copilot-env-${descriptor.cli}-`));
    writeDirectConfig(tmpHome);
    // Sanitized COMPLETE child env: provider families stripped case-insensitively
    // (why: see PROVIDER_ENV_PREFIXES), temp home set, and the resolved CLI's and
    // gh's bin dirs put first on PATH (why: see childEnvWithPath/childPathPrepending).
    const childEnv = childEnvWithPath([dirname(cliPath), dirname(ghPath)], {
      extra: { [descriptor.homeEnvVar]: tmpHome },
      omit: (upper) => PROVIDER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)),
    });

    // The smoke call is a single live model call, so a transient blip (a fast
    // 4xx/5xx, a momentary network hiccup) must not silently downgrade a working
    // Direct setup to proxy. Retry on failure -- but a near-timeout failure is a
    // hang/outage, not a blip, so stop rather than burn another PROBE_TIMEOUT_MS.
    const args = descriptor.args(PROBE_PROMPT, tmpHome);
    let lastDetail: string | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        logger.log(
          `    • smoke prompt failed${lastDetail ? ` (${lastDetail})` : ""}; retrying (attempt ${attempt + 1} of ${retries + 1}) ...`,
        );
        sleepSync(retryDelayMs * attempt);
      }
      const startedAt = Date.now();
      const outcome = runProbe(cliPath, args, childEnv);
      if (outcome.ok) {
        logger.success("    GitHub Copilot Direct is available");
        return true;
      }
      lastDetail = outcome.detail;
      if (Date.now() - startedAt >= PROBE_TIMEOUT_MS * TIMEOUT_RETRY_FRACTION) break;
    }
    logger.log(
      `    • the Direct smoke prompt did not succeed${lastDetail ? ` (${lastDetail})` : ""} → using the local proxy`,
    );
    return false;
  } catch (e) {
    logger.log(`    • the Direct probe errored (${errMessage(e)}) → using the local proxy`);
    return false;
  } finally {
    if (tmpHome !== null) {
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
