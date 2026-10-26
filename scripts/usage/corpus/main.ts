// The run: look up both CLIs, record them concurrently against the fake, check the transcript
// evidence and the request trace, scrub, then print the one summary line and exit.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { findCommand } from "../../../src/utils/command.ts";
import { registry } from "./children.ts";
import { type ClaudeIds, claudeEvidenceFailures, recordClaude } from "./claude.ts";
import { die, ledger, log, parseArgs, writeFile } from "./cli.ts";
import { type CodexIds, codexEvidenceFailures, recordCodex } from "./codex.ts";
import {
  fakeUsageBySource,
  MinuteStraddle,
  requestTraceFailures,
  type TracedRequest,
} from "./fake.ts";
import { startInferenceFake } from "./inference_fake.mjs";
import {
  copyScrubbed,
  IdMap,
  isClaudeUsageLine,
  isCodexUsageLine,
  type SourceSummary,
} from "./scrub.ts";
import { recordsUnder, type Source, SUMMARY_SOURCES } from "./transcripts.ts";

/** Below the consumer job's 15-minute timeout; the turns and the minute wait fit inside it. */
const TOTAL_DEADLINE_MS = 8 * 60_000;

/** `<out>` must be absent or empty: a stale file there would ship with the corpus. */
function ensureEmptyOut(out: string): void {
  if (!existsSync(out)) return;
  let entries: string[];
  try {
    entries = readdirSync(out);
  } catch {
    die("--out is not a readable directory");
  }
  if (entries.length > 0) die("--out is not empty; pick a fresh directory");
}

/** Remove every login artifact from the kept home; the failures come back for the summary. */
function stripLogins(home: string): string[] {
  const failures: string[] = [];
  for (const artifact of [
    join(home, ".codex", "auth.json"),
    join(home, ".claude", ".credentials.json"),
    join(home, ".claude", ".claude.json"),
    join(home, ".claude", "backups"),
  ]) {
    try {
      if (!existsSync(artifact)) continue;
      rmSync(artifact, { recursive: true, force: true });
      ledger.removed.push(relative(ledger.out, artifact).replaceAll("\\", "/"));
    } catch (e) {
      failures.push(`could not remove a login artifact (${e instanceof Error ? e.name : "error"})`);
    }
  }
  return failures;
}

function terminationSignals(): NodeJS.Signals[] {
  return process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
}

type Args = ReturnType<typeof parseArgs>;

/** The run's state, shared by the exit path and every step that records a failure. */
interface Run {
  args: Args;
  home: string;
  failures: string[];
  trace: TracedRequest[];
  sources: Record<Source, SourceSummary | null>;
  finalized: boolean;
}

function summaryLine(run: Run): string {
  const recorded = SUMMARY_SOURCES.map((s) => run.sources[s]).filter((c) => c !== null);
  return JSON.stringify({
    files: recorded.reduce((n, c) => n + c.files, 0),
    lines: recorded.reduce((n, c) => n + c.lines, 0),
    usageLines: {
      claude: run.sources.claude?.usageLines ?? 0,
      codex: run.sources.codex?.usageLines ?? 0,
    },
    backend: run.args.real ? "real" : "fake",
    requests: run.trace.length,
    fakeUsage: run.args.real ? null : fakeUsageBySource(run.trace),
    sources: run.sources,
    written: ledger.written,
    removed: ledger.removed,
    failures: run.failures,
  });
}

/** The one exit path: strip logins, print the single summary line, exit. */
function finalize(run: Run, code: number): never {
  if (!run.finalized) {
    run.finalized = true;
    run.failures.push(...stripLogins(run.home));
    // One line, last on stdout: the consumer reads it with `tail -n 1 | jq`.
    console.log(summaryLine(run));
  }
  process.exit(run.failures.length > 0 && code === 0 ? 1 : code);
}

/** A failure for each CLI the turns need that is not on PATH. */
function absentClis(): string[] {
  return ["claude", "codex"]
    .filter((cli) => findCommand(cli).kind === "absent")
    .map((cli) => `${cli} is not on PATH`);
}

/** Both CLIs recorded against the fake (under --real, their real backends), then the transcript
 *  evidence and the request trace checked, unless a turn already failed. */
async function recordBoth(
  run: Run,
  work: string,
  turnsDir: string,
  stop: (label: string) => void,
): Promise<void> {
  const { home } = run;
  const straddle = new MinuteStraddle();
  const fake = run.args.real
    ? null
    : await startInferenceFake(0, () => {}, {
        beforeReply: () => straddle.hold(),
        onRequest: (request: TracedRequest) => run.trace.push(request),
      });
  if (fake !== null) log("fake inference backend listening on loopback");
  let claudeIds: ClaudeIds | undefined;
  let codexIds: CodexIds | undefined;
  try {
    // Both CLIs run concurrently (separate homes), so the one minute wait serves both.
    [claudeIds, codexIds] = await Promise.all([
      recordClaude(home, work, fake?.baseUrl ?? null, straddle, turnsDir, stop),
      recordCodex(home, work, fake?.baseUrl ?? null, straddle, turnsDir, stop),
    ]);
  } finally {
    if (!(await registry.killAll())) run.failures.push("a CLI child did not exit after the kill");
    await fake?.close();
  }
  if (run.failures.length > 0) return;
  run.failures.push(
    ...claudeEvidenceFailures(claudeIds, recordsUnder(join(home, ".claude", "projects"))),
    ...codexEvidenceFailures(codexIds, recordsUnder(join(home, ".codex", "sessions"))),
  );
  if (!run.args.real) run.failures.push(...requestTraceFailures(run.trace));
}

/** Both source trees scrubbed into <out>, each then checked for session files, usage lines and
 *  (against the fake) a session straddling a minute boundary; the checks are skipped once
 *  anything failed. */
function scrubSources(run: Run): void {
  const ids = new IdMap();
  run.sources.claude = copyScrubbed(
    "claude",
    join(run.home, ".claude", "projects"),
    join(run.args.out, "claude", "projects"),
    isClaudeUsageLine,
    ids,
  );
  run.sources.codex = copyScrubbed(
    "codex",
    join(run.home, ".codex", "sessions"),
    join(run.args.out, "codex", "sessions"),
    isCodexUsageLine,
    ids,
  );
  for (const source of SUMMARY_SOURCES) {
    const counts = run.sources[source];
    if (counts === null || run.failures.length > 0) continue;
    if (counts.files === 0) run.failures.push(`${source}: no session files were written`);
    if (counts.usageLines === 0) run.failures.push(`${source}: no usage lines were recorded`);
    if (!run.args.real && counts.sessionsSpanningMinutes === 0) {
      run.failures.push(`${source}: no session straddles a minute boundary`);
    }
  }
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  ensureEmptyOut(args.out);
  const run: Run = {
    args,
    home: join(args.out, "home"),
    failures: [],
    trace: [],
    sources: { claude: null, codex: null },
    finalized: false,
  };
  ledger.out = args.out;

  const stop = (label: string): void => {
    run.failures.push(label);
    void registry.killAll();
  };
  const abort = (reason: string, code: number): void => {
    run.failures.push(reason);
    void registry.killAll().then((clean) => {
      if (!clean) run.failures.push("a CLI child did not exit after the kill");
      finalize(run, code);
    });
  };
  const signals = terminationSignals();
  const onSignal = (): void => abort("interrupted by a signal", 130);
  for (const signal of signals) process.on(signal, onSignal);
  // Terminal: the deadline kills everything, prints the one summary line and exits 1.
  const totalTimer = setTimeout(() => abort("deadline", 1), TOTAL_DEADLINE_MS);

  try {
    run.failures.push(...absentClis());
    if (args.real) log("--real: turns run against the CLIs' real credentials and SPEND TOKENS");
    const work = join(run.home, "work");
    const turnsDir = join(run.home, "turns");
    mkdirSync(work, { recursive: true });
    mkdirSync(turnsDir, { recursive: true });
    writeFile(join(work, "corpus-note.txt"), "The corpus note: one line for the Read tool.\n");
    if (run.failures.length === 0) await recordBoth(run, work, turnsDir, stop);
    scrubSources(run);
  } catch (e) {
    run.failures.push(`aborted: ${e instanceof Error ? e.name : "error"}`);
  } finally {
    clearTimeout(totalTimer);
    if (!(await registry.killAll())) run.failures.push("a CLI child did not exit after the kill");
    for (const signal of signals) process.off(signal, onSignal);
  }
  finalize(run, 0);
}
