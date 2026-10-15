// The one shape every multi-part CLI message prints in, so a reader scans it instead of reading a
// paragraph: a headline that states the fact, one indented line per piece of evidence, a lead
// that says what kind of action follows, then the actions as a command-and-meaning table.
import { colorEnabled } from "./ansi.ts";
import { formatTable, terminalWidth } from "./table.ts";

/** "Pick one:" when the reader chooses, "Fix:" when there is one way, "Then:" for next steps. */
type Lead = "Pick one:" | "Fix:" | "Then:";

/** What a message is made of, in print order; a caller fills the parts it has. */
export interface ScannableParts {
  /** One sentence that states the fact; a caller paints an identifier in it with paintFor(color). */
  headline: string;
  /** One fact per line, printed indented under the headline. */
  evidence?: string[];
  /** Printed only above actions. */
  lead?: Lead;
  /** Command or step, then what it does; the second column wraps under itself. */
  actions?: [string, string][];
  /** The command edge's colorEnabled(); the argument is the test override. */
  color?: boolean;
  /** Visible columns to fit; null never wraps. Defaults to stderr's, where messages land. */
  width?: number | null;
}

/** The message's lines joined with newlines: for a logger line or an Error's message alike. Color
 *  carries meaning, so only each action's command is painted (cyan, by the table); the headline
 *  and the evidence stay as the caller wrote them. */
export function scannable(parts: ScannableParts): string {
  const {
    headline,
    evidence = [],
    lead,
    actions = [],
    color = colorEnabled(),
    width = terminalWidth(process.stderr),
  } = parts;
  const table = formatTable(actions, { width, wrap: [false, true], color });
  const leadLine = lead === undefined || table.length === 0 ? [] : [lead];
  return [headline, ...evidence.map((line) => `  ${line}`), ...leadLine, ...table].join("\n");
}
