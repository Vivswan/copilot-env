import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

export type Align = "left" | "right";

/** A heading spans the table between record rows (the vendor lines of `agent models`); the records
 *  under one nest a GAP deeper than the heading. */
export type TableRow = string[] | { heading: string };

export interface TableOptions {
  header?: string[];
  footer?: string[][];
  aligns?: Align[];
  /** `true` marks a free-text column that wraps at word boundaries on a narrow terminal; `"hard"`
   *  marks one (paths, ids) whose cells split at the column edge with every character kept.
   *  Every other column keeps its widest cell and only its header may wrap. */
  wrap?: Array<boolean | "hard">;
  indent?: string;
  /** Visible columns to fit; null never wraps. Defaults to the terminal's. */
  width?: number | null;
}

const GAP = "  ";
/** A free-text column never wraps narrower than this; a word-wrapped one nor than its longest word. */
const WRAP_FLOOR = 16;
/** `process.stdout.columns` is 0 on a size-less pty; the same fallback Commander's help uses. */
const TERMINAL_WIDTH_FALLBACK = 80;

/** A TTY's own size wins: an exported COLUMNS goes stale across a resize. COLUMNS is the explicit
 *  width for a pipe (tests, captures); without it a pipe is unbounded so captured output never
 *  wraps. */
export function terminalWidth(stream: NodeJS.WriteStream = process.stdout): number | null {
  if (stream.isTTY) return stream.columns || TERMINAL_WIDTH_FALLBACK;
  const env = Number(process.env.COLUMNS);
  return Number.isInteger(env) && env > 0 ? env : null;
}

/** Wraps at word boundaries so that `indent` + the first line and `hang` + each continuation line
 *  fit `width`; a word wider than its line (a path) splits at the width, its later pieces on
 *  continuation lines. */
export function wrapLine(text: string, width: number | null, indent = "", hang = indent): string[] {
  if (width === null) return [`${indent}${text}`];
  const room = (prefix: string): number => Math.max(1, width - stringWidth(prefix));
  const soft = (chunk: string, prefix: string): string[] =>
    wrapAnsi(chunk, room(prefix)).split("\n");
  const [first = "", ...rest] = soft(text, indent);
  const tail = rest.length === 0 ? [] : soft(rest.join(" "), hang);
  // The soft wrap sets a word wider than its line on a line of its own, so an over-wide line is
  // one word: split it at the width without the spaces a re-wrap of joined pieces would add.
  return [first, ...tail].flatMap((line, i) => {
    const prefix = i === 0 ? indent : hang;
    const pieces = stringWidth(line) > room(prefix)
      ? splitHard(line, room(prefix), room(hang))
      : [line];
    return pieces.map((piece, k) => `${k === 0 ? prefix : hang}${piece}`);
  });
}

/** `word` cut into pieces of at most `firstRoom` columns, then `restRoom`, every character kept. */
function splitHard(word: string, firstRoom: number, restRoom: number): string[] {
  const cut = (text: string, columns: number): string[] =>
    wrapAnsi(text, columns, { hard: true, wordWrap: false, trim: false }).split("\n");
  const [head = "", ...more] = cut(word, firstRoom);
  return more.length === 0 ? [head] : [head, ...cut(more.join(""), restRoom)];
}

/** A line's leading whitespace, looked for behind any ANSI codes that paint the whole line. The
 *  escape byte comes from fromCharCode: a control character in a regex literal is a lint error. */
const LEADING = new RegExp(`^((?:${String.fromCharCode(27)}\\[[0-9;]*m)*)(\\s*)`);

/** Every line of a message wrapped to `width` under its own indent with a hanging continuation
 *  one GAP deeper; `lead` is what the printer puts in front of the first line (a logger's icon).
 *  A line that fits is returned as it came, so table rows pass through untouched. */
export function wrapMessage(text: string, width: number | null, lead = 0): string {
  if (width === null) return text;
  return text.split("\n").flatMap((line, i) => {
    const room = i === 0 ? width - lead : width;
    if (stringWidth(line) <= room) return [line];
    const [prefix = "", paint = "", indent = ""] = LEADING.exec(line) ?? [];
    return wrapLine(`${paint}${line.slice(prefix.length)}`, room, indent, `${indent}${GAP}`);
  }).join("\n");
}

/** console.log for prose lines (status reports, next steps): wrapped to the terminal, unwrapped
 *  down a pipe. */
export function printWrapped(text: string): void {
  console.log(wrapMessage(text, terminalWidth()));
}

/** The stderr twin, for narration beside a command's stdout payload. */
export function printWrappedToStderr(text: string): void {
  process.stderr.write(`${wrapMessage(text, terminalWidth(process.stderr))}\n`);
}

function isHeading(row: TableRow): row is { heading: string } {
  return !Array.isArray(row);
}

function longestWord(cell: string): number {
  return Math.max(0, ...cell.split(" ").map((word) => stringWidth(word)));
}

function padCell(text: string, width: number, align: Align): string {
  const fill = " ".repeat(Math.max(0, width - stringWidth(text)));
  return align === "right" ? `${fill}${text}` : `${text}${fill}`;
}

/** Null when the floors alone do not fit. */
function fitWidths(natural: number[], floors: number[], overflow: number): number[] | null {
  const widths = [...natural];
  for (let left = overflow; left > 0; left--) {
    let widest = -1;
    widths.forEach((w, i) => {
      if (w > (floors[i] ?? 0) && (widest < 0 || w > (widths[widest] ?? 0))) widest = i;
    });
    if (widest < 0) return null;
    widths[widest] = (widths[widest] ?? 0) - 1;
  }
  return widths;
}

export function formatTable(body: TableRow[], options: TableOptions = {}): string[] {
  const {
    header,
    footer = [],
    aligns = [],
    wrap = [],
    indent = GAP,
    width = terminalWidth(),
  } = options;
  const records = body.filter((row): row is string[] => !isHeading(row));
  const cellRows = [...(header === undefined ? [] : [header]), ...records, ...footer];
  const columns = cellRows.reduce((m, r) => Math.max(m, r.length), 0);
  const rowIndent = body.some(isHeading) ? `${indent}${GAP}` : indent;
  const natural = Array.from(
    { length: columns },
    (_, i) => Math.max(...cellRows.map((r) => stringWidth(r[i] ?? ""))),
  );
  const total = stringWidth(rowIndent) + natural.reduce((a, b) => a + b, 0) +
    GAP.length * Math.max(0, columns - 1);
  const floors = natural.map((_, i) => {
    const mode = wrap[i] ?? false;
    return Math.max(
      mode === false ? 0 : WRAP_FLOOR,
      longestWord(header?.[i] ?? ""),
      ...[...records, ...footer].map((r) =>
        mode === true ? longestWord(r[i] ?? "") : mode === "hard" ? 0 : stringWidth(r[i] ?? "")
      ),
    );
  });
  const widths = width === null || total <= width
    ? natural
    : fitWidths(natural, floors, total - width);
  if (widths === null) return formatStacked(body, footer, header, indent, rowIndent, width);

  const fmt = (row: string[]): string[] => {
    const cells = widths.map((w, i) => {
      const cell = row[i] ?? "";
      if (stringWidth(cell) <= w) return [cell];
      // A hard column splits at the edge with every character kept, spaces included.
      return wrap[i] === "hard"
        ? wrapAnsi(cell, w, { hard: true, wordWrap: false, trim: false }).split("\n")
        : wrapAnsi(cell, w, { hard: true }).split("\n");
    });
    const height = Math.max(1, ...cells.map((c) => c.length));
    const last = cells.length - 1;
    // Only padding is trimmed off a line's end: a last cell keeps its own trailing spaces (a hard
    // chunk that ends in them), so it is padded only when right-aligned.
    return Array.from({ length: height }, (_, k) => {
      const texts = cells.map((c) => c[k] ?? "");
      const line = `${rowIndent}${
        texts.map((text, i) =>
          i < last || aligns[i] === "right"
            ? padCell(text, widths[i] ?? 0, aligns[i] ?? "left")
            : text
        ).join(GAP)
      }`;
      return (texts[last] ?? "") === "" ? line.trimEnd() : line;
    });
  };
  const sep = `${rowIndent}${widths.map((w) => "-".repeat(w)).join(GAP)}`.trimEnd();

  const lines: string[] = [];
  if (header !== undefined) {
    lines.push(...fmt(header), sep);
  }
  for (const row of body) {
    lines.push(...(isHeading(row) ? wrapLine(row.heading, width, indent, rowIndent) : fmt(row)));
  }
  if (footer.length > 0) {
    lines.push(sep);
    for (const row of footer) {
      lines.push(...fmt(row));
    }
  }
  return lines;
}

/** The layout for a terminal narrower than the column floors: one block per record. */
function formatStacked(
  body: TableRow[],
  footer: string[][],
  header: string[] | undefined,
  indent: string,
  rowIndent: string,
  width: number | null,
): string[] {
  const label = (i: number, cell: string): string =>
    header?.[i] === undefined ? cell : `${header[i]}: ${cell}`;
  const lines: string[] = [];
  let previous: "none" | "heading" | "record" = "none";
  for (const row of [...body, ...footer]) {
    if (previous === "record") lines.push("");
    if (isHeading(row)) {
      lines.push(...wrapLine(row.heading, width, indent, rowIndent));
      previous = "heading";
      continue;
    }
    const [first = "", ...rest] = row;
    lines.push(...wrapLine(label(0, first), width, rowIndent, `${rowIndent}${GAP}`));
    rest.forEach((cell, j) => {
      if (cell === "") return;
      lines.push(
        ...wrapLine(label(j + 1, cell), width, `${rowIndent}${GAP}`, `${rowIndent}${GAP}${GAP}`),
      );
    });
    previous = "record";
  }
  return lines;
}

/** console.log rather than consola: no `i` prefix or timestamp on table lines. */
export function printTable(body: TableRow[], options?: TableOptions): void {
  for (const line of formatTable(body, options)) {
    console.log(line);
  }
}
