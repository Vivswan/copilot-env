// The live "does Copilot Direct work for THIS credential?" probe behind `agent codex` /
// `agent claude` auto-detect. Not every account or token may use Direct, so rather than guess it
// writes a throwaway direct config into a temp home and runs the agent CLI's own read-only smoke
// prompt against it; exit 0 means Direct works. The command boundary ensured a credential is
// stored before this runs, and the temp config resolves it the way the real wiring will.
//
//   model hops   -> the smoke's models come from the agent's own alias, its pick over Copilot's
//                   /models, or the user's probe.*-model key (src/copilot_api/endpoint_smoke.ts),
//                   never from the model the CLI would choose on its own: a saved default the
//                   account cannot use must not decide the verdict
//   CLI present  -> smoke prompt pinned to the first hop (catalog-free for an alias); a MODEL
//                   rejection fetches the catalog and runs the second hop once, any other failure
//                   (auth, network, 5xx, timeout) stops -> Direct on a pass, else the local proxy
//                   with the last reason
//   CLI absent   -> one minimal call to the wire with the wire pick, else the proxy
//
//   a provider env var in the shell        -> dropped, so a leaked export cannot hijack auth
//   the caller's cwd                       -> replaced by the temp home, so a project's own
//                                             .claude/settings.json or codex trust never colours it
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { settingsPathFor } from "../claude/paths.ts";
import type { DirectSmoke } from "../copilot_api/endpoint_smoke.ts";
import type { ProbeFetch } from "../copilot_api/integration_identity.ts";
import { childEnvWithPath, cliSpawn, type CommandLook, findCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { removeScratchDir, type ScratchDir, scratchDir } from "../utils/fs_facade.ts";

// Narration goes to stderr, never stdout: the machine-readable `--check` / `env` paths must
// stay clean.
const logger = createStderrLogger();

/** The trivial read-only prompt both CLIs run for the smoke test. */
export const PROBE_PROMPT = "Reply with the single word OK.";

/** A live model call can be slow; cap it and treat a timeout as "direct failed". */
export const PROBE_TIMEOUT_MS = 60_000;

/** A failure that names the MODEL as what the endpoint would not serve: the one failure class the
 *  next model hop can answer. A 5xx is the endpoint's, whatever its body says, and auth, network,
 *  and timeout failures would fail every hop the same way; a rejection must name the model (its
 *  id, the word, or the claude CLI's "selected model") beside a 400/404 or a not-found,
 *  unknown, unsupported, or does-not-support phrasing. */
export function isModelRejection(detail: string | undefined, model: string): boolean {
  if (detail === undefined || /\b5\d\d\b/.test(detail)) return false;
  const namesModel = detail.includes(model) || /\bmodel\b/i.test(detail);
  const refused =
    /\b40[04]\b|not found|does not support|unknown|unrecognized|unsupported|may not exist/i
      .test(detail);
  return namesModel && refused;
}

/** The ISOLATED Direct-detect start, and only that: a throwaway home, auth forced through the
 *  managed config, the catalog's model pin. The health `--live` probe is the other intent, the
 *  user's real launch, and builds its own argv in src/health/live_launch.ts; an isolating flag
 *  added here must never be copied there. */
export interface ProbeDescriptor {
  cli: string;
  homeEnvVar: string;
  /** `home` is the temp config dir the probe points the CLI at; `model` pins the call to the
   *  catalog pick (null = the CLI's own choice). The per-CLI notes below say how. */
  args: (prompt: string, home: string, model: string | null) => string[];
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
  // `--model` beats the config's model line, so the pinned catalog pick is what runs.
  args: (prompt, _home, model) => [
    "exec",
    ...(model === null ? [] : ["--model", model]),
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
  //   --model <id>         -> beats the CLI's built-in default (claude-opus-5[1m] at 2.1.x), an id
  //                           Copilot may not serve; the init event then reports exactly this id
  args: (prompt, home, model) => [
    "--bare",
    "--settings",
    settingsPathFor(home),
    ...(model === null ? [] : ["--model", model]),
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
  /** Run the agent CLI's read-only smoke prompt at its RESOLVED path (ok = exit 0), with `cwd`
   *  the throwaway home the probe spawns from. */
  runProbe?: (
    cliPath: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
  ) => ProbeOutcome | Promise<ProbeOutcome>;
  /** Threaded by detect* into the Copilot smoke (src/copilot_api/endpoint_smoke.ts), never read
   *  here, so its tests fetch nothing real. */
  fetchImpl?: ProbeFetch;
}

/** Codex's model-catalog dump in probe output is noise, never the failure reason. Both failure
 *  formatters (summarizeProbeFailure here, formatLiveFailure in src/health/probe.ts) filter
 *  through this one regex. */
export const CODEX_CATALOG_NOISE_RE = /"capabilities"|"object":\s*"model"|model_picker/;

/** The failure text a JSON output line carries, or null for a non-JSON line and for a JSON event
 *  that reports no error. Claude's `--output-format json` / `stream-json` result event is ONE long
 *  line that opens with token counters and buries the reason in `result` (Copilot's error body
 *  when `is_error` is true), and a stream cut before the result event ends in the assistant
 *  event carrying that body as its text (`is_api_error_message`); codex's `turn.failed` carries
 *  `error.message`. A bare string `error` is a code (`"unknown"`, `"rate_limit"`), not the
 *  failure signal and never the reason. Both failure formatters read the line through this so
 *  the reason they print is the text, never the counters or the code. */
export function jsonOutputReason(line: string): string | null {
  if (!line.startsWith("{")) return null;
  const doc = parseJsonRecord(line);
  if (doc === null) return null;
  const failed = doc.is_error === true || isRecord(doc.error) ||
    doc.is_api_error_message === true;
  if (!failed) return null;
  const message = isRecord(doc.message) ? doc.message : null;
  const texts = Array.isArray(message?.content)
    ? message.content.map((part) => (isRecord(part) ? part.text : undefined))
    : [];
  const candidates = [
    doc.result,
    isRecord(doc.error) ? doc.error.message : undefined,
    doc.message,
    ...texts,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

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
  // last in stderr; within one stream that is the marker nearest the child's death. A JSON event
  // that reports an error is a marker by itself, and its reason text is what surfaces.
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !CODEX_CATALOG_NOISE_RE.test(l));
  const MARKER =
    /\b(error|unauthor|forbidden|denied|invalid|expired|panic|disconnect|refused|quota|rate.?limit|[45]\d\d|stdin)\b/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const reason = jsonOutputReason(line);
    if (reason !== null) return truncateReason(reason);
    if (MARKER.test(line)) return truncateReason(line);
  }
  // A non-timeout spawn error (ENOENT, ENOBUFS) carries the real reason when the output did not.
  if (errorMessage) return truncateReason(errorMessage);
  const last = lines[lines.length - 1];
  const tail = last ? ` - last output: ${truncateReason(last)}` : "";
  if (signal) return `killed by ${signal}${tail}`;
  return `exit ${status ?? "?"}${tail}`;
}

/** One-line, length-bounded reason string: a JSON-escaped newline in a result text would break
 *  the log line it is interpolated into, and codex error bodies can be huge. */
function truncateReason(line: string): string {
  const MAX = 200;
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > MAX ? `${flat.slice(0, MAX)}...` : flat;
}

function defaultRunProbe(
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<ProbeOutcome> {
  const s = cliSpawn(cliPath, args);
  // `env` is the COMPLETE child environment probeDirectWorks built, and it reaches the child only
  // through the async `spawn`: Deno's spawnSync (2.9.6, verified) merges the parent's variables
  // back in whatever `env` says, and a shell ANTHROPIC_BASE_URL at a running proxy then answers
  // the Claude smoke prompt for it. `cwd` is the throwaway home, never the caller's: both CLIs
  // read project-level config from the working directory.
  //
  //   stdout/stderr piped, utf8 -> a failure carries a reason (summarizeProbeFailure)
  //   close with a null code    -> our timeout when `killed`, so the detail says so
  return new Promise((resolveOutcome) => {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
    const child = spawn(s.file, s.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: s.shell,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (e) => {
      resolveOutcome({
        ok: false,
        detail: summarizeProbeFailure(null, null, errMessage(e), stdout, stderr),
      });
    });
    child.on("close", (code, signal) => {
      if (code === 0) return resolveOutcome({ ok: true });
      const timedOut = code === null && child.killed ? "timed out" : undefined;
      resolveOutcome({
        ok: false,
        detail: summarizeProbeFailure(code, signal, timedOut, stdout, stderr),
      });
    });
  });
}

/** POSIX `command -v` answers with a path that can be RELATIVE (dash, a relative or empty PATH
 *  entry), which the child could not follow once it has moved into the temp home; it is anchored to
 *  the caller's cwd here. Windows findCommand answers with the bare name, left for PATH to resolve. */
function anchorToCallerCwd(found: string): string {
  return process.platform === "win32" ? found : resolve(found);
}

/** The bin dir a found command contributes to the child PATH; a bare name has none. */
function binDir(found: string): string | null {
  const dir = dirname(found);
  return dir === "." ? null : dir;
}

/** The RESOLVED CLI path is threaded to the spawn, or findCommand's nvm fallback is defeated by
 *  a bare PATH-only command name. gh is looked up only to lead the child PATH: a gh-cli
 *  credential's helper spawns it from inside the temp home, while a stored token needs no gh.
 *
 *  `smoke` is the caller's credential bound to Copilot's own endpoint. Its catalog pick names the
 *  model for BOTH arms; its ping decides ONLY when no CLI ran, since a CLI that ran and failed is
 *  the final verdict (an endpoint that answers cannot prove the CLI's own auth path). Null (no
 *  credential) leaves nothing to smoke with, so it is the proxy. Any failure inside the temp home
 *  is caught as false; its removal is best effort (removeScratchDir reports a path left behind). */
export async function probeDirectWorks(
  descriptor: ProbeDescriptor,
  writeDirectConfig: (tmpHome: string) => void,
  smoke: DirectSmoke | null,
  deps: DirectProbeDeps = {},
): Promise<boolean> {
  const find = deps.findCommand ?? findCommand;
  const runProbe = deps.runProbe ?? defaultRunProbe;

  logger.log(`  Probing GitHub Copilot Direct for ${descriptor.cli} ...`);

  // A FAILED look never borrows the proven verdict's words: "not found" carries advice that is
  // wrong when the look itself failed, so that arm says "could not check" and gives no install
  // advice. A dry run takes the same arms: the plan is the real decision, and the CLI's auth
  // helper (this CLI, as a silent dry run) reads the credential the store already holds, since a
  // dry run never lands one it does not have.
  const cliLook = find(descriptor.cli);
  if (cliLook.path === null) {
    const look = cliLook.launchFailed
      ? `could not check for the ${descriptor.cli} CLI (the command probe failed to run)`
      : `${descriptor.cli} CLI not found`;
    if (smoke === null) {
      const advice = cliLook.launchFailed
        ? ""
        : " (install it with `agent shell --clis` and re-run to auto-detect Direct, or pass --direct)";
      logger.log(`    • ${look} → using the local proxy${advice}`);
      return false;
    }
    logger.log(`    • ${look} → asking the Copilot endpoint itself (one minimal model call) ...`);
    const picked = await smoke.pickModel();
    const outcome = picked.ok ? await smoke.ping(picked.model) : picked;
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
  if (smoke === null) {
    logger.log("    • no stored credential to smoke with → using the local proxy");
    return false;
  }
  const first = await smoke.cliModel();
  if (!first.ok) {
    logger.log(`    • ${first.detail} → using the local proxy`);
    return false;
  }
  const cliPath = anchorToCallerCwd(cliLook.path);
  const ghLook = find("gh").path;
  const ghPath = ghLook === null ? null : anchorToCallerCwd(ghLook);

  let tmpHome: ScratchDir | null = null;
  try {
    tmpHome = scratchDir(join(tmpdir(), `copilot-env-${descriptor.cli}-`));
    writeDirectConfig(tmpHome);
    const home: ScratchDir = tmpHome;
    // Provider families stripped (why: PROVIDER_ENV_PREFIXES); the resolved CLI's and gh's bin
    // dirs lead PATH so an nvm-only toolchain resolves (why: childEnvWithPath).
    const childEnv = childEnvWithPath(
      [binDir(cliPath), ghPath === null ? null : binDir(ghPath)],
      {
        extra: { [descriptor.homeEnvVar]: tmpHome },
        omit: (upper) => PROVIDER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)),
      },
    );

    const run = async (model: string): Promise<ProbeOutcome> => {
      logger.log(
        `    • running a read-only smoke prompt through ${descriptor.cli} with ${model} (live model call, a few seconds; pass --direct to skip) ...`,
      );
      const args = descriptor.args(PROBE_PROMPT, home, model);
      const outcome = await runProbe(cliPath, args, childEnv, home);
      if (outcome.ok) logger.success("    GitHub Copilot Direct is available");
      return outcome;
    };
    let outcome = await run(first.model);
    if (outcome.ok) return true;
    let lastDetail = outcome.detail;
    const next = isModelRejection(lastDetail, first.model) ? await smoke.cliFallbackModel() : null;
    if (next !== null && !next.ok) {
      logger.log(
        `    • ${descriptor.cli} could not run ${first.model} (${lastDetail}); ${next.detail}`,
      );
    } else if (next !== null) {
      logger.log(
        `    • ${descriptor.cli} could not run ${first.model} (${lastDetail}); trying ${next.model} ...`,
      );
      outcome = await run(next.model);
      if (outcome.ok) return true;
      lastDetail = outcome.detail;
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
