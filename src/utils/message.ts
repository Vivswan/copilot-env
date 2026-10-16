// The one shape every multi-part CLI message prints in, so a reader scans it instead of reading a
// paragraph: a headline that states the fact, one indented line per piece of evidence, a lead
// that says what kind of action follows, then the actions as a command-and-meaning table. The
// message travels as parts and is laid out by whoever prints it, at that stream's width.
import { inspect } from "node:util";
import { colorEnabled } from "./ansi.ts";
import { errMessage } from "./error.ts";
import { formatTable, keyValueLine, terminalWidth, wrapMessage } from "./table.ts";

const INDENT = "  ";
const UNPAINTED: Paint = (text) => text;

/** "Pick one:" when the reader chooses, "Fix:" when there is one way, "Then:" for next steps. */
type Lead = "Pick one:" | "Fix:" | "Then:";

/** A printer's inline paint (the logger's tone and backtick cyan), applied before a wrap. */
type Paint = (text: string) => string;

/** What a printer takes and a collector keeps: prose, or a scannable the printer lays out. */
export type Message = string | ScannableMessage;

/** What a message is made of, in print order; a caller fills the parts it has. */
export interface ScannableParts {
  /** One sentence that states the fact; a caller paints an identifier in it with paintFor(color). */
  headline: string;
  /** One fact per line, printed indented under the headline. A fact with parts of its own (a
   *  collected failure, framed by caught) is laid out there whole, one indent deeper. */
  evidence?: Message[];
  /** Printed only above actions. */
  lead?: Lead;
  /** Command or step, then what it does; the second column wraps under itself. */
  actions?: [string, string][];
  /** The command edge's colorEnabled(); the argument is the test override. */
  color?: boolean;
}

/** One laid-out line: prose wraps at the printer's width, a table line is kept as laid out. */
interface Line {
  text: string;
  table: boolean;
}

/** A message as parts, laid out on demand: a printer (the logger's reporter, printWrapped, the
 *  CLI's error printer) calls `fit` with its stream's width, a string sink gets `toString`. Color
 *  carries meaning, so only each action's command is painted (cyan, by the table); the headline
 *  and the evidence stay as the caller wrote them. */
export class ScannableMessage {
  constructor(readonly parts: ScannableParts) {}

  /** The prose as written and the tables laid out for `width` (null: unbounded). */
  render(width: number | null): string {
    return this.layout(width)
      .map((line) => line.text)
      .join("\n");
  }

  /** Every line fitted to `width`: the prose wrapped under its own indent, the first line `lead`
   *  columns shorter (a printer's icon or badge), a table as laid out, so a row is never split:
   *  it fits by construction, or it is a lone command the table left whole on purpose. `paint` is
   *  the printer's inline paint, applied to the whole text before the wrap so the wrap measures
   *  what prints (a backtick pair becomes escapes); it keeps every newline. */
  fit(width: number | null, lead = 0, paint: Paint = UNPAINTED): string {
    const laid = this.layout(width);
    // A part may carry newlines of its own (a tool's multi-line detail), so the table lines are
    // marked per printed line, not per part.
    const isTable = laid.flatMap((line) => line.text.split("\n").map(() => line.table));
    const fitLine = (line: string, i: number): string => {
      if (isTable[i]) return line;
      const lineLead = i === 0 ? lead : 0;
      return wrapMessage(line, width, lineLead);
    };
    return paint(laid.map((line) => line.text).join("\n"))
      .split("\n")
      .map(fitLine)
      .join("\n");
  }

  /** For a string context (an Error's message, a template literal): stderr's width, where
   *  messages land. */
  toString(): string {
    return this.render(terminalWidth(process.stderr));
  }

  /** node's format and inspect print an object's fields, not its toString: the hook gives a
   *  printer that does not know this class (a raw console.log) the default render instead. */
  [inspect.custom](): string {
    return this.toString();
  }

  private layout(width: number | null): Line[] {
    const { headline, evidence = [], lead, actions = [], color = colorEnabled() } = this.parts;
    const prose = (text: string): Line => ({ text, table: false });
    // A stacked table's blank line between records stays blank.
    const indented = (line: Line): Line =>
      line.text === "" ? line : { ...line, text: `${INDENT}${line.text}` };
    const nestedWidth = width === null ? null : width - INDENT.length;
    const facts = evidence.flatMap((fact) =>
      (typeof fact === "string" ? [prose(fact)] : fact.layout(nestedWidth)).map(indented),
    );
    const table = formatTable(actions, { width, wrap: [false, true], color });
    const leadLine = lead === undefined || table.length === 0 ? [] : [prose(lead)];
    return [
      prose(headline),
      ...facts,
      ...leadLine,
      ...table.map((text) => ({ text, table: true })),
    ];
  }
}

/** The message `parts` make, for a printer to lay out. */
export function scannable(parts: ScannableParts): ScannableMessage {
  return new ScannableMessage(parts);
}

/** An Error that carries its message as parts: `message` is the default render for any string
 *  sink, and a printer that catches it lays `scannable` out again at its own width. */
export class ScannableError extends Error {
  readonly scannable: ScannableMessage;

  constructor(parts: ScannableParts, options?: ErrorOptions) {
    const message = new ScannableMessage(parts);
    super(message.toString(), options);
    this.scannable = message;
  }
}

/** A caught error reported in the catch site's own sentence, `frame` ("could not sync X: " + the
 *  message): a ScannableError keeps its parts, its headline framed, so the printer still lays its
 *  table out; any other error's message is framed as prose. A collector that goes on after the
 *  failure keeps the result as evidence of its own headline. */
export function caught(e: unknown, frame: (message: string) => string): Message {
  if (!(e instanceof ScannableError)) return frame(errMessage(e));
  const { headline, ...rest } = e.scannable.parts;
  return new ScannableMessage({ ...rest, headline: frame(headline) });
}

/** A caught error thrown again in the catch site's own sentence, `frame`, with `e` as its cause:
 *  the one way a catch clause rethrows, so a ScannableError keeps its parts for the printer that
 *  finally catches it, and any other error's message is framed as prose. */
export function rethrown(e: unknown, frame: (message: string) => string): Error {
  const reported = caught(e, frame);
  if (typeof reported === "string") return new Error(reported, { cause: e });
  return new ScannableError(reported.parts, { cause: e });
}

function fitted(message: Message, width: number | null): string {
  return typeof message === "string" ? wrapMessage(message, width) : message.fit(width);
}

/** console.log for prose lines and messages (status reports, next steps): laid out for the
 *  terminal, unwrapped down a pipe. */
export function printWrapped(message: Message): void {
  console.log(fitted(message, terminalWidth()));
}

/** The stderr twin, for narration beside a command's stdout payload. */
export function printWrappedToStderr(message: Message): void {
  process.stderr.write(`${fitted(message, terminalWidth(process.stderr))}\n`);
}

export function printKeyValue(key: string, value: string, color = colorEnabled()): void {
  printWrapped(keyValueLine(key, value, color));
}
