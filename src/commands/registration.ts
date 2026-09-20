// What every Commander registration shares, in one place: the options bag Commander hands an
// action, the one wording of `--dry-run`, and the one-value-per-line help of a choice flag.

/** Commander hands action callbacks an options bag of mixed-typed values. */
export type Opts = Record<string, unknown>;

/** The one wording of `--dry-run` on every writing command (the plan is src/commands/dry_run.ts). */
export const DRY_RUN_HELP = "Show what would change and write nothing.";

/** The help of a flag that takes one of several named values: the one-line answer, then one row
 *  per value, aligned. Commander indents every row to the description column as long as none
 *  starts with whitespace (that would make it print the text verbatim). */
export function valueList(lead: string, values: readonly (readonly [string, string])[]): string {
  const column = Math.max(...values.map(([name]) => name.length)) + 3;
  return [lead, ...values.map(([name, what]) => `${name.padEnd(column)}${what}`)].join("\n");
}
