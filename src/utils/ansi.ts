let colorDecided: boolean | null = null;

/** Whether output is painted: read from the environment on the first call, never at import, so a
 *  process without env permission (the compile script's module graph) can load this module. For
 *  renderers that pad layouts and must know whether widths include escapes. */
export function colorEnabled(): boolean {
  if (colorDecided === null) {
    const env = process.env;
    colorDecided = !(
      env.NO_COLOR === "1" || env.TERM === "dumb" || env.TEST || env.CI || !process.stdout.isTTY
    );
  }
  return colorDecided;
}

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

const ESC = "\x1b[";
/** The close every foreground tone shares. */
export const FG_CLOSE = `${ESC}39m`;

export function sgrOpen(tone: Tone): string {
  return `${ESC}${SGR[tone][0]}m`;
}

function sgr(tone: Tone): Paint {
  const [open, close] = SGR[tone];
  return (text: string): string => `${ESC}${open}m${text}${ESC}${close}m`;
}

/** The palette ungated: for a renderer that resolves colorEnabled() once at its edge (the survey of
 *  `agent profile identity`), so a test can force color on and pin what the escapes wrap. */
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

/** Every tone as identity: what a renderer paints with when `color` is off. */
const plainPalette: Record<Tone, Paint> = Object.fromEntries(
  Object.keys(palette).map((tone) => [tone, (text: string) => text]),
) as Record<Tone, Paint>;

/** The palette a renderer resolves once from its `color` argument (the command edge's
 *  colorEnabled(), or a test's override): never the gated helpers, which read the environment. */
export function paintFor(color: boolean): Record<Tone, Paint> {
  return color ? palette : plainPalette;
}

function gated(paint: Paint): Paint {
  return (text: string): string => (colorEnabled() ? paint(text) : text);
}

export const bold = gated(palette.bold);
export const blue = gated(palette.blue);
export const cyan = gated(palette.cyan);
export const gray = gated(palette.gray);
export const green = gated(palette.green);
export const red = gated(palette.red);

/** The tone of a status word that is data, not a log level: what `agent health` rows, the profile
 *  table, and the start/stop lines say about a thing. Green is healthy, yellow needs a hand, red
 *  failed, dim is absent or idle; any other word keeps its color. */
const STATUS_TONES: ReadonlyArray<readonly [RegExp, Tone]> = [
  // `registered (current)` ends in a non-word character, where `\b` cannot sit.
  [/^(ok|up|running|accepted|authenticated|wired|complete)\b|^registered \(current\)/i, "green"],
  [
    /^(warn|incomplete|no credential|not running|not authenticated|not registered|registered by|stale|partial)\b/i,
    "yellow",
  ],
  [/^(fail|failed|rejected|refused|error|broken|could not read)\b/i, "red"],
  [/^(down|stopped|-|none|unset|<unset>)$/i, "dim"],
];

/** `color` is the command edge's colorEnabled(), so a renderer never reads the environment and a
 *  test can force the escapes on. */
export function statusPaint(word: string, color: boolean): string {
  if (!color) return word;
  const tone = STATUS_TONES.find(([pattern]) => pattern.test(word))?.[1];
  return tone === undefined ? word : palette[tone](word);
}
