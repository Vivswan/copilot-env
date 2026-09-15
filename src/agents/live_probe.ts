// The live "does Copilot Direct work for THIS credential?" probe behind `agent codex` /
// `agent claude` auto-detect. Not every account or token may use Direct, so rather than guess it
// writes a throwaway direct config into a temp home and runs the agent CLI's own read-only smoke
// prompt against it; exit 0 means Direct works. The command boundary ensured a credential is
// stored before this runs, and the temp config resolves it the way the real wiring will.
//
//   CLI present -> smoke prompt (retried) -> Direct, else the local proxy
//   CLI absent  -> the caller's endpoint smoke (src/copilot_api/endpoint_smoke.ts), else the proxy
//
//   a provider env var in the shell        -> dropped, so a leaked export cannot hijack auth
//   a failure past DEFAULT_PROBE_RETRIES   -> the proxy
//   a FAILED attempt near PROBE_TIMEOUT_MS -> no further retry; a slow SUCCESS still wins
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { settingsPathFor } from "../claude/paths.ts";
import type { EndpointSmokeOutcome } from "../copilot_api/endpoint_smoke.ts";
import type { ProbeFetch } from "../copilot_api/integration_identity.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { childEnvWithPath, cliSpawn, type CommandLook, findCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { sleepSync } from "../utils/time.ts";
import { removeScratchDir, type ScratchDir, scratchDir } from "../utils/report_write.ts";

// Narration goes to stderr, never stdout: the machine-readable `--check` / `env` paths must
// stay clean.
const logger = createStderrLogger();

/** The trivial read-only prompt both CLIs run for the smoke test. */
export const PROBE_PROMPT = "Reply with the single word OK.";

/** A live model call can be slow; cap it and treat a timeout as "direct failed". */
export const PROBE_TIMEOUT_MS = 60_000;

/** Retry the live smoke call this many times before concluding Direct fails. */
export const DEFAULT_PROBE_RETRIES = 3;

/** Base backoff before each retry (multiplied by the attempt index: 600ms, 1200ms). */
export const DEFAULT_PROBE_RETRY_DELAY_MS = 600;

/** A FAILED attempt that ran this close to the timeout was a hang, not a blip: retrying would
 *  burn another PROBE_TIMEOUT_MS. The blips worth retrying (fast 4xx/5xx) return well under
 *  this, and a slow SUCCESS never reaches the check. */
const TIMEOUT_RETRY_FRACTION = 0.9;

/** Shared by the temp-home detect below and the health `--live` probe (src/health/probe.ts)
 *  so the exact smoke command never drifts between them. */
export interface ProbeDescriptor {
  cli: string;
  homeEnvVar: string;
  /** `home` is the config dir the probe points the CLI at (the temp dir for detect, the real
   *  home for health); `profile` selects a named profile's wiring through the same knob each
   *  launcher uses (null = the default argv). The per-CLI notes below say how. */
  args: (prompt: string, home: string, profile?: Profile) => string[];
}

/** Stripped from the probe child so a stray export (an api key, an org, a base url, a config
 *  override) cannot steer the test away from the throwaway config.
 *
 *    OPENAI_ / ANTHROPIC_ / CODEX_ / CLAUDE_ -> dropped; the home var is re-set AFTER the clear
 *    GH_ / GITHUB_                           -> kept: a gh-cli credential still resolves through gh
 *
 *  The health probe (src/health/probe.ts) strips none of these; it tests the real environment,
 *  dropping only ANTHROPIC_BASE_URL for a named profile (claudeLiveOmitEnv). */
export const PROVIDER_ENV_PREFIXES = ["OPENAI_", "ANTHROPIC_", "CODEX_", "CLAUDE_"];

export const CODEX_PROBE: ProbeDescriptor = {
  cli: "codex",
  homeEnvVar: "CODEX_HOME",
  // --skip-git-repo-check: the throwaway home has no `[projects]` trust list, so without it
  // codex refuses unless the cwd happens to be a git repo, and Direct detection would depend on
  // where `agent init` was invoked:
  //   "Not inside a trusted directory and --skip-git-repo-check was not specified."
  // A named profile rides `--profile <name>`, the flag the `cx --profile` launcher passes.
  args: (prompt, _home, profile = null) => [
    "exec",
    ...(profile === null ? [] : ["--profile", profile]),
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    prompt,
  ],
};

export const CLAUDE_PROBE: ProbeDescriptor = {
  cli: "claude",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  // --bare forces auth through the apiKeyHelper alone (no OAuth, no keychain), so a Claude
  // subscription login cannot make Direct look available when the managed path is broken.
  //
  //   --bare               -> also stops settings.json discovery from CLAUDE_CONFIG_DIR
  //   --settings <path>    -> the only auth path left; without it apiKeySource is "none"
  //   settings-<name>.json -> a named profile's own file, the one `cl --profile` loads
  args: (prompt, home, profile = null) => [
    "--bare",
    "--settings",
    settingsPathFor(home, profile),
    "--print",
    "--permission-mode",
    "plan",
    "--verbose",
    "--output-format",
    "stream-json",
    prompt,
  ],
};

/** `detail` is the one-line failure reason lifted from the child's output, so a fallback to
 *  the proxy is never silent. */
export interface ProbeOutcome {
  ok: boolean;
  detail?: string;
}

/** Injectable I/O so unit tests decide the probe outcome without real model calls. */
export interface DirectProbeDeps {
  /** Look for a CLI binary on PATH / via nvm, failure arm kept (see CommandLook). */
  findCommand?: (cmd: string) => CommandLook;
  /** Run the agent CLI's read-only smoke prompt at its RESOLVED path (ok = exit 0). */
  runProbe?: (cliPath: string, args: string[], env: Record<string, string>) => ProbeOutcome;
  /** Extra live-call retries on failure (default DEFAULT_PROBE_RETRIES). */
  retries?: number;
  /** Base backoff ms between retries (default DEFAULT_PROBE_RETRY_DELAY_MS; 0 in tests). */
  retryDelayMs?: number;
  /** Threaded by detect* into the endpoint smoke (src/copilot_api/endpoint_smoke.ts), never read
   *  here, so its tests fetch nothing real. */
  fetchImpl?: ProbeFetch;
}

/** Codex's model-catalog dump in probe output is noise, never the failure reason. Both failure
 *  formatters (summarizeProbeFailure here, formatLiveFailure in src/health/probe.ts) filter
 *  through this one regex. */
export const CODEX_CATALOG_NOISE_RE = /"capabilities"|"object":\s*"model"|model_picker/;

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
  // Scanned from the end of stderr-then-stdout: the last marker line in stdout wins, else the
  // last in stderr; within one stream that is the marker nearest the child's death.
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
  // A non-timeout spawn error (ENOENT, ENOBUFS) carries the real reason when the output did not.
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
  // `env` is the COMPLETE child environment probeDirectWorks built; re-merging process.env here
  // would bring the cleared provider vars back.
  //
  //   stdout/stderr piped -> a failure carries a reason (summarizeProbeFailure)
  //   maxBuffer 16 MB     -> codex prints tens of KB of model catalog, and the 1 MB default sets
  //                          result.error (ENOBUFS) on a probe that exited 0
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
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

/** The RESOLVED CLI path is threaded to the spawn, or findCommand's nvm fallback is defeated by
 *  a bare PATH-only command name. gh is looked up only to lead the child PATH: a gh-cli
 *  credential's helper spawns it from inside the temp home, while a stored token needs no gh.
 *
 *  `endpointSmoke` is the caller's CLI-less Direct check, consulted ONLY when no CLI ran (missing
 *  or uncheckable); a CLI that ran and failed is the final verdict, since an endpoint that answers
 *  cannot prove the CLI's own auth path. Null (no credential resolved) keeps the plain proxy fall.
 *
 *   any failure from tmp home -> caught, false, and the caller wires the proxy
 *   temp-home removal fails   -> best effort; removeScratchDir reports the path left behind
 */
export async function probeDirectWorks(
  descriptor: ProbeDescriptor,
  writeDirectConfig: (tmpHome: string) => void,
  endpointSmoke: (() => Promise<EndpointSmokeOutcome>) | null,
  deps: DirectProbeDeps = {},
): Promise<boolean> {
  const find = deps.findCommand ?? findCommand;
  const runProbe = deps.runProbe ?? defaultRunProbe;
  const retries = deps.retries ?? DEFAULT_PROBE_RETRIES;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_PROBE_RETRY_DELAY_MS;

  logger.log(`  Probing GitHub Copilot Direct for ${descriptor.cli} ...`);

  // A FAILED look never borrows the proven verdict's words: "not found" carries advice that is
  // wrong when the look itself failed, so that arm says "could not check" and gives no install
  // advice.
  const cliLook = find(descriptor.cli);
  if (cliLook.path === null) {
    const look = cliLook.launchFailed
      ? `could not check for the ${descriptor.cli} CLI (the command probe failed to run)`
      : `${descriptor.cli} CLI not found`;
    if (endpointSmoke === null) {
      const advice = cliLook.launchFailed
        ? ""
        : " (install it with `agent shell --clis` and re-run to auto-detect Direct, or pass --direct)";
      logger.log(`    • ${look} → using the local proxy${advice}`);
      return false;
    }
    logger.log(`    • ${look} → asking the Copilot endpoint itself (1-token call) ...`);
    const outcome = await endpointSmoke();
    if (outcome.ok) {
      logger.success(
        `    GitHub Copilot Direct is available (endpoint check; no ${descriptor.cli} CLI ran)`,
      );
      return true;
    }
    logger.log(
      `    • the endpoint check did not succeed (${outcome.detail}) → using the local proxy`,
    );
    return false;
  }
  const cliPath = cliLook.path;
  const ghPath = find("gh").path;
  logger.log(
    `    • running a read-only smoke prompt through ${descriptor.cli} (live model call, a few seconds; pass --direct to skip) ...`,
  );

  let tmpHome: ScratchDir | null = null;
  try {
    tmpHome = scratchDir(join(tmpdir(), `copilot-env-${descriptor.cli}-`));
    writeDirectConfig(tmpHome);
    // Provider families stripped (why: PROVIDER_ENV_PREFIXES); the resolved CLI's and gh's bin
    // dirs lead PATH so an nvm-only toolchain resolves (why: childEnvWithPath).
    const childEnv = childEnvWithPath(
      [dirname(cliPath), ghPath === null ? null : dirname(ghPath)],
      {
        extra: { [descriptor.homeEnvVar]: tmpHome },
        omit: (upper) => PROVIDER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)),
      },
    );

    const args = descriptor.args(PROBE_PROMPT, tmpHome);
    let lastDetail: string | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        logger.log(
          `    • smoke prompt failed${lastDetail ? ` (${lastDetail})` : ""}; retrying (attempt ${
            attempt + 1
          } of ${retries + 1}) ...`,
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
      `    • the Direct smoke prompt did not succeed${
        lastDetail ? ` (${lastDetail})` : ""
      } → using the local proxy`,
    );
    return false;
  } catch (e) {
    logger.log(`    • the Direct probe errored (${errMessage(e)}) → using the local proxy`);
    return false;
  } finally {
    if (tmpHome !== null) {
      try {
        removeScratchDir(tmpHome);
      } catch {
        // best-effort cleanup
      }
    }
  }
}
