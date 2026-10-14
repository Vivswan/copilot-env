// The one place a question is asked. Apart from the logger so the daemon shims' import closure
// (test/install/installer_pinning.e2e.test.ts) never carries a prompt library: the daemon never
// prompts. Every frame is drawn on stderr like the rest of the narration: stdout carries results
// (`agent auth --get`'s token), so a redirected stdout never swallows a question.

import { confirm, isCancel, multiselect, password, select, text } from "@clack/prompts";
import type { ConsolaInstance } from "consola";

/** consola's prompt options stay the call sites' contract: the question types, `initial`, and
 *  what a cancel (Ctrl-C) answers. */
type PromptOptions = NonNullable<Parameters<ConsolaInstance["prompt"]>[1]>;
type Choices = Extract<PromptOptions, { options: unknown[] }>["options"];
/** What a closed stdin answers. `cancel`, the default, follows the caller's cancel policy: an ended
 *  stream is no more a yes than Ctrl-C. `default` is the opt-in of a caller whose contract predates
 *  the library (proxy-token's start question, read at EOF as a shell's `read -r`). */
type EofPolicy = "cancel" | "default";

const CANCELLED = "Prompt cancelled.";
/** Ctrl-D in a raw-mode terminal: a keypress, not a stream end. */
const EOT = "\u0004";

function choices(options: Choices): { value: string; label: string; hint?: string }[] {
  return options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
}

function ask(message: string, options: PromptOptions, signal: AbortSignal): Promise<unknown> {
  const output = process.stderr;
  switch (options.type) {
    case "confirm":
      return confirm({ message, initialValue: options.initial, output, signal });
    case "select":
      return select({
        message,
        options: choices(options.options),
        initialValue: options.initial,
        output,
        signal,
      });
    case "multiselect":
      return multiselect({
        message,
        options: choices(options.options),
        initialValues: options.initial,
        required: options.required,
        output,
        signal,
      });
    default:
      return text({
        message,
        defaultValue: options.default,
        placeholder: options.placeholder,
        initialValue: options.initial,
        output,
        signal,
      });
  }
}

/** clack waits for a keypress and never reads the stream's end, so a closed stdin (a pipe at EOF,
 *  or `< /dev/null`) would hold the command forever. A terminal's Ctrl-D is the same end: readline
 *  closes itself on it and pauses stdin, so clack would never see another key. */
async function askUntilEof<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<{ answer: T; ended: boolean }> {
  const eof = new AbortController();
  const end = (): void => eof.abort();
  const onKey = (_text: string, key: { sequence?: string } | undefined): void => {
    if (key?.sequence === EOT) end();
  };
  if (process.stdin.readableEnded) end();
  process.stdin.once("end", end);
  process.stdin.on("keypress", onKey);
  try {
    const answer = await run(eof.signal);
    return { answer, ended: eof.signal.aborted && isCancel(answer) };
  } finally {
    process.stdin.off("end", end);
    process.stdin.off("keypress", onKey);
  }
}

function defaultAnswer(options: PromptOptions): unknown {
  return ("default" in options ? options.default : undefined) ?? options.initial;
}

function cancelled(options: PromptOptions): unknown {
  switch (options.cancel) {
    case "reject":
      throw new Error(CANCELLED);
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "symbol":
      return Symbol.for("cancel");
    default:
      return defaultAnswer(options);
  }
}

/**
 * Not consola's own prompt: its bundled clack 0.10 sinks readline into a tty.WriteStream on fd 0
 * whose `_write` override Bun writes past, so under Bun every arrow key reached the terminal and
 * each redraw landed a row low (and a read-only fd 0, as under tmux, failed with EBADF).
 */
export const prompt = (async (
  message: string,
  options: PromptOptions = {},
  eof: EofPolicy = "cancel",
) => {
  const { answer, ended } = await askUntilEof((signal) => ask(message, options, signal));
  if (ended) return eof === "default" ? defaultAnswer(options) : cancelled(options);
  return isCancel(answer) ? cancelled(options) : answer;
}) as ConsolaInstance["prompt"] &
  ((message: string, options: PromptOptions, eof: EofPolicy) => Promise<unknown>);

/** A masked line (a token paste): the typed value, or undefined when the user cancelled (Ctrl-C)
 *  or stdin closed. */
export async function promptSecret(message: string): Promise<string | undefined> {
  const { answer, ended } = await askUntilEof((signal) =>
    password({ message, output: process.stderr, signal }),
  );
  return ended || isCancel(answer) ? undefined : answer;
}
