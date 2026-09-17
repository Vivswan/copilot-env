import { createConsola, type LogObject } from "consola";
import stringWidth from "string-width";
import { promptLayout, WrappingReporter, wrapToTerminal } from "../src/utils/logger.ts";
import { expect, test } from "./helpers/testing.ts";

const LEGEND =
  "* = in use: the pin, else the slot's probed identity; what every Direct re-render bakes and a daemon launch sends";

/** A consola instance whose only reporter is the wrapper around a capturing sink, at a fixed
 *  width. */
function capture(width: number): { log: ReturnType<typeof createConsola>; seen: LogObject[] } {
  const seen: LogObject[] = [];
  const log = createConsola({ level: 5 });
  log.options.reporters = [
    new WrappingReporter([{ log: (obj) => seen.push(obj) }], true, () => width, false),
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
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  log.info(gray("   Launch one:  cl --profile <name>  /  cx --profile <name>  /  co"));
  expect(String(seen[1]?.args[0]).split("\n").map((l) => l.replace(ansi, ""))).toEqual([
    "   Launch one:  cl --profile <name>  /  cx --profile",
    "     <name>  /  co",
  ]);
});

/** consola's own fancy reporter writing to a sink, so the decorated lines are measured. */
function fancyAt(
  width: number,
  color = false,
): { log: ReturnType<typeof createConsola>; lines: () => string[] } {
  const out: string[] = [];
  const sink = { write: (s: string) => (out.push(s), true) } as unknown as NodeJS.WriteStream;
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
  return { log, lines: () => out.join("").split("\n").filter((l) => l !== "") };
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
  // Through consola's own reporter with a tag: the tag's gray close lands on the first line, and
  // every continuation line still opens yellow.
  const fancy = fancyAt(40, true);
  fancy.log.withTag("copilot_api.config").warn(
    "one two three four five six seven eight nine ten eleven twelve",
  );
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

test("promptLayout wraps the question under Clack's three-column lead and select labels under five, keeping every option's value", () => {
  const laid = promptLayout(
    "Which Copilot client identity should be pinned for this profile?",
    {
      type: "select",
      options: [
        "gh-env",
        { label: "copilot-developer-cli (GitHub Copilot CLI; accepts PATs)", value: "cli" },
      ],
    },
    40,
  );
  expect(laid.message.split("\n")[0]?.length).toBeLessThanOrEqual(37);
  const [bare, rich] = laid.options?.options ?? [];
  expect(bare).toEqual({ label: "gh-env", value: "gh-env" });
  expect(typeof rich === "object" && rich.value).toBe("cli");
  expect(typeof rich === "object" && rich.label.split("\n")[0]?.length).toBeLessThanOrEqual(35);
  expect(promptLayout("short?", { type: "confirm" }, null)).toEqual({
    message: "short?",
    options: { type: "confirm" },
  });
});
