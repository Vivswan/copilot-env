// No wall-clock timestamp (noise on short-lived CLI output that wraps awkwardly), stderr for the
// per-module loggers so the eval'd `agent env` stdout is never polluted, and every message wrapped
// to the terminal it lands on.
import {
  consola,
  type ConsolaInstance,
  type ConsolaReporter,
  createConsola,
  type LogObject,
} from "consola";
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
 *  level 2, stdout otherwise) before the inner reporters decorate and print it; off a TTY (width
 *  null) the message is untouched, so captured output never wraps. */
export class WrappingReporter implements ConsolaReporter {
  constructor(
    private readonly inner: ConsolaReporter[],
    private readonly fancy: boolean,
    private readonly widthOf: WidthOf,
  ) {}

  log(logObj: LogObject, ctx: ReporterContext): void {
    const stream = (logObj.level < 2 ? ctx.options.stderr : ctx.options.stdout) ?? process.stdout;
    const width = this.widthOf(stream as NodeJS.WriteStream);
    const wrapped = width === null || !logObj.args.every((a) => typeof a === "string")
      ? logObj
      : { ...logObj, args: [this.wrapArgs(logObj, width)] };
    for (const reporter of this.inner) reporter.log(wrapped, ctx);
  }

  /** A box frames every line, so its frame comes off every line; any other message loses only
   *  its first line's decoration. */
  private wrapArgs(logObj: LogObject, width: number): string {
    const text = logObj.args.join(" ");
    if (logObj.type === "box") {
      return wrapMessage(text, width - (this.fancy ? BOX_FRAME : BASIC_BOX_LEAD));
    }
    return wrapMessage(text, width, firstLineLead(logObj, this.fancy));
  }
}

/** Puts the wrapping reporter in front of the instance's own, budgeting for the one consola chose
 *  (fancy in a plain TTY; basic under CI, off a TTY, or for a `fancy: false` instance). `widthOf`
 *  is the test seam. */
export function wrapToTerminal(
  instance: ConsolaInstance,
  widthOf: WidthOf = terminalWidth,
): ConsolaInstance {
  const inner = instance.options.reporters;
  const fancy = inner.some((reporter) => reporter.constructor.name === "FancyReporter");
  instance.options.reporters = [new WrappingReporter(inner, fancy, widthOf)];
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

export function createStderrLogger(): ConsolaInstance {
  return wrapToTerminal(createConsola({
    stdout: process.stderr,
    stderr: process.stderr,
    formatOptions: NO_DATE,
  }));
}
