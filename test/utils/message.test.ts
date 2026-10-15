// What would drift silently: the one shape every multi-part CLI message prints in (a headline,
// indented evidence, a lead, a command table), pinned per part so a caller can trust the layout
// without printing it.
import { scannable } from "../../src/utils/message.ts";
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
