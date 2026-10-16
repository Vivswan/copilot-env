// A message that reads its width at the render (terminalWidth over stderr, src/utils/table.ts)
// sees COLUMNS: the launcher pipes stderr, and node_env.ts starts every test process without the
// variable, so a layout row sets it for the call alone.

/** `fn` runs with COLUMNS set to `columns`; the variable goes back to what it was, unset included. */
export async function withColumns<T>(columns: number, fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.COLUMNS;
  process.env.COLUMNS = String(columns);
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = saved;
  }
}
