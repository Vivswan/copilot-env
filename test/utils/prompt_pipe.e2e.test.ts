// What would drift silently: the prompt library never reads stdin's end, so what a closed stdin
// answers is the wrapper's rule alone. Its first version answered every prompt's default, so a
// `cancel: "reject"` confirm took a profile mode switch as a yes when stdin ended (a review finding
// on its PR). A pipe shows it on every platform: a child whose stdin is closed before the question
// is drawn.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHILD_VALUES, childValuesEnv, importSpecifier, ROOT, runScript } from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

/** Each row: a wrapper call against a stdin that ends (after `input`, if given); `printed` is its value or error. */
const ROWS: { name: string; asked: Record<string, unknown>; input?: string; printed: string }[] = [
  {
    name: "a confirm that rejects on cancel rejects on EOF too",
    asked: { kind: "prompt", options: { type: "confirm", initial: true, cancel: "reject" } },
    printed: "ERROR:Prompt cancelled.",
  },
  {
    name: "a confirm whose cancel is undefined answers undefined on EOF",
    asked: { kind: "prompt", options: { type: "confirm", initial: true, cancel: "undefined" } },
    printed: "RESULT:undefined",
  },
  {
    name: "only a caller that opted into the default gets its initial answer on EOF",
    asked: {
      kind: "prompt",
      options: { type: "confirm", initial: true, cancel: "undefined" },
      eof: "default",
    },
    printed: "RESULT:true",
  },
  {
    name: "an answer typed before the stream ends stands, whatever the EOF policy",
    asked: {
      kind: "prompt",
      options: { type: "confirm", initial: true, cancel: "undefined" },
      eof: "default",
    },
    input: `n\n${String.fromCharCode(4)}`,
    printed: "RESULT:false",
  },
  {
    name: "a secret answers undefined on EOF",
    asked: { kind: "secret" },
    printed: "RESULT:undefined",
  },
];

function askingProgram(dir: string): string {
  const file = join(dir, "ask.ts");
  writeFileSync(
    file,
    [
      `import { prompt, promptSecret } from ${importSpecifier(join(ROOT, "src", "utils", "prompt.ts"))};`,
      `const asked = ${CHILD_VALUES};`,
      "try {",
      '  const value = asked.kind === "secret"',
      '    ? await promptSecret("Secret?")',
      '    : await prompt("Question?", asked.options, asked.eof);',
      '  process.stdout.write("RESULT:" + String(value) + "\\n");',
      "} catch (e) {",
      '  process.stdout.write("ERROR:" + (e instanceof Error ? e.message : String(e)) + "\\n");',
      "}",
    ].join("\n"),
  );
  return file;
}

test("a closed stdin follows the caller's cancel policy, and answers the default only on request", () => {
  const program = askingProgram(tempDir("prompt-pipe-"));
  const outcomes = ROWS.map((row) => {
    const ran = runScript(program, [], {
      env: { ...process.env, ...childValuesEnv(row.asked) },
      input: row.input,
    });
    return { name: row.name, exit: ran.exitCode, printed: ran.stdout.trim() };
  });
  expect(outcomes).toEqual(ROWS.map((row) => ({ name: row.name, exit: 0, printed: row.printed })));
});
