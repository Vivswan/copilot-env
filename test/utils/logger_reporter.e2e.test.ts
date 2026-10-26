// What would drift silently: consola picks its reporter from CI and TEST, never from the stream,
// and src/utils/logger.ts adds one exception (basic where color is refused). A choice keyed on
// the TTY instead turns every piped run basic (`agent start 2>&1 | tee`, an editor's task runner)
// with every in-process test still green: none of them sees a pipe.

import { stripVTControlCharacters } from "node:util";
import { agentHomeEnv } from "../helpers/env.ts";
import { runCli } from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

/** Refused before any state is read, so the line is the same in an empty home. */
const ARGS = ["profile", "show", "nosuch"];

/** The refusal's text, as the CLI words it; the two reporters frame it differently. */
const MESSAGE = "the profile name goes before the verb: `agent profile nosuch show ...`";

/** The runner's own keys scrubbed, so the child sees the case's env alone; COLUMNS too, so the line never wraps. */
const CLEAN: Record<string, string | undefined> = {
  CI: undefined,
  GITHUB_ACTIONS: undefined,
  TEST: undefined,
  NODE_ENV: undefined,
  NO_COLOR: undefined,
  FORCE_COLOR: undefined,
  COLUMNS: undefined,
  TERM: "xterm-256color",
};

/** The fancy reporter paints a backtick span and drops the backticks; the basic one keeps them. */
const BADGE = `\n ERROR  ${MESSAGE.replaceAll("`", "")}\n\n`;

/** The basic reporter's line: the level in brackets, the backticks kept. */
const BRACKET = `[error] ${MESSAGE}\n`;

/** One child run per row; its env is spread over CLEAN, so a key here wins. */
const CASES = [
  { name: "a pipe, nothing set", env: {}, stderr: BADGE },
  { name: "CI=1", env: { CI: "1" }, stderr: BRACKET },
  { name: "NO_COLOR=1", env: { NO_COLOR: "1" }, stderr: BRACKET },
  { name: "TERM=dumb", env: { TERM: "dumb" }, stderr: BRACKET },
];

test("down a pipe the CLI's error keeps consola's ERROR badge; the [error] bracket only under CI or where color is refused", () => {
  const home = agentHomeEnv(tempDir("logger-reporter-"));
  const seen = CASES.map(({ name, env }) => {
    const run = runCli(ARGS, { env: { ...process.env, ...home, ...CLEAN, ...env } });
    return {
      name,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: stripVTControlCharacters(run.stderr),
    };
  });
  expect(seen).toEqual(
    CASES.map(({ name, stderr }) => ({ name, exitCode: 1, stdout: "", stderr })),
  );
});
