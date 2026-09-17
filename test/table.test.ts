import { formatTable, terminalWidth, wrapLine } from "../src/utils/table.ts";
import { expect, test } from "./helpers/testing.ts";

test("formatTable pads and aligns per column, separates header and footer rows, trims every line, and takes ragged rows, an empty body, and a custom indent", () => {
  const rows: Array<
    { body: string[][]; options?: Parameters<typeof formatTable>[1]; lines: string[] }
  > = [
    {
      body: [["a", "10"], ["longer", "5"]],
      options: { header: ["name", "count"], aligns: ["left", "right"] },
      lines: ["  name    count", "  ------  -----", "  a          10", "  longer      5"],
    },
    {
      body: [["row", "1"]],
      options: { header: ["h", "n"], footer: [["sum", "1"]] },
      lines: ["  h    n", "  ---  -", "  row  1", "  ---  -", "  sum  1"],
    },
    // A zero-width final column: no line carries trailing whitespace, separators included.
    {
      body: [["x", ""]],
      options: { header: ["h", ""], footer: [["f", ""]] },
      lines: ["  h", "  -", "  x", "  -", "  f"],
    },
    { body: [["only"], ["two", "cells"]], lines: ["  only", "  two   cells"] },
    { body: [], options: { footer: [["f"]] }, lines: ["  -", "  f"] },
    { body: [], lines: [] },
    { body: [["a"]], options: { indent: "" }, lines: ["a"] },
  ];
  for (const { body, options, lines } of rows) {
    expect(formatTable(body, options)).toEqual(lines);
  }
});

// --- terminal width ---------------------------------------------------------------------------

/** The `agent auth --identities` table: three fixed columns whose headers carry a host, and a
 *  free-text note column. */
const IDENTITIES = {
  body: [
    [
      "codex",
      "rejected (400)",
      "-",
      "Direct default: no Copilot-Integration-Id header (auto only)",
    ],
    [
      "copilot-developer-cli",
      "accepted (5 models)",
      "accepted (37 models) *",
      "GitHub Copilot CLI; accepts fine-grained PATs",
    ],
    ["copilot-developer-sandbox", "accepted (2 models)", "rejected (400)", ""],
    ["vscode-chat", "-", "rejected (400)", "proxy default (copilot-api's own identity)"],
  ],
  options: {
    header: [
      "identity",
      "Direct (api.githubcopilot.com)",
      "Proxy (api.enterprise.githubcopilot.com)",
      "note",
    ],
    wrap: [false, false, false, true],
    indent: "",
  },
};

const WIDE = [
  "identity                   Direct (api.githubcopilot.com)  Proxy (api.enterprise.githubcopilot.com)  note",
  "-------------------------  ------------------------------  ----------------------------------------  " +
  "------------------------------------------------------------",
  "codex                      rejected (400)                  -                                         " +
  "Direct default: no Copilot-Integration-Id header (auto only)",
  "copilot-developer-cli      accepted (5 models)             accepted (37 models) *                    " +
  "GitHub Copilot CLI; accepts fine-grained PATs",
  "copilot-developer-sandbox  accepted (2 models)             rejected (400)",
  "vscode-chat                -                               rejected (400)                            " +
  "proxy default (copilot-api's own identity)",
];

// The note column gives way first, down to its longest word; the fixed columns keep every body
// cell and only their headers wrap; the underline follows the shrunken widths.
const WRAPPED_AT_120 = [
  "identity                   Direct                       Proxy                               note",
  "                           (api.githubcopilot.com)      (api.enterprise.githubcopilot.com)",
  "-------------------------  ---------------------------  ----------------------------------  ----------------------------",
  "codex                      rejected (400)               -                                   Direct default: no",
  "                                                                                            Copilot-Integration-Id",
  "                                                                                            header (auto only)",
  "copilot-developer-cli      accepted (5 models)          accepted (37 models) *              GitHub Copilot CLI; accepts",
  "                                                                                            fine-grained PATs",
  "copilot-developer-sandbox  accepted (2 models)          rejected (400)",
  "vscode-chat                -                            rejected (400)                      proxy default (copilot-api's",
  "                                                                                            own identity)",
];

// One column short of the natural 161: the note column alone gives up the column.
const WRAPPED_AT_160 = [
  WIDE[0] ?? "",
  "-------------------------  ------------------------------  ----------------------------------------  " +
  "-----------------------------------------------------------",
  "codex                      rejected (400)                  -                                         " +
  "Direct default: no Copilot-Integration-Id header (auto",
  "                                                                                                     only)",
  WIDE[3] ?? "",
  WIDE[4] ?? "",
  WIDE[5] ?? "",
];

// The floors (25 + 23 + 34 + 22 + gaps) exceed 100 columns: one block per record, empty cells
// skipped, a blank line between records; 80 stacks the same blocks.
const STACKED = [
  "identity: codex",
  "  Direct (api.githubcopilot.com): rejected (400)",
  "  Proxy (api.enterprise.githubcopilot.com): -",
  "  note: Direct default: no Copilot-Integration-Id header (auto only)",
  "",
  "identity: copilot-developer-cli",
  "  Direct (api.githubcopilot.com): accepted (5 models)",
  "  Proxy (api.enterprise.githubcopilot.com): accepted (37 models) *",
  "  note: GitHub Copilot CLI; accepts fine-grained PATs",
  "",
  "identity: copilot-developer-sandbox",
  "  Direct (api.githubcopilot.com): accepted (2 models)",
  "  Proxy (api.enterprise.githubcopilot.com): rejected (400)",
  "",
  "identity: vscode-chat",
  "  Direct (api.githubcopilot.com): -",
  "  Proxy (api.enterprise.githubcopilot.com): rejected (400)",
  "  note: proxy default (copilot-api's own identity)",
];

test("formatTable fits the width: natural when it fits or off a TTY, word-wrapped note column below that, stacked below the floors", () => {
  const cases: Array<{ width: number | null; lines: string[] }> = [
    { width: 200, lines: WIDE },
    { width: null, lines: WIDE },
    { width: 160, lines: WRAPPED_AT_160 },
    { width: 120, lines: WRAPPED_AT_120 },
    { width: 100, lines: STACKED },
    { width: 80, lines: STACKED },
  ];
  for (const { width, lines } of cases) {
    const rendered = formatTable(IDENTITIES.body, { ...IDENTITIES.options, width });
    expect(rendered).toEqual(lines);
    if (width !== null) {
      expect(Math.max(...rendered.map((l) => l.length))).toBeLessThanOrEqual(width);
    }
  }
});

test("a hard-wrap column splits a path at its own edge, spaces kept, where a word-wrap column would stack the table", () => {
  const path = "/Users/Jane  Doe/Library/Application  Support/copilot-env/logs/api.log";
  const body = [["Logs:", path], ["PID:", "1"]];
  const hard = formatTable(body, { indent: "", wrap: [false, "hard"], width: 40 });
  expect(hard).toEqual([
    "Logs:  /Users/Jane  Doe/Library/Applicat",
    "       ion  Support/copilot-env/logs/api",
    "       .log",
    "PID:   1",
  ]);
  // The double spaces survive the split at every width, including a split that lands right after
  // them (45: the chunk ends in the two spaces, which the line keeps): the rows rejoin to the path
  // byte for byte.
  for (const width of [40, 45, 50]) {
    const rows = formatTable([["Logs:", path]], { indent: "", wrap: [false, "hard"], width });
    expect(rows.map((line) => line.slice(7)).join("")).toBe(path);
  }
  // A path without spaces has no word boundary a word-wrap column may use: the floors do not fit,
  // and the stacked cell splits at the width too rather than spill.
  const spaceless = "/home/me/.local/share/copilot-env/logs/copilot-api.log";
  expect(formatTable([["Logs:", spaceless], ["PID:", "1"]], {
    indent: "",
    wrap: [false, true],
    width: 40,
  })).toEqual([
    "Logs:",
    "  /home/me/.local/share/copilot-env/logs",
    "    /copilot-api.log",
    "",
    "PID:",
    "  1",
  ]);
});

test("terminalWidth takes a TTY's own size over COLUMNS, and COLUMNS only for a pipe", () => {
  const saved = process.env.COLUMNS;
  const stub = (key: "isTTY" | "columns", value: boolean | number): void => {
    Object.defineProperty(process.stdout, key, { value, configurable: true });
  };
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  try {
    process.env.COLUMNS = "200";
    stub("isTTY", true);
    stub("columns", 100);
    expect(terminalWidth()).toBe(100);
    stub("isTTY", false);
    process.env.COLUMNS = "100";
    expect(terminalWidth()).toBe(100);
    delete process.env.COLUMNS;
    expect(terminalWidth()).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = saved;
    for (const [key, desc] of [["isTTY", isTTY], ["columns", columns]] as const) {
      if (desc === undefined) delete (process.stdout as unknown as Record<string, unknown>)[key];
      else Object.defineProperty(process.stdout, key, desc);
    }
  }
});

test("heading rows nest their records one gap deeper in both layouts, and ANSI codes never count toward a width", () => {
  const cyan = (text: string): string => `\x1b[36m${text}\x1b[39m`;
  const body = [{ heading: "OpenAI" }, [cyan("gpt-5.5"), "GPT-5.5"], [cyan("o3"), "o3"]];
  expect(formatTable(body, { indent: "   ", width: null })).toEqual([
    "   OpenAI",
    `     ${cyan("gpt-5.5")}  GPT-5.5`,
    `     ${cyan("o3")}       o3`,
  ]);
  // Stacked (the floors need 21 columns): the records still sit under their heading.
  expect(formatTable(body, { indent: "   ", width: 20 })).toEqual([
    "   OpenAI",
    `     ${cyan("gpt-5.5")}`,
    "       GPT-5.5",
    "",
    `     ${cyan("o3")}`,
    "       o3",
  ]);
});

test("wrapLine breaks at word boundaries under the indent with a hanging continuation, and never off a TTY", () => {
  const text =
    "copilot-developer-sandbox on Proxy: 400 Personal Access Tokens are not supported for this endpoint";
  // 2 + 98 columns: a line that fills the width exactly stays whole.
  expect(wrapLine(text, 100, "  ", "    ")).toEqual([`  ${text}`]);
  expect(wrapLine(text, 99, "  ", "    ")).toEqual([
    "  copilot-developer-sandbox on Proxy: 400 Personal Access Tokens are not supported for this",
    "    endpoint",
  ]);
  // The first line is measured under its own indent, not the hang: the identity fills it whole.
  expect(wrapLine(text, 27, "  ", "    ")).toEqual([
    "  copilot-developer-sandbox",
    "    on Proxy: 400 Personal",
    "    Access Tokens are not",
    "    supported for this",
    "    endpoint",
  ]);
  expect(wrapLine(text, null, "  ", "    ")).toEqual([`  ${text}`]);
});
