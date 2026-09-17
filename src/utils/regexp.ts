/** The one RegExp-escape: every metacharacter, the backslash included, so a literal (a command
 *  line, a workflow URL, a config key) can be embedded in a pattern as itself. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
