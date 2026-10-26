// The live "does Copilot Direct work for THIS credential?" probe behind `agent profile sync --codex` /
// `agent profile sync --claude` auto-detect. Not every account or token may use Direct, so rather than guess it
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
//   CLI too old  -> Copilot's "does not support this model; version X or newer is required" reply
//                   is no verdict: the probe throws CliTooOldError and the command exits 1 with the
//                   repair, nothing recorded or written
//
//   a provider env var in the shell        -> dropped, so a leaked export cannot hijack auth
//   the caller's cwd                       -> replaced by the temp home, so a project's own
//                                             .claude/settings.json or codex trust never colours it
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { deadline } from "@std/async/deadline";
import { settingsPathFor } from "../claude/paths.ts";
import type { DirectSmoke } from "../copilot_api/endpoint_smoke.ts";
import type { ProbeFetch } from "../copilot_api/integration_identity.ts";
import { type CommandLook, childEnv, findCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { removeScratchDir, type ScratchDir, scratchDir } from "../utils/fs_facade.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { caught } from "../utils/message.ts";
import { type CliCommand, classifyAgentCli } from "./cli_install.ts";

// Narration goes to stderr, never stdout: the machine-readable `--check` / `env` paths stay clean.
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
function isModelRejection(detail: string | undefined, model: string): boolean {
  if (detail === undefined || /\b5\d\d\b/.test(detail)) return false;
  const namesModel = detail.includes(model) || /\bmodel\b/i.test(detail);
  const refused =
    /\b40[04]\b|not found|does not support|unknown|unrecognized|unsupported|may not exist/i.test(
      detail,
    );
  return namesModel && refused;
}

/** The ISOLATED Direct-detect start, and only that: a throwaway home, auth forced through the
 *  managed config, the catalog's model pin. The health `--live` probe is the other intent, the
 *  user's real launch, and builds its own argv in src/health/live_launch.ts; an isolating flag
 *  added here must never be copied there. */
export interface ProbeDescriptor {
  /** Looked up on PATH, classified by classifyAgentCli, and named in narration and the refusal. */
  cli: CliCommand;

  /** Re-set to the throwaway home AFTER the provider-prefix clear, which otherwise drops it. */
  homeEnvVar: string;

  /** `home` is the temp config dir; `model` pins the catalog pick (null = the CLI's own choice). */
  args: (prompt: string, home: string, model: string | null) => string[];

  /** What the too-old refusal (CliTooOldError) tells the user to run. */
  updateCommand: string;
}

/** Stripped from the probe child: a stray export cannot steer the test off the throwaway config. */
const PROVIDER_ENV_PREFIXES = ["OPENAI_", "ANTHROPIC_", "CODEX_", "CLAUDE_"];

/** The Codex start: a read-only sandboxed `exec`, trusted outside any git repo. */
export const CODEX_PROBE: ProbeDescriptor = {
  cli: "codex",
  homeEnvVar: "CODEX_HOME",
  updateCommand: "agent shell --clis",
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

/** The Claude start: `--bare` auth through the apiKeyHelper alone, read as stream-json. */
export const CLAUDE_PROBE: ProbeDescriptor = {
  cli: "claude",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  updateCommand: "claude update",
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

/** Copilot's too-old reply, by shape: the versions around the fixed phrase, never a literal. */
const CLI_TOO_OLD_RE =
  /(\d+(?:\.\d+)+) does not support this model; version (\d+(?:\.\d+)+) or newer is required/i;

/** The one probe failure that is no verdict: an outdated CLI cannot judge Direct for the
 *  credential, and a fall to the proxy would hide the repair. The probe stops here, before any
 *  mode is recorded or any agent file is written, and the command exits 1 with this line. */
export class CliTooOldError extends Error {
  constructor(descriptor: ProbeDescriptor, installed: string, required: string) {
    super(
      `${descriptor.cli} is too old for Copilot Direct (${installed} installed, ${required} or ` +
        `newer required); run \`${descriptor.updateCommand}\`, then retry (or pass --direct / ` +
        "--proxy to skip the probe)",
    );
    this.name = "CliTooOldError";
  }
}

/** Throws CliTooOldError when `detail` carries Copilot's reply to a CLI older than the model needs
 *  ("Claude Code 2.1.181 does not support this model; version 2.1.251 or newer is required. Run
 *  'claude update' ..."); every other detail is the caller's to weigh (a model hop, or the proxy
 *  verdict). */
function refuseTooOldCli(descriptor: ProbeDescriptor, detail: string | undefined): void {
  const match = detail === undefined ? null : CLI_TOO_OLD_RE.exec(detail);
  if (match === null) return;
  const [, installed = "", required = ""] = match;
  throw new CliTooOldError(descriptor, installed, required);
}

/** `detail` is the one-line failure reason lifted from the child's output, so a fallback to
 *  the proxy is never silent. */
export interface ProbeOutcome {
  ok: boolean;
  detail?: string;
}

/** Injectable I/O so unit tests decide the probe outcome without real model calls. */
export interface DirectProbeDeps {
  /** The PATH lookup behind classifyAgentCli; a fake decides whether a CLI is present at all. */
  findCommand?: (cmd: string) => CommandLook;

  /** Runs the smoke prompt at the RESOLVED path (ok = exit 0); `cwd` is the throwaway home. */
  runProbe?: (
    cliPath: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
  ) => ProbeOutcome | Promise<ProbeOutcome>;

  /** Threaded to the Copilot smoke (endpoint_smoke.ts), never read here, so tests fetch nothing. */
  fetchImpl?: ProbeFetch;
}

/** Codex's model-catalog dump in probe output is noise, never the failure reason. */
export const CODEX_CATALOG_NOISE_RE = /"capabilities"|"object":\s*"model"|model_picker/;

/** The CLI's output as the lines a failure reason is read from: stderr then stdout, blank and
 *  catalog-noise lines dropped. Both failure formatters (summarizeProbeFailure here, health's
 *  formatLiveFailure in src/health/probe_deps.ts) read through this one pipeline. */
export function probeOutputLines(stdout: string, stderr: string): string[] {
  return `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !CODEX_CATALOG_NOISE_RE.test(l));
}

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
  const failed = doc.is_error === true || isRecord(doc.error) || doc.is_api_error_message === true;
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
  const lines = probeOutputLines(stdout, stderr).map((l) => l.trim());
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

export async function probeChildOutcome(child: ChildProcess): Promise<ProbeOutcome> {
  let stdout = "";
  let stderr = "";
  const drained = (stream: Readable | null, append: (chunk: string) => void): Promise<unknown> =>
    stream === null
      ? Promise.resolve()
      : once(
          stream.setEncoding("utf8").on("data", (chunk) => append(String(chunk))),
          "end",
        );
  // `exit` plus both stream ends, never `close`: bun on macOS can drop the child's close
  // notification (oven-sh/bun#41024), and a wait on close alone then holds the probe until the
  // spawn timeout kills a child that is already gone. The outer deadline is the same bound for
  // the arm where the exit itself is lost.
  const settled = Promise.all([
    once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
    drained(child.stdout, (chunk) => {
      stdout += chunk;
    }),
    drained(child.stderr, (chunk) => {
      stderr += chunk;
    }),
  ]).then(
    ([[code, signal]]): ProbeOutcome => {
      if (code === 0) return { ok: true };
      const timedOut = code === null && child.killed ? "timed out" : undefined;
      return { ok: false, detail: summarizeProbeFailure(code, signal, timedOut, stdout, stderr) };
    },
    (e: unknown): ProbeOutcome => ({
      ok: false,
      detail: summarizeProbeFailure(null, null, errMessage(e), stdout, stderr),
    }),
  );
  try {
    return await deadline(settled, PROBE_TIMEOUT_MS);
  } catch {
    child.unref();
    return { ok: false, detail: summarizeProbeFailure(null, null, "timed out", stdout, stderr) };
  }
}

function defaultRunProbe(
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<ProbeOutcome> {
  // `env` is the COMPLETE child environment probeDirectWorks built: a shell ANTHROPIC_BASE_URL at
  // a running proxy must never reach the child, or it answers the Claude smoke prompt for it.
  // `cwd` is the throwaway home, never the caller's: both CLIs read project-level config from the
  // working directory.
  const child = spawn(cliPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    env,
  });
  return probeChildOutcome(child);
}

/** A relative PATH entry answers a RELATIVE path on Windows (Bun.which joins it with cwd
 *  elsewhere), which the child could not follow once it has moved into the temp home; it is
 *  anchored to the caller's cwd here. */
function anchorToCallerCwd(found: string): string {
  return resolve(found);
}

/** The bin dir a found command contributes to the child PATH; a bare name has none. */
function binDir(found: string): string | null {
  const dir = dirname(found);
  return dir === "." ? null : dir;
}

/** The RESOLVED CLI path is threaded to the spawn: the child runs from the temp home, so a
 *  relative answer is anchored first (anchorToCallerCwd). gh is looked up only to lead the child
 *  PATH with its anchored dir: a gh-cli credential's helper calls `gh` by name from inside the
 *  temp home, where a relative PATH entry no longer resolves; a stored token needs no gh.
 *
 *  `smoke` is the caller's credential bound to Copilot's own endpoint. Its catalog pick names the
 *  model for BOTH arms; its ping decides ONLY when no CLI ran, since a CLI that ran and failed is
 *  the final verdict (an endpoint that answers cannot prove the CLI's own auth path). Null (no
 *  credential) leaves nothing to smoke with, so it is the proxy. Any failure inside the temp home
 *  is caught as false; its removal is best effort (removeScratchDir reports a path left behind).
 *
 *  The child's environment: the PROVIDER_ENV_PREFIXES families are dropped (an api key, an org, a
 *  base url, a config override) and the home var re-set after the clear; GH_ / GITHUB_ stay, so a
 *  gh-cli credential still resolves through gh. The health probe (src/health/probe.ts) strips none
 *  of these; it tests the real environment, dropping only ANTHROPIC_BASE_URL for a named profile
 *  (claudeLiveOmitEnv). */
export async function probeDirectWorks(
  descriptor: ProbeDescriptor,
  writeDirectConfig: (tmpHome: string) => void,
  smoke: DirectSmoke | null,
  deps: DirectProbeDeps = {},
): Promise<boolean> {
  const find = deps.findCommand ?? findCommand;
  const runProbe = deps.runProbe ?? defaultRunProbe;

  logger.log(`  Probing GitHub Copilot Direct for ${descriptor.cli} ...`);

  // A dry run takes the same arms: the plan is the real decision, and the CLI's auth helper (this
  // CLI, as a silent dry run) reads the credential the store already holds, since a dry run never
  // lands one it does not have.
  const cliLook = classifyAgentCli(descriptor.cli, find(descriptor.cli));
  if (cliLook.kind !== "found") {
    const look = cliLook.kind === "absent" ? `${descriptor.cli} CLI not found` : cliLook.note;
    const advice =
      cliLook.kind === "absent"
        ? " (install it with `agent shell --clis` and re-run to auto-detect Direct, or pass --direct)"
        : "";
    if (smoke === null) {
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
    refuseTooOldCli(descriptor, outcome.detail);
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
  const ghLook = find("gh");
  const ghDir = ghLook.kind === "found" ? binDir(anchorToCallerCwd(ghLook.path)) : null;

  let tmpHome: ScratchDir | null = null;
  try {
    tmpHome = scratchDir(join(tmpdir(), `copilot-env-${descriptor.cli}-`));
    writeDirectConfig(tmpHome);
    const home: ScratchDir = tmpHome;
    // Provider families stripped and gh's dir leading PATH: the doc above says why.
    const probeEnv = childEnv({
      leadPath: ghDir === null ? [] : [ghDir],
      extra: { [descriptor.homeEnvVar]: tmpHome },
      omit: (upper) => PROVIDER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)),
    });

    const run = async (model: string): Promise<ProbeOutcome> => {
      logger.log(
        `    • running a read-only smoke prompt through ${descriptor.cli} with ${model} (live model call, a few seconds; pass --direct to skip) ...`,
      );
      const args = descriptor.args(PROBE_PROMPT, home, model);
      const outcome = await runProbe(cliPath, args, probeEnv, home);
      if (outcome.ok) logger.success("    GitHub Copilot Direct is available");
      return outcome;
    };
    let outcome = await run(first.model);
    if (outcome.ok) return true;
    refuseTooOldCli(descriptor, outcome.detail);
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
      refuseTooOldCli(descriptor, outcome.detail);
      lastDetail = outcome.detail;
    }
    logger.log(
      `    • the Direct smoke prompt did not succeed${
        lastDetail ? ` (${lastDetail})` : ""
      } → using the local proxy`,
    );
    return false;
  } catch (e) {
    if (e instanceof CliTooOldError) throw e;
    logger.log(
      caught(e, (message) => `    • the Direct probe errored (${message}) → using the local proxy`),
    );
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
