const NO_COLOR = (() => {
  const env = process.env;
  return Boolean(
    env.NO_COLOR === "1" || env.TERM === "dumb" || env.TEST || env.CI || !process.stdout.isTTY,
  );
})();

/** For renderers that pad layouts and must know whether widths include escapes. */
export const COLOR_ENABLED = !NO_COLOR;

type Paint = (text: string) => string;

/** SGR open/close pairs; a tone's open code is reachable on its own for a painter that must
 *  re-open the tone after an inner close (the logger's message body around an inline cyan). */
const SGR = {
  bold: [1, 22],
  dim: [2, 22],
  blue: [34, 39],
  cyan: [36, 39],
  gray: [90, 39],
  green: [32, 39],
  yellow: [33, 39],
  red: [31, 39],
} as const;

export type Tone = keyof typeof SGR;

export const ESC = "\x1b[";
/** The close every foreground tone shares. */
export const FG_CLOSE = `${ESC}39m`;

export function sgrOpen(tone: Tone): string {
  return `${ESC}${SGR[tone][0]}m`;
}

function sgr(tone: Tone): Paint {
  const [open, close] = SGR[tone];
  return (text: string): string => `${ESC}${open}m${text}${ESC}${close}m`;
}

/** The palette ungated: for a renderer that resolves COLOR_ENABLED once at its edge (the survey of
 *  `agent auth --identities`), so a test can force color on and pin what the escapes wrap. */
export const palette: Record<Tone, Paint> = {
  bold: sgr("bold"),
  dim: sgr("dim"),
  blue: sgr("blue"),
  cyan: sgr("cyan"),
  gray: sgr("gray"),
  green: sgr("green"),
  yellow: sgr("yellow"),
  red: sgr("red"),
};

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

/** The tone of a status word that is data, not a log level: what `agent health` rows, the profile
 *  table, and the start/stop lines say about a thing. Green is healthy, yellow needs a hand, red
 *  failed, dim is absent or idle; any other word keeps its color. */
const STATUS_TONES: ReadonlyArray<readonly [RegExp, keyof typeof palette]> = [
  [/^(ok|up|running|accepted|authenticated|wired|complete)\b/, "green"],
  [/^(warn|incomplete|no credential|not running|not authenticated|stale|partial)\b/, "yellow"],
  [/^(fail|failed|rejected|refused|error|broken)\b/, "red"],
  [/^(down|stopped|-|none|unset|<unset>)$/, "dim"],
];

/** `color` is the command edge's COLOR_ENABLED, so a renderer never reads the environment and a
 *  test can force the escapes on. */
export function statusPaint(word: string, color: boolean): string {
  if (!color) return word;
  const tone = STATUS_TONES.find(([pattern]) => pattern.test(word))?.[1];
  return tone === undefined ? word : palette[tone](word);
}
