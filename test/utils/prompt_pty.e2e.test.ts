// What would drift silently: how a select redraws depends on the runtime's tty streams and the
// prompt library's renderer, and nothing in the repository pins either. Under Bun, consola's own
// prompt left the previous frame on screen after every arrow key (the sink quirk beside `prompt`
// in src/utils/prompt.ts). Only a real pty shows it: down a pipe nothing is echoed.

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
const COLS = 80;
const ROWS = 24;

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

function askingProgram(dir: string): string {
  const file = join(dir, "ask.ts");
  writeFileSync(
    file,
    [
      `import { prompt } from ${importSpecifier(join(ROOT, "src", "utils", "prompt.ts"))};`,
      `const asked = ${CHILD_VALUES};`,
      'const value = await prompt(asked.question, { type: "select", options: asked.options, cancel: "reject" });',
      'process.stdout.write("RESULT:" + String(value) + "\\n");',
    ].join("\n"),
  );
  return file;
}

test.skipIf(process.platform === "win32")(
  "under a real pty (none on Windows), arrowing down a select redraws it in place: the final screen holds the question once, the chosen row once, and nothing of the frames it replaced",
  async () => {
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
        args: [...bunRunArgs(), askingProgram(tempDir("prompt-pty-"))],
        // The prompt library picks its glyphs by TERM; pinned so the screen below is the same on
        // every POSIX runner.
        env: {
          ...childValuesEnv({ question: QUESTION, options: OPTIONS }),
          TERM: "xterm-256color",
        },
        terminal,
      });
      step("first frame");
      await until(() => seen().includes(QUESTION));
      for (let press = 1; press < OPTIONS.length; press++) {
        const drawn = seen().length;
        terminal.write(DOWN);
        step(`redraw after down ${press}`);
        await until(() => seen().length > drawn);
      }
      terminal.write("\r");
      step("exit");
      await child.exited;
      await until(() => seen().includes("RESULT:"));
    } finally {
      terminal.close();
    }
    const rows = (await screenOf(seen())).filter((row) => row.trim() !== "");
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
