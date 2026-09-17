const NO_COLOR = (() => {
  const env = process.env;
  return Boolean(
    env.NO_COLOR === "1" || env.TERM === "dumb" || env.TEST || env.CI || !process.stdout.isTTY,
  );
})();

/** For renderers that pad layouts and must know whether widths include escapes. */
export const COLOR_ENABLED = !NO_COLOR;

type Paint = (text: string) => string;

function sgr(open: number, close: number): Paint {
  return (text: string): string => `\x1b[${open}m${text}\x1b[${close}m`;
}

/** The palette ungated: for a renderer that resolves COLOR_ENABLED once at its edge (the survey of
 *  `agent auth --identities`), so a test can force color on and pin what the escapes wrap. */
export const palette = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  blue: sgr(34, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  red: sgr(31, 39),
} as const;

function gated(paint: Paint): Paint {
  return (text: string): string => (NO_COLOR ? text : paint(text));
}

export const bold = gated(palette.bold);
export const dim = gated(palette.dim);
export const blue = gated(palette.blue);
export const cyan = gated(palette.cyan);
export const gray = gated(palette.gray);
export const green = gated(palette.green);
export const yellow = gated(palette.yellow);
export const red = gated(palette.red);
