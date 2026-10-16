import { stripVTControlCharacters } from "node:util";
import { createConsola, type LogObject } from "consola";
import stringWidth from "string-width";
import {
  createStderrLogger,
  taggedLogger,
  WrappingReporter,
  withNarrationMuted,
  wrapToTerminal,
} from "../../src/utils/logger.ts";
import { scannable } from "../../src/utils/message.ts";
import { captureChannels } from "../helpers/output.ts";
import { expect, test } from "../helpers/testing.ts";

const LEGEND =
  "* = in use: the pin, else the slot's probed identity; what every Direct re-render bakes and a daemon launch sends";

/** A consola instance whose only reporter is the wrapper around a capturing sink, at a fixed
 *  width. */
function capture(
  width: number,
  color = false,
): { log: ReturnType<typeof createConsola>; seen: LogObject[] } {
  const seen: LogObject[] = [];
  const log = createConsola({ level: 5 });
  log.options.reporters = [
    new WrappingReporter([{ log: (obj) => seen.push(obj) }], true, () => width, color),
  ];
  return { log, seen };
}

test("the wrapping reporter leaves room for the icon on the first line and hangs continuations under the line's own indent, behind a leading ANSI code too", () => {
  const { log, seen } = capture(60);
  log.info(`${LEGEND}\n  Slot: not probed yet on this host, the next daemon start probes it`);
  expect(seen[0]?.args).toEqual([
    [
      // 58 columns: the icon and its space take the first line's other two.
      "* = in use: the pin, else the slot's probed identity; what",
      "  every Direct re-render bakes and a daemon launch sends",
      "  Slot: not probed yet on this host, the next daemon start",
      "    probes it",
    ].join("\n"),
  ]);
  // A painted line keeps its indent: the ANSI code sits in front of the spaces.
  const gray = (text: string): string => `\x1b[90m${text}\x1b[39m`;
  log.info(gray("   Launch one:  cl --profile <name>  /  cx --profile <name>  /  co"));
  expect(
    String(seen[1]?.args[0])
      .split("\n")
      .map((l) => stripVTControlCharacters(l)),
  ).toEqual(["   Launch one:  cl --profile <name>  /  cx --profile", "     <name>  /  co"]);
});

// The specimen: `agent profile work settings --import <a temp path>/all.json --force` at 80
// columns printed its recovery command across two lines, and a copy of it ran with the wrong
// arguments.
test("a scannable's command wider than the terminal reaches the sink on one line while its headline and evidence wrap, and a plain line that wide still wraps", () => {
  const command = `agent settings --import '/tmp/copilot-env-${"x".repeat(64)}/all.json' --force`;
  const parts = {
    headline:
      "all.json is not a bundle of profile 'work' alone: it carries more than that profile's section.",
    evidence: [
      "it carries the default credential, the default wiring modes, and the preferences of every other profile",
    ],
    lead: "Pick one:" as const,
    actions: [
      [command, "import the whole store"],
      ["agent profile [<name>] settings --export", "export one profile's bundle"],
    ] as [string, string][],
    width: 80,
  };
  const printed = [
    "all.json is not a bundle of profile 'work' alone: it carries more than",
    "  that profile's section.",
    "  it carries the default credential, the default wiring modes, and the",
    "    preferences of every other profile",
    "Pick one:",
    `  ${command}`,
    "    import the whole store",
    "",
    "  agent profile [<name>] settings --export",
    "    export one profile's bundle",
  ];
  for (const color of [false, true]) {
    const { log, seen } = capture(80, color);
    log.error(scannable({ ...parts, color }));
    const raw = String(seen[0]?.args[0]);
    // Nothing but the text and, with color, its escapes: no mark reaches the sink.
    const visible = color ? stripVTControlCharacters(raw) : raw;
    expect(/[^\n\x20-\x7e]/.test(visible)).toBe(false);
    expect(visible.split("\n")).toEqual(printed);
  }

  const { log, seen } = capture(80);
  log.error(`${command}\nnext`);
  const plain = String(seen[0]?.args[0]).split("\n");
  expect(plain.length).toBeGreaterThan(2);
  expect(Math.max(...plain.map((l) => stringWidth(l)))).toBeLessThanOrEqual(80);
});

/** consola's own fancy reporter writing to a sink, so the decorated lines are measured. */
function fancyAt(
  width: number,
  color = false,
): { log: ReturnType<typeof createConsola>; lines: () => string[] } {
  const out: string[] = [];
  const sink = {
    write: (s: string) => {
      out.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const log = wrapToTerminal(
    createConsola({
      level: 5,
      fancy: true,
      stdout: sink,
      stderr: sink,
      formatOptions: { date: false, colors: false, columns: width },
    }),
    color,
    () => width,
  );
  return {
    log,
    lines: () =>
      out
        .join("")
        .split("\n")
        .filter((l) => l !== ""),
  };
}

test("with consola's fancy reporter no decorated line exceeds the width: icon, WARN and ERROR badges, a tag, and a box frame", () => {
  const { log, lines } = fancyAt(40);
  const prose = "one two three four five six seven eight nine ten eleven twelve thirteen";
  log.info(prose);
  log.warn(prose);
  log.error(prose);
  log.withTag("copilot_api.config").warn(prose);
  log.box(`${prose}\n${prose}`);
  expect(Math.max(...lines().map((l) => stringWidth(l)))).toBeLessThanOrEqual(40);
  // The badge lines really carry the badge, so the width they respect is the decorated one.
  expect(lines().some((l) => l.includes(" WARN ") && l.includes("one two"))).toBe(true);
  expect(lines().some((l) => l.includes(" ERROR ") && l.includes("one two"))).toBe(true);
});

test("with color on, the whole wrapped warning body is yellow, an inline backtick command is cyan and the yellow re-opens after it, and info stays unpainted", () => {
  const seen: LogObject[] = [];
  const log = createConsola({ level: 5 });
  log.options.reporters = [
    new WrappingReporter([{ log: (obj) => seen.push(obj) }], true, () => 40, true),
  ];
  const esc = String.fromCharCode(27);
  const yellow = `${esc}[33m`;
  const cyan = `${esc}[36m`;
  const close = `${esc}[39m`;
  log.warn("one two three four five six seven eight; run `agent health` next");
  // Each wrapped line is its own yellow span (consola closes the foreground after the first
  // line's tag); the command is cyan, then yellow again.
  expect(seen[0]?.args).toEqual([
    `${yellow}one two three four five six seven${close}\n${yellow}  eight; run ${cyan}agent health${close}${yellow} next${close}`,
  ]);
  log.info("plain");
  expect(seen[1]?.args).toEqual(["plain"]);
  // A command that ends the text leaves no empty span behind it.
  log.warn("check `agent health`");
  expect(String(seen[2]?.args[0]).endsWith(`${cyan}agent health${close}${close}`)).toBe(true);
  // Through consola's own reporter with a tag: the tag's gray close lands on the first line, and
  // every continuation line still opens yellow.
  const fancy = fancyAt(40, true);
  fancy.log
    .withTag("copilot_api.config")
    .warn("one two three four five six seven eight nine ten eleven twelve");
  const all = fancy.lines();
  const body = all.slice(all.findIndex((l) => l.includes("one two")));
  expect(body.length).toBeGreaterThan(1);
  expect(body.every((l) => l.includes(yellow))).toBe(true);
  // A command split by the wrap is cyan on both of its lines (wrap-ansi re-opens the span).
  const split = capture(25);
  split.log.options.reporters = [
    new WrappingReporter([{ log: (obj) => split.seen.push(obj) }], true, () => 25, true),
  ];
  split.log.warn("Run `agent health --scope full` next");
  const [first = "", second = "", ...rest] = String(split.seen[0]?.args[0]).split("\n");
  expect(first).toContain(`${cyan}agent health`);
  expect(second).toContain(`${yellow}  ${cyan}--scope full${close}`);
  expect(rest.some((l) => l.startsWith(yellow) && l.includes("next"))).toBe(true);
  // A caller's own span across a raw newline is re-opened on the second line.
  split.log.warn(`${cyan}agent\nhealth${close} next`);
  expect(String(split.seen[1]?.args[0]).split("\n")[1]).toBe(
    `${yellow}${cyan}health${close}${yellow} next${close}`,
  );
});

// The import's preview runs the wiring once on the fs overlay; its narration belongs to the real
// run after the confirmation, including a logger a module creates mid-run (a catalog fetch's) and
// a tagged child, which copies its parent's muted level.
test("withNarrationMuted silences the loggers made before it and inside it, tagged ones included, and all print again after", async () => {
  const before = createStderrLogger();
  let inside: ReturnType<typeof createStderrLogger> | null = null;
  let tagged: ReturnType<typeof taggedLogger> | null = null;
  const { all } = await captureChannels(async () => {
    await withNarrationMuted(async () => {
      before.log("before: muted");
      inside = createStderrLogger();
      inside.log("inside: muted");
      tagged = taggedLogger("preview");
      tagged.log("tagged: muted");
      await Promise.resolve();
    });
    before.log("before: after");
    inside?.log("inside: after");
    tagged?.log("tagged: after");
  });
  expect(all).not.toContain("muted");
  expect(all).toContain("before: after");
  expect(all).toContain("inside: after");
  expect(all).toContain("tagged: after");
});
