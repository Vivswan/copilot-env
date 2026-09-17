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
    new WrappingReporter([{ log: (obj) => seen.push(obj) }], true, () => width),
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
function fancyAt(width: number): { log: ReturnType<typeof createConsola>; lines: () => string[] } {
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
