// UTF-16 code-unit string order, the one sort every listing and table uses: `localeCompare` reads
// the process locale, so two machines would print the same rows in two orders.

/** A comparator for `Array.prototype.sort` over strings by UTF-16 code unit (JavaScript's own `<`). */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
