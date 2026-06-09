// Shared ANSI styling with NO_COLOR/CI/TEST gating, used by the CLI help screen
// and the `agent health` report so both style identically and the gating lives in
// one place. Color codes mirror citty's own (its src/_color.ts) so the hand-rolled
// help screen matches citty-rendered subcommand help.
const NO_COLOR = (() => {
  const env = process.env;
  return Boolean(env.NO_COLOR === "1" || env.TERM === "dumb" || env.TEST || env.CI);
})();

/** SGR wrapper: `open`s the style and `close`s it, unless color is disabled. */
export function style(open: number, close = 39): (text: string) => string {
  return (text: string): string => (NO_COLOR ? text : `[${open}m${text}[${close}m`);
}

export const bold = style(1, 22);
export const underline = style(4, 24);
export const cyan = style(36);
export const gray = style(90);
export const green = style(32);
export const yellow = style(33);
export const red = style(31);
