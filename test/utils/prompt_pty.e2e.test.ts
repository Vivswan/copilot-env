// What would drift silently: how a select redraws depends on the runtime's tty streams and the
// prompt library's renderer, and nothing in the repository pins either. Under Bun, consola's own
// prompt left the previous frame on screen after every arrow key (the sink quirk beside `prompt`
// in src/utils/prompt.ts). Only a real pty shows it: down a pipe nothing is echoed.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const COLS = 80;

/**
 * The terminal's view of a byte stream: a grid as wide as the pty, the cursor moves a redraw
 * relies on, and the autowrap a real terminal does past the last column. Colors and cursor
 * visibility change nothing on the grid.
 *   CSI n A / B      -> cursor up / down n rows
 *   CSI n C / D / G  -> cursor right / left n columns, to column n
 *   CSI J, CSI K     -> erase from the cursor to the end of the screen, of the row
 */
class Screen {
  private readonly grid: string[][] = [];
  private x = 0;
  private y = 0;
  private wrapPending = false;

  constructor(private readonly cols: number) {}

  rows(): string[] {
    return this.grid.map((row) => row.join("").trimEnd());
  }

  feed(bytes: string): void {
    const csi = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])`, "y");
    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i] as string;
      if (ch === ESC) {
        csi.lastIndex = i;
        const m = csi.exec(bytes);
        if (m === null) {
          i += 2;
        } else {
          this.control(m[1] ?? "", m[2] ?? "");
          i = csi.lastIndex;
        }
      } else if (ch === "\r") {
        this.x = 0;
        this.wrapPending = false;
        i++;
      } else if (ch === "\n") {
        this.y++;
        this.wrapPending = false;
        i++;
      } else {
        this.put(ch);
        i++;
      }
    }
  }

  private put(ch: string): void {
    if (this.wrapPending) {
      this.x = 0;
      this.y++;
      this.wrapPending = false;
    }
    const row = this.grid[this.y] ?? [];
    this.grid[this.y] = row;
    while (row.length < this.x) row.push(" ");
    row[this.x] = ch;
    if (this.x + 1 < this.cols) this.x++;
    else this.wrapPending = true;
  }

  private control(params: string, final: string): void {
    const erase = final === "J" || final === "K";
    const n = Number.parseInt(params, 10) || (erase ? 0 : 1);
    this.wrapPending = false;
    switch (final) {
      case "A":
        this.y = Math.max(0, this.y - n);
        break;
      case "B":
        this.y += n;
        break;
      case "C":
        this.x = Math.min(this.cols - 1, this.x + n);
        break;
      case "D":
        this.x = Math.max(0, this.x - n);
        break;
      case "G":
        this.x = n - 1;
        break;
      case "J":
        if (n === 0) {
          this.grid[this.y]?.splice(this.x);
          this.grid.length = Math.min(this.grid.length, this.y + 1);
        }
        break;
      case "K":
        if (n === 0) this.grid[this.y]?.splice(this.x);
        else if (n === 2) this.grid[this.y] = [];
        break;
      default:
        break;
    }
  }
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
      rows: 24,
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
    const screen = new Screen(COLS);
    screen.feed(seen());
    const rows = screen.rows().filter((row) => row.trim() !== "");
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
