// The run: look up both CLIs, record them concurrently against the fake, check the transcript
// evidence and the request trace, scrub, then print the one summary line and exit.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { findCommand } from "../../src/utils/command.ts";
import { startInferenceFake } from "../../test/helpers/inference_fake.mjs";
import { claudeEvidenceFailures, type ClaudeIds, recordClaude } from "./claude.ts";
import { die, ledger, log, parseArgs, writeFile } from "./cli.ts";
import { registry } from "./children.ts";
import { codexEvidenceFailures, type CodexIds, recordCodex } from "./codex.ts";
import {
  fakeUsageBySource,
  MinuteStraddle,
  requestTraceFailures,
  type TracedRequest,
} from "./fake.ts";
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
  for (
    const artifact of [
      join(home, ".codex", "auth.json"),
      join(home, ".claude", ".credentials.json"),
      join(home, ".claude", ".claude.json"),
      join(home, ".claude", "backups"),
    ]
  ) {
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

function terminationSignals(): Deno.Signal[] {
  return Deno.build.os === "windows" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
}

export async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  ensureEmptyOut(args.out);
  const failures: string[] = [];
  const trace: TracedRequest[] = [];
  const sources: Record<Source, SourceSummary | null> = { claude: null, codex: null };
  const home = join(args.out, "home");
  ledger.out = args.out;
  let finalized = false;

  /** The one exit path: strip logins, print the single summary line, exit. */
  const finalize = (code: number): never => {
    if (!finalized) {
      finalized = true;
      failures.push(...stripLogins(home));
      const recorded = SUMMARY_SOURCES.map((s) => sources[s]).filter((c) => c !== null);
      const summary = {
        "files": recorded.reduce((n, c) => n + c.files, 0),
        "lines": recorded.reduce((n, c) => n + c.lines, 0),
        "usageLines": {
          "claude": sources.claude?.usageLines ?? 0,
          "codex": sources.codex?.usageLines ?? 0,
        },
        "backend": args.real ? "real" : "fake",
        "requests": trace.length,
        "fakeUsage": args.real ? null : fakeUsageBySource(trace),
        "sources": sources,
        "written": ledger.written,
        "removed": ledger.removed,
        "failures": failures,
      };
      // One line, last on stdout: the consumer reads it with `tail -n 1 | jq`.
      console.log(JSON.stringify(summary));
    }
    Deno.exit(failures.length > 0 && code === 0 ? 1 : code);
  };
  const stop = (label: string): void => {
    failures.push(label);
    void registry.killAll();
  };
  const signals = terminationSignals();
  const onSignal = (): void => {
    failures.push("interrupted by a signal");
    void registry.killAll().then((clean) => {
      if (!clean) failures.push("a CLI child did not exit after the kill");
      finalize(130);
    });
  };
  for (const signal of signals) Deno.addSignalListener(signal, onSignal);
  // Terminal: the deadline kills everything, prints the one summary line and exits 1.
  const totalTimer = setTimeout(() => {
    failures.push("deadline");
    void registry.killAll().then((clean) => {
      if (!clean) failures.push("a CLI child did not exit after the kill");
      finalize(1);
    });
  }, TOTAL_DEADLINE_MS);

  try {
    for (const cli of ["claude", "codex"]) {
      const look = findCommand(cli);
      if (look.launchFailed) failures.push(`could not look for ${cli} (the resolver did not run)`);
      else if (look.path === null) failures.push(`${cli} is not on PATH`);
    }
    if (args.real) log("--real: turns run against the CLIs' real credentials and SPEND TOKENS");
    const work = join(home, "work");
    const turnsDir = join(home, "turns");
    mkdirSync(work, { recursive: true });
    mkdirSync(turnsDir, { recursive: true });
    writeFile(join(work, "corpus-note.txt"), "The corpus note: one line for the Read tool.\n");

    if (failures.length === 0) {
      const straddle = new MinuteStraddle();
      const fake = args.real ? null : await startInferenceFake(0, () => {}, {
        beforeReply: () => straddle.hold(),
        onRequest: (request: TracedRequest) => trace.push(request),
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
        if (!(await registry.killAll())) failures.push("a CLI child did not exit after the kill");
        await fake?.close();
      }
      if (failures.length === 0) {
        failures.push(
          ...claudeEvidenceFailures(claudeIds, recordsUnder(join(home, ".claude", "projects"))),
          ...codexEvidenceFailures(codexIds, recordsUnder(join(home, ".codex", "sessions"))),
        );
        if (!args.real) failures.push(...requestTraceFailures(trace));
      }
    }
    const ids = new IdMap();
    sources.claude = copyScrubbed(
      "claude",
      join(home, ".claude", "projects"),
      join(args.out, "claude", "projects"),
      isClaudeUsageLine,
      ids,
    );
    sources.codex = copyScrubbed(
      "codex",
      join(home, ".codex", "sessions"),
      join(args.out, "codex", "sessions"),
      isCodexUsageLine,
      ids,
    );
    for (const source of SUMMARY_SOURCES) {
      const counts = sources[source];
      if (counts === null || failures.length > 0) continue;
      if (counts.files === 0) failures.push(`${source}: no session files were written`);
      if (counts.usageLines === 0) failures.push(`${source}: no usage lines were recorded`);
      if (!args.real && counts.sessionsSpanningMinutes === 0) {
        failures.push(`${source}: no session straddles a minute boundary`);
      }
    }
  } catch (e) {
    failures.push(`aborted: ${e instanceof Error ? e.name : "error"}`);
  } finally {
    clearTimeout(totalTimer);
    if (!(await registry.killAll())) failures.push("a CLI child did not exit after the kill");
    for (const signal of signals) Deno.removeSignalListener(signal, onSignal);
  }
  finalize(0);
}
