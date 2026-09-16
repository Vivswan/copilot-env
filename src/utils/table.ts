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
  /** Free-text columns that wrap on a narrow terminal; every other column keeps its widest cell
   *  and only its header may wrap. */
  wrap?: boolean[];
  indent?: string;
  /** Visible columns to fit; null never wraps. Defaults to the terminal's. */
  width?: number | null;
}

const GAP = "  ";
/** A free-text column never wraps narrower than this, nor than its longest word. */
const WRAP_FLOOR = 16;
/** `process.stdout.columns` is 0 on a size-less pty; the same fallback Commander's help uses. */
const TERMINAL_WIDTH_FALLBACK = 80;

/** COLUMNS is the explicit override (and the test seam), a TTY reports its size, and a pipe is
 *  unbounded so captured output never wraps. */
export function terminalWidth(): number | null {
  const env = Number(process.env.COLUMNS);
  if (Number.isInteger(env) && env > 0) return env;
  if (!process.stdout.isTTY) return null;
  return process.stdout.columns || TERMINAL_WIDTH_FALLBACK;
}

/** Wraps at word boundaries so that `indent` + the first line and `hang` + each continuation line
 *  fit `width`; a word longer than its line overflows rather than splits. */
export function wrapLine(text: string, width: number | null, indent = "", hang = indent): string[] {
  if (width === null) return [`${indent}${text}`];
  const fit = (chunk: string, prefix: string): string[] =>
    wrapAnsi(chunk, Math.max(1, width - stringWidth(prefix))).split("\n");
  const [first = "", ...rest] = fit(text, indent);
  const tail = rest.length === 0 ? [] : fit(rest.join(" "), hang);
  return [`${indent}${first}`, ...tail.map((line) => `${hang}${line}`)];
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
  const floors = natural.map((_, i) =>
    Math.max(
      wrap[i] === true ? WRAP_FLOOR : 0,
      longestWord(header?.[i] ?? ""),
      ...[...records, ...footer].map((r) =>
        wrap[i] === true ? longestWord(r[i] ?? "") : stringWidth(r[i] ?? "")
      ),
    )
  );
  const widths = width === null || total <= width
    ? natural
    : fitWidths(natural, floors, total - width);
  if (widths === null) return formatStacked(body, footer, header, indent, rowIndent, width);

  const fmt = (row: string[]): string[] => {
    const cells = widths.map((w, i) => {
      const cell = row[i] ?? "";
      return stringWidth(cell) > w ? wrapAnsi(cell, w, { hard: true }).split("\n") : [cell];
    });
    const height = Math.max(1, ...cells.map((c) => c.length));
    return Array.from(
      { length: height },
      (_, k) =>
        `${rowIndent}${
          cells.map((c, i) => padCell(c[k] ?? "", widths[i] ?? 0, aligns[i] ?? "left")).join(GAP)
        }`.trimEnd(),
    );
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
