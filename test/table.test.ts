import { formatTable, wrapLine } from "../src/utils/table.ts";
import { expect, test } from "./helpers/testing.ts";

test("formatTable pads columns and aligns per column", () => {
  const lines = formatTable(
    [
      ["a", "10"],
      ["longer", "5"],
    ],
    { header: ["name", "count"], aligns: ["left", "right"] },
  );
  expect(lines).toEqual([
    "  name    count",
    "  ------  -----",
    "  a          10",
    "  longer      5",
  ]);
});

test("formatTable renders footer rows below a second separator", () => {
  const lines = formatTable([["row", "1"]], {
    header: ["h", "n"],
    footer: [["sum", "1"]],
  });
  expect(lines).toEqual(["  h    n", "  ---  -", "  row  1", "  ---  -", "  sum  1"]);
});

test("formatTable trims every line, including separators", () => {
  // A zero-width final column: no line may carry trailing whitespace.
  const lines = formatTable([["x", ""]], { header: ["h", ""], footer: [["f", ""]] });
  for (const line of lines) {
    expect(line).toBe(line.trimEnd());
  }
});

test("formatTable handles ragged rows and an empty body", () => {
  expect(formatTable([["only"], ["two", "cells"]])).toEqual(["  only", "  two   cells"]);
  expect(formatTable([], { footer: [["f"]] })).toEqual(["  -", "  f"]);
  expect(formatTable([])).toEqual([]);
});

test("formatTable honors a custom indent", () => {
  expect(formatTable([["a"]], { indent: "" })).toEqual(["a"]);
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

// The floors (25 + 23 + 34 + 22 + gaps) exceed 100 columns: one block per record, empty cells
// skipped, a blank line between records.
const STACKED_AT_100 = [
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
    { width: 120, lines: WRAPPED_AT_120 },
    { width: 100, lines: STACKED_AT_100 },
  ];
  for (const { width, lines } of cases) {
    const rendered = formatTable(IDENTITIES.body, { ...IDENTITIES.options, width });
    expect(rendered).toEqual(lines);
    if (width !== null) {
      expect(Math.max(...rendered.map((l) => l.length))).toBeLessThanOrEqual(width);
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
