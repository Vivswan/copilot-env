// What every Commander registration shares, in one place: the options bag Commander hands an
// action, the one wording of `--dry-run`, and the dim help paragraph.
import { gray } from "../utils/ansi.ts";
import { terminalWidth, wrapMessage } from "../utils/table.ts";

/** Commander hands action callbacks an options bag of mixed-typed values. */
export type Opts = Record<string, unknown>;

/** The one wording of `--dry-run` on every writing command (the plan is src/commands/dry_run.ts). */
export const DRY_RUN_HELP =
  "Print every file and store key the command would change (old -> new, secrets redacted) and write nothing.";

/** Help paragraphs Commander prints verbatim: dim, one blank line before each, wrapped at help
 *  time to the terminal the way the option descriptions above them are. */
export function helpNote(...paragraphs: string[]): string {
  return wrapMessage(paragraphs.map((p) => `\n${gray(p)}`).join("\n"), terminalWidth());
}
