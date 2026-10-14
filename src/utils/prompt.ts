// The one place a question is asked. Apart from the logger so the daemon shims' import closure
// (test/install/installer_pinning.e2e.test.ts) never carries a prompt library: the daemon never
// prompts.

import { confirm, isCancel, multiselect, select, text } from "@clack/prompts";
import type { ConsolaInstance } from "consola";

/** consola's prompt options stay the call sites' contract: the question types, `initial`, and
 *  what a cancel (Ctrl-C) answers. */
type PromptOptions = NonNullable<Parameters<ConsolaInstance["prompt"]>[1]>;
type Choices = Extract<PromptOptions, { options: unknown[] }>["options"];

function choices(options: Choices): { value: string; label: string; hint?: string }[] {
  return options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
}

function ask(message: string, options: PromptOptions): Promise<unknown> {
  switch (options.type) {
    case "confirm":
      return confirm({ message, initialValue: options.initial });
    case "select":
      return select({ message, options: choices(options.options), initialValue: options.initial });
    case "multiselect":
      return multiselect({
        message,
        options: choices(options.options),
        initialValues: options.initial,
        required: options.required,
      });
    default:
      return text({
        message,
        defaultValue: options.default,
        placeholder: options.placeholder,
        initialValue: options.initial,
      });
  }
}

const CANCELLED = "Prompt cancelled.";

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
      return ("default" in options ? options.default : undefined) ?? options.initial;
  }
}

/**
 * Not consola's own prompt: its bundled clack 0.10 sinks readline into a tty.WriteStream on fd 0
 * whose `_write` override Bun writes past, so under Bun every arrow key reached the terminal and
 * each redraw landed a row low (and a read-only fd 0, as under tmux, failed with EBADF).
 */
export const prompt = (async (message: string, options: PromptOptions = {}) => {
  const answer = await ask(message, options);
  return isCancel(answer) ? cancelled(options) : answer;
}) as ConsolaInstance["prompt"];
