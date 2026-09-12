const NO_COLOR = (() => {
  const env = process.env;
  return Boolean(
    env.NO_COLOR === "1" || env.TERM === "dumb" || env.TEST || env.CI || !process.stdout.isTTY,
  );
})();

export function style(open: number, close = 39): (text: string) => string {
  return (text: string): string => (NO_COLOR ? text : `\x1b[${open}m${text}\x1b[${close}m`);
}

/** For renderers that pad layouts and must know whether widths include escapes. */
export const COLOR_ENABLED = !NO_COLOR;

export const bold = style(1, 22);
export const dim = style(2, 22);
export const blue = style(34);
export const cyan = style(36);
export const gray = style(90);
export const green = style(32);
export const yellow = style(33);
export const red = style(31);
