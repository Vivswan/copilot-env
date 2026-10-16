// What would drift silently: the one shape every multi-part CLI message prints in (a headline,
// indented evidence, a lead, a command table), pinned per part so a caller can trust the layout
// without printing it.
import { scannable } from "../../src/utils/message.ts";
import { wrapMessage } from "../../src/utils/table.ts";
import { expect, test } from "../helpers/testing.ts";

const CYAN = "\x1b[36m";
const CLOSE = "\x1b[39m";

test("scannable renders each part in its place: headline, evidence indented, each lead, actions as a two-column table", () => {
  const rows: Array<{ parts: Parameters<typeof scannable>[0]; lines: string[] }> = [
    { parts: { headline: "gh has no account." }, lines: ["gh has no account."] },
    {
      parts: { headline: "gh refused.", evidence: ["exit 1", "no token"] },
      lines: ["gh refused.", "  exit 1", "  no token"],
    },
    {
      parts: {
        headline: "gh refused.",
        lead: "Pick one:",
        actions: [
          ["gh auth login", "log in again"],
          ["agent auth --gh-user auto", "follow the active account"],
        ],
      },
      lines: [
        "gh refused.",
        "Pick one:",
        "  gh auth login              log in again",
        "  agent auth --gh-user auto  follow the active account",
      ],
    },
    {
      parts: { headline: "gh is old.", lead: "Fix:", actions: [["gh auth login", "log in"]] },
      lines: ["gh is old.", "Fix:", "  gh auth login  log in"],
    },
    {
      parts: { headline: "Stored.", lead: "Then:", actions: [["agent start", "run the proxy"]] },
      lines: ["Stored.", "Then:", "  agent start  run the proxy"],
    },
    // A lead with nothing under it is dropped: it would announce actions that never come.
    { parts: { headline: "Stored.", lead: "Then:" }, lines: ["Stored."] },
    {
      parts: {
        headline: "gh refused.",
        evidence: ["exit 1"],
        lead: "Pick one:",
        actions: [["gh auth login", "log in again"]],
      },
      lines: ["gh refused.", "  exit 1", "Pick one:", "  gh auth login  log in again"],
    },
  ];
  for (const { parts, lines } of rows) {
    expect(scannable({ ...parts, color: false, width: null })).toBe(lines.join("\n"));
  }
});

test("at 80 columns a long description wraps under its own column, never under the command", () => {
  const text = scannable({
    headline: "gh cannot serve account 'octocat' by name.",
    lead: "Pick one:",
    actions: [
      ["gh auth login", "re-login on gh 2.40 or newer, then retry"],
      ["agent profile work auth --gh-user auto", "follow gh's active account (switches with gh)"],
    ],
    color: false,
    width: 80,
  });
  expect(text).toBe(
    [
      "gh cannot serve account 'octocat' by name.",
      "Pick one:",
      "  gh auth login                           re-login on gh 2.40 or newer, then",
      "                                          retry",
      "  agent profile work auth --gh-user auto  follow gh's active account (switches",
      "                                          with gh)",
    ].join("\n"),
  );
});

test("a stacked command wider than the width stays one line through the printer's wrap at that width, and nothing else is marked for it", () => {
  const command = `agent settings --import '/tmp/copilot-env-${"x".repeat(64)}/all.json' --force`;
  const text = scannable({
    headline: "all.json is not a bundle of profile 'work' alone.",
    evidence: ["it carries the default credential"],
    lead: "Pick one:",
    actions: [
      [command, "import the whole store"],
      ["agent profile [<name>] settings --export", "export one profile's bundle"],
    ],
    color: false,
    width: 80,
  });
  const lines = [
    "all.json is not a bundle of profile 'work' alone.",
    "  it carries the default credential",
    "Pick one:",
    `  ${command}`,
    "    import the whole store",
    "",
    "  agent profile [<name>] settings --export",
    "    export one profile's bundle",
  ];
  expect(wrapMessage(text, 80).split("\n")).toEqual(lines);
  // The fitting lines are the text itself: only the command carries the printer's mark.
  expect(text.split("\n").filter((line) => lines.includes(line))).toEqual(
    lines.filter((line) => line !== `  ${command}`),
  );
});

test("color paints only the command cell: the same bytes minus the escapes with color off", () => {
  const parts = {
    headline: "gh refused.",
    evidence: ["exit 1"],
    lead: "Pick one:" as const,
    actions: [["gh auth login", "log in again"]] as [string, string][],
    width: 80,
  };
  const painted = scannable({ ...parts, color: true });
  expect(painted).toBe(
    ["gh refused.", "  exit 1", "Pick one:", `  ${CYAN}gh auth login${CLOSE}  log in again`].join(
      "\n",
    ),
  );
  expect(scannable({ ...parts, color: false })).toBe(
    painted.replaceAll(CYAN, "").replaceAll(CLOSE, ""),
  );
});
