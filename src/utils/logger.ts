// No wall-clock timestamp (noise on short-lived CLI output that wraps awkwardly), stderr for the
// per-module loggers so the eval'd `agent profile env` stdout is never polluted, and every message wrapped
// to the terminal it lands on.
import {
  consola,
  type ConsolaInstance,
  type ConsolaReporter,
  createConsola,
  type LogObject,
} from "consola";
import { format } from "node:util";
import { colorEnabled, FG_CLOSE, palette, sgrOpen, type Tone } from "./ansi.ts";
import { terminalWidth, wrapMessage } from "./table.ts";

const NO_DATE = { date: false } as const;

type ReporterContext = Parameters<ConsolaReporter["log"]>[1];
type WidthOf = (stream: NodeJS.WriteStream) => number | null;

/** consola's fancy reporter decorates a message's first line with an icon and a space, or with
 *  the ` TYPE ` badge and a space when the level is below 2 (error, fatal, warn) or `badge` is set;
 *  `log` has no icon. Its basic reporter (a `fancy: false` instance) prefixes `[type] ` instead, and
 *  ` > ` on every box line. A tag adds `[tag] ` to either. */
const ICON_LEAD = 2;
const BASIC_BOX_LEAD = 3;
/** A fancy box line is margin + border + padding + text + padding + border. */
const BOX_FRAME = 7;

const bracketed = (text: string): number => (text === "" ? 0 : text.length + 3);

function firstLineLead(logObj: LogObject, fancy: boolean): number {
  const tag = bracketed(logObj.tag);
  if (!fancy) return bracketed(logObj.type) + tag;
  const badge = logObj.badge === true || (logObj.badge === undefined && logObj.level < 2);
  return (badge ? bracketed(logObj.type) : logObj.type === "log" ? 0 : ICON_LEAD) + tag;
}

/** Wraps a message's lines to the width of the stream consola will write it to (stderr below
 *  level 2, stdout otherwise) before the inner reporters decorate and print it, and paints the
 *  message by level (warn yellow, error red, success green) when `color` is on; off a TTY (width
 *  null) the text is untouched, so captured output never wraps. */
export class WrappingReporter implements ConsolaReporter {
  constructor(
    private readonly inner: ConsolaReporter[],
    private readonly fancy: boolean,
    private readonly widthOf: WidthOf,
    private readonly color: boolean,
  ) {}

  log(logObj: LogObject, ctx: ReporterContext): void {
    if (!logObj.args.every((a): a is string => typeof a === "string")) {
      for (const reporter of this.inner) reporter.log(logObj, ctx);
      return;
    }
    const stream = (logObj.level < 2 ? ctx.options.stderr : ctx.options.stdout) ?? process.stdout;
    const width = this.widthOf(stream as NodeJS.WriteStream);
    // One string as consola would make it (printf substitution included), formatted here so the
    // wrap sees the final text; a lone string is left for consola's own pass.
    const [only] = logObj.args;
    const text = logObj.args.length === 1 ? only ?? "" : format(...logObj.args);
    const tone = this.color ? LEVEL_TONES[logObj.type] : undefined;
    const body = tone === undefined ? text : inlinePaint(text, tone);
    const wrapped = this.wrapArgs(logObj, body, width);
    const painted = tone === undefined ? wrapped : perLine(wrapped, tone);
    const shaped = { ...logObj, args: [painted] };
    for (const reporter of this.inner) reporter.log(shaped, ctx);
  }

  /** A box frames every line, so its frame comes off every line; any other message loses only
   *  its first line's decoration. */
  private wrapArgs(logObj: LogObject, text: string, width: number | null): string {
    if (width === null) return text;
    if (logObj.type === "box") {
      return wrapMessage(text, width - (this.fancy ? BOX_FRAME : BASIC_BOX_LEAD));
    }
    return wrapMessage(text, width, firstLineLead(logObj, this.fancy));
  }
}

/** Before the wrap: an inline close (a caller's own paint) re-opens the tone, and the backticks
 *  consola would paint cyan are painted here, closed by re-opening the tone, so consola's
 *  characterFormat finds none; wrap-ansi re-opens a span it splits across lines. */
function inlinePaint(text: string, tone: Tone): string {
  const open = sgrOpen(tone);
  const body = text
    .replaceAll(FG_CLOSE, `${FG_CLOSE}${open}`)
    .replace(/`([^`]+)`/g, (_, code: string) => `${sgrOpen("cyan")}${code}${FG_CLOSE}${open}`);
  // A close that ended the text needs no re-open: it would leave an empty span at the end.
  return body.endsWith(open) ? body.slice(0, -open.length) : body;
}

/** After the wrap: every line in its own span, since consola appends a gray tag, closing the
 *  foreground, to the first line; a caller's own span still open at a line's end (wrap-ansi
 *  closes the ones it splits, a raw newline does not) is re-opened on the next. */
function perLine(text: string, tone: Tone): string {
  let carried = "";
  return text.split("\n").map((line) => {
    const body = `${carried}${line}`;
    carried = openForeground(body);
    return body === "" ? body : palette[tone](body);
  }).join("\n");
}

const SGR_CODE = new RegExp(`${String.fromCharCode(27)}\\[(\\d+)m`, "g");

/** The foreground open code still in force at the end of `line`, or "" when it was closed. */
function openForeground(line: string): string {
  let open = "";
  for (const match of line.matchAll(SGR_CODE)) {
    const code = Number(match[1]);
    if (code === 39) open = "";
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) open = match[0];
  }
  return open;
}

/** The message body's tone by type; every other type keeps the caller's own paint. */
const LEVEL_TONES: Partial<Record<LogObject["type"], Tone>> = {
  warn: "yellow",
  error: "red",
  fatal: "red",
  success: "green",
  ready: "green",
};

/** Puts the wrapping reporter in front of the instance's own, budgeting for the one consola chose
 *  (fancy in a plain TTY; basic under CI, off a TTY, or for a `fancy: false` instance). `color`
 *  is the command edge's colorEnabled(); `widthOf` is the test seam. */
export function wrapToTerminal(
  instance: ConsolaInstance,
  color = colorEnabled(),
  widthOf: WidthOf = terminalWidth,
): ConsolaInstance {
  const inner = instance.options.reporters;
  const fancy = inner.some((reporter) => reporter.constructor.name === "FancyReporter");
  instance.options.reporters = [new WrappingReporter(inner, fancy, widthOf, color)];
  return instance;
}

/** Call once per entry point. A child made with `withTag` copies the reporters it finds at that
 *  moment, so a module-scope child comes from `taggedLogger`, not from `consola.withTag`. */
export function configureConsolaOutput(): void {
  consola.options.formatOptions = { ...consola.options.formatOptions, ...NO_DATE };
  wrapToTerminal(consola);
}

/** A module-scope child of the global consola, wrapped on its own since it is created before the
 *  entry point configures the parent. */
export function taggedLogger(tag: string): ConsolaInstance {
  const logger = consola.withTag(tag);
  logger.options.formatOptions = { ...logger.options.formatOptions, ...NO_DATE };
  return wrapToTerminal(logger);
}

/** The MCP stdio server owns stdout as JSON-RPC and library code it calls logs through the global
 *  consola; one stray info line would corrupt the protocol. */
export function redirectConsolaToStderr(): void {
  consola.options.stdout = process.stderr;
}

/** For a scope whose narration must stay off the command's stdout, such as the self-update
 *  preflight inside `agent start`. */
export async function withConsolaOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const previous = consola.options.stdout;
  consola.options.stdout = process.stderr;
  try {
    return await fn();
  } finally {
    consola.options.stdout = previous;
  }
}

/** Clack's frame: a marker and two spaces before the question, the bar, marker and spaces before
 *  a select label. */
const PROMPT_LEAD = 3;
const OPTION_LEAD = 5;

type PromptOptions = NonNullable<Parameters<ConsolaInstance["prompt"]>[1]>;

/** The question and every select label wrapped under Clack's frame; a bare string option keeps
 *  its value (Clack returns the value, which was the string). */
export function promptLayout<T extends PromptOptions>(
  message: string,
  options: T | undefined,
  width: number | null,
): { message: string; options: T | undefined } {
  const question = wrapMessage(message, width, PROMPT_LEAD);
  if (options === undefined || !("options" in options)) return { message: question, options };
  const labeled = options.options.map((option) =>
    typeof option === "string"
      ? { label: wrapMessage(option, width, OPTION_LEAD), value: option }
      : { ...option, label: wrapMessage(option.label, width, OPTION_LEAD) }
  );
  return { message: question, options: { ...options, options: labeled } };
}

/** The one place a question is asked: consola's prompt bypasses the reporters, so its text is
 *  wrapped here to the terminal the answer is typed in. */
export const prompt: ConsolaInstance["prompt"] = (message, options) => {
  const laid = promptLayout(message, options, terminalWidth());
  return consola.prompt(laid.message, laid.options);
};

export function createStderrLogger(): ConsolaInstance {
  return wrapToTerminal(createConsola({
    stdout: process.stderr,
    stderr: process.stderr,
    formatOptions: NO_DATE,
  }));
}
