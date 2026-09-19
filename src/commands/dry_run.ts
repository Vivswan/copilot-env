// The command-layer face of a dry run: runs the command's own landing on the fs seam's overlay
// (every write plans, every read sees the plan) and prints the tree diff on stdout. One printer for
// every `--dry-run`, so a command's preview and its real writes come from the same code path.
import { type FileChange, underDryRunMarker, withDryRun } from "../utils/dry_run.ts";
import { renderDryRun } from "../utils/dry_run_report.ts";
import { terminalWidth, wrapLine } from "../utils/table.ts";

/** The command's stderr narration still runs (the probes it needs, the lines it says); the diff is
 *  the stdout, file by file and attribute by attribute, wrapped to the terminal like every other
 *  table (an attribute row hangs under its key; a long path or value splits at the width). Every
 *  process the body spawns (a probe's agent CLI, whose auth helper is this CLI again) inherits the
 *  run's marker and lands nothing either. */
export async function runDryRun(body: () => Promise<unknown>): Promise<void> {
  const run = await underDryRunMarker(() => withDryRun(body));
  if (run.status === "failed") {
    // A body that fails partway (a probe, an agent wiring) has landed what precedes the failure in
    // the real command too, so the changes planned so far print before the failure propagates. A
    // refusal before any landing (no credential, a missing flag) has nothing to preview: the error
    // alone is the output, as in the real run.
    if (run.changes.length > 0) {
      printChanges("DRY RUN: nothing was written. Before it failed, the command would have:", run);
    }
    throw run.error;
  }
  printChanges("DRY RUN: nothing was written. The command would:", run);
}

function printChanges(header: string, run: { changes: readonly FileChange[] }): void {
  const width = terminalWidth();
  console.log(header);
  // A path or a value wider than the line is one word: wrapLine splits it at the width. A diff
  // row keeps its `+`/`-` marker in the indent, so a wrapped row never sheds it onto a line of
  // its own.
  for (const line of renderDryRun(run.changes)) {
    const marker = /^ {2}([+-]) ?/.exec(line);
    const indent = marker !== null ? `    ${marker[1]} ` : line.startsWith("  ") ? "    " : "  ";
    const hang = marker !== null ? "      " : `${indent}  `;
    const text = marker !== null ? line.slice(marker[0].length) : line.trimStart();
    for (const wrapped of wrapLine(text, width, indent, hang)) console.log(wrapped);
  }
}
