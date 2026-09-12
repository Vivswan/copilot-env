export type Align = "left" | "right";

export interface TableOptions {
  header?: string[];
  footer?: string[][];
  aligns?: Align[];
  indent?: string;
}

const GAP = "  ";

function padCell(text: string, width: number, align: Align): string {
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

export function formatTable(body: string[][], options: TableOptions = {}): string[] {
  const { header, footer = [], aligns = [], indent = GAP } = options;
  const rows = [...(header === undefined ? [] : [header]), ...body, ...footer];
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const widths = Array.from(
    { length: columns },
    (_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (row: string[]): string =>
    `${indent}${
      row
        .map((cell, i) => padCell(cell ?? "", widths[i] ?? 0, aligns[i] ?? "left"))
        .join(GAP)
    }`.trimEnd();
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

/** console.log rather than consola: no `i` prefix or timestamp on table lines. */
export function printTable(body: string[][], options?: TableOptions): void {
  for (const line of formatTable(body, options)) {
    console.log(line);
  }
}
