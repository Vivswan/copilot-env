// Aligned plain-text table rendering shared by the CLI's tabular output
// (`agent cost`, `agent auth --list`, `agent config --get`).

export type Align = "left" | "right";

/** Layout options for formatTable/printTable. */
export interface TableOptions {
  /** Header row, rendered above a dashed separator. */
  header?: string[];
  /** Footer rows, rendered below a second dashed separator. */
  footer?: string[][];
  /** Per-column alignment; unlisted columns are left-aligned. */
  aligns?: Align[];
  /** Prefix for every line. Defaults to two spaces. */
  indent?: string;
}

const GAP = "  ";

function padCell(text: string, width: number, align: Align): string {
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

/**
 * Render an aligned text table as lines: the optional header row and a dashed
 * separator, the body rows, then (when footer rows are present) a second
 * separator and the footer. Every cell is padded to the widest entry in its
 * column and each line is trimmed of trailing whitespace.
 */
export function formatTable(body: string[][], options: TableOptions = {}): string[] {
  const { header, footer = [], aligns = [], indent = GAP } = options;
  const rows = [...(header === undefined ? [] : [header]), ...body, ...footer];
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (row: string[]): string =>
    `${indent}${row
      .map((cell, i) => padCell(cell ?? "", widths[i] ?? 0, aligns[i] ?? "left"))
      .join(GAP)}`.trimEnd();
  const sep = `${indent}${widths.map((w) => "-".repeat(w)).join(GAP)}`.trimEnd();

  const lines: string[] = [];
  if (header !== undefined) {
    lines.push(fmt(header), sep);
  }
  for (const row of body) {
    lines.push(fmt(row));
  }
  if (footer.length > 0) {
    lines.push(sep);
    for (const row of footer) {
      lines.push(fmt(row));
    }
  }
  return lines;
}

/**
 * Print formatTable's lines to stdout with console.log directly, so output is
 * clean -- no consola `i` prefix or trailing timestamp.
 */
export function printTable(body: string[][], options?: TableOptions): void {
  for (const line of formatTable(body, options)) {
    console.log(line);
  }
}
