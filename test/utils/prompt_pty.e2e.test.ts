// What would drift silently: how a prompt draws and reads keys depends on the runtime's tty streams
// and the prompt library's renderer, which nothing here pins (under Bun, consola's own prompt left
// replaced frames on screen). In raw mode Ctrl-C is a keypress, a masked line echoes nothing,
// and Ctrl-D makes readline close and pause stdin, stranding a prompt that waits for keys. Only a
// real pty shows this.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { until } from "../helpers/daemon.ts";
import {
  bunRunArgs,
  CHILD_VALUES,
  childValuesEnv,
  importSpecifier,
  ROOT,
  spawnChild,
} from "../helpers/run.ts";
import { expect, step, tempDir, test } from "../helpers/testing.ts";

const DOWN = `${String.fromCharCode(27)}[B`;
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const COLS = 80;
const ROWS = 24;

const QUESTION = "Which way should the example go?";
const OPTIONS = [
  {
    label: "alpha - the first way, with a tail long enough to look like a real label",
    value: "alpha",
  },
  { label: "bravo - the second way, through the machine's own `example login`", value: "bravo" },
  { label: "charlie - paste a value", value: "charlie" },
  { label: "delta - copy a value from the EXAMPLE_VALUE environment (headless)", value: "delta" },
];

/** The wrapper call each child program makes, over `asked` (its CHILD_VALUES). */
const ASK = {
  select: 'prompt(asked.question, { type: "select", options: asked.options, cancel: "reject" })',
  confirm: 'prompt(asked.question, { type: "confirm", initial: true, cancel: "undefined" })',
  strict: 'prompt(asked.question, { type: "confirm", initial: true, cancel: "reject" })',
  start:
    'prompt(asked.question, { type: "confirm", initial: true, cancel: "undefined" }, "default")',
  secret: "promptSecret(asked.question)",
};

const SECRET = "s3cret-example-value";

/** Each row: the keys typed once the question is on screen, and the line the program prints (the
 *  value the wrapper resolves, or the error it threw). Enter on the confirm takes its initial yes
 *  (the `[Y/n]` contract the auth prompts carried); Ctrl-D is a tty's EOF and follows the cancel
 *  policy, or the opted-in default. */
const ANSWERS: { name: string; kind: keyof typeof ASK; keys: string; printed: string }[] = [
  {
    name: "confirm: Enter takes the initial yes",
    kind: "confirm",
    keys: "\r",
    printed: "RESULT:true",
  },
  { name: "confirm: n answers no", kind: "confirm", keys: "n", printed: "RESULT:false" },
  {
    name: "confirm: Ctrl-C is undefined",
    kind: "confirm",
    keys: CTRL_C,
    printed: "RESULT:undefined",
  },
  {
    name: "confirm: Ctrl-D rejects under cancel reject",
    kind: "strict",
    keys: CTRL_D,
    printed: "ERROR:Prompt cancelled.",
  },
  {
    name: "confirm: Ctrl-D takes the opted-in default",
    kind: "start",
    keys: CTRL_D,
    printed: "RESULT:true",
  },
  {
    name: "secret: the typed line",
    kind: "secret",
    keys: `${SECRET}\r`,
    printed: `RESULT:${SECRET}`,
  },
  {
    name: "secret: Ctrl-C is undefined",
    kind: "secret",
    keys: CTRL_C,
    printed: "RESULT:undefined",
  },
];

const onPosix = test.skipIf(process.platform === "win32");

/** The bytes replayed through a headless terminal of the pty's size: its buffer is the screen,
 *  scrollback included. The buffer read sits behind xterm's proposed-API flag. */
async function screenOf(bytes: string): Promise<string[]> {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  await new Promise<void>((written) => terminal.write(bytes, written));
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    rows.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  terminal.dispose();
  return rows;
}

function askingProgram(dir: string, kind: keyof typeof ASK): string {
  const file = join(dir, "ask.ts");
  writeFileSync(
    file,
    [
      `import { prompt, promptSecret } from ${importSpecifier(join(ROOT, "src", "utils", "prompt.ts"))};`,
      `const asked = ${CHILD_VALUES};`,
      "try {",
      `  const value = await ${ASK[kind]};`,
      '  process.stdout.write("RESULT:" + String(value) + "\\n");',
      "} catch (e) {",
      '  process.stdout.write("ERROR:" + (e instanceof Error ? e.message : String(e)) + "\\n");',
      "}",
    ].join("\n"),
  );
  return file;
}

/** Runs one asking program under a pty (none on Windows), hands `drive` the terminal and what it
 *  has drawn so far, and returns the final screen's non-blank rows once the program printed its
 *  result. */
async function underPty(
  kind: keyof typeof ASK,
  question: string,
  drive: (terminal: Bun.Terminal, seen: () => string) => Promise<void>,
): Promise<string[]> {
  const chunks: Buffer[] = [];
  const seen = (): string => Buffer.concat(chunks).toString("utf8");
  const terminal = new Bun.Terminal({
    cols: COLS,
    rows: ROWS,
    data: (_terminal, data) => {
      chunks.push(Buffer.from(data));
    },
  });
  try {
    const child = spawnChild(process.execPath, {
      args: [...bunRunArgs(), askingProgram(tempDir("prompt-pty-"), kind)],
      // The prompt library picks its glyphs by TERM; pinned so the screen below is the same on
      // every POSIX runner.
      env: { ...childValuesEnv({ question, options: OPTIONS }), TERM: "xterm-256color" },
      terminal,
    });
    step("first frame");
    await until(() => seen().includes(question));
    await drive(terminal, seen);
    step("exit");
    await child.exited;
    await until(() => /RESULT:|ERROR:/.test(seen()));
  } finally {
    terminal.close();
  }
  return (await screenOf(seen())).filter((row) => row.trim() !== "");
}

onPosix(
  "under a real pty, arrowing down a select redraws it in place: the final screen holds the question once, the chosen row once, and nothing of the frames it replaced",
  async () => {
    const rows = await underPty("select", QUESTION, async (terminal, seen) => {
      for (let press = 1; press < OPTIONS.length; press++) {
        const drawn = seen().length;
        terminal.write(DOWN);
        step(`redraw after down ${press}`);
        await until(() => seen().length > drawn);
      }
      terminal.write("\r");
    });
    const rowsNaming = (needle: string): number => rows.filter((r) => r.includes(needle)).length;
    const chosen = OPTIONS[OPTIONS.length - 1] as (typeof OPTIONS)[number];
    expect({
      question: rowsNaming(QUESTION),
      labels: Object.fromEntries(OPTIONS.map((o) => [o.value, rowsNaming(o.label)])),
      last: rows.at(-1),
      // The guide bar, the question, the chosen label, the program's own line.
      rows: rows.length,
    }).toEqual({
      question: 1,
      labels: { alpha: 0, bravo: 0, charlie: 0, delta: 1 },
      last: `RESULT:${chosen.value}`,
      rows: 4,
    });
  },
);

for (const row of ANSWERS) {
  onPosix(
    `under a real pty, ${row.name}, and the typed secret never shows on screen outside the program's own result line`,
    async () => {
      const question = row.kind === "secret" ? "Paste the example value" : "Use the example value?";
      const rows = await underPty(row.kind, question, async (terminal) => {
        terminal.write(row.keys);
      });
      expect({
        last: rows.at(-1),
        echoed: rows.slice(0, -1).some((r) => r.includes(SECRET)),
      }).toEqual({ last: row.printed, echoed: false });
    },
  );
}
