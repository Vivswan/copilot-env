// What would drift silently: the one shape every multi-part CLI message prints in (a headline,
// indented evidence, a lead, a command table), pinned per part so a caller can trust the layout
// without printing it, and laid out by the printer for its own stream's width.
import {
  caught,
  ScannableError,
  ScannableMessage,
  type ScannableParts,
  scannable,
} from "../../src/utils/message.ts";
import { withColumns } from "../helpers/columns.ts";
import { expect, test } from "../helpers/testing.ts";

/** The SGR open the colored action column is painted in. */
const CYAN = "\x1b[36m";

/** The SGR close that restores the default foreground. */
const CLOSE = "\x1b[39m";

/** A gh account refusal with two actions: the headline, lead, and table shape. */
const PICK_ONE: ScannableParts = {
  headline: "gh cannot serve account 'octocat' by name.",
  lead: "Pick one:",
  actions: [
    ["gh auth login", "re-login on gh 2.40 or newer, then retry"],
    ["agent profile work auth --gh-user auto", "follow gh's active account (switches with gh)"],
  ],
  color: false,
};

/** The Claude profile writer's refusal of a settings-<name>.json it does not manage. */
const REFUSAL: ScannableParts = {
  headline: "settings-work.json is wired to something copilot-env does not manage.",
  evidence: ["overwrite refused"],
  lead: "Pick one:",
  actions: [
    ["agent profile <other-name> add", "a different profile name, so a different file"],
    ["remove the file first", "then rerun this command"],
  ],
  color: false,
};

test("scannable renders each part in its place: headline, evidence indented, each lead, actions as a two-column table", () => {
  const rows: Array<{ parts: ScannableParts; lines: string[] }> = [
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
    expect(scannable({ ...parts, color: false }).render(null)).toBe(lines.join("\n"));
  }
});

test("at 80 columns a long description wraps under its own column, never under the command", () => {
  expect(scannable(PICK_ONE).render(80)).toBe(
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

// The specimen: `agent auth --check` prints its status on stdout while every other message lands
// on stderr, so a message laid out once at stderr's width was wrong for a narrower stdout.
test("the printer's width wins: the same message fits 80 columns in two columns and 40 stacked, the headline wrapped and the command row whole in both", () => {
  const message = scannable(PICK_ONE);
  expect(message.fit(80)).toBe(message.render(80));
  expect(message.fit(40).split("\n")).toEqual([
    "gh cannot serve account 'octocat' by",
    "  name.",
    "Pick one:",
    "  gh auth login",
    "    re-login on gh 2.40 or newer, then",
    "      retry",
    "",
    "  agent profile work auth --gh-user auto",
    "    follow gh's active account (switches",
    "      with gh)",
  ]);
});

// The specimen: `agent profile work settings --import <a temp path>/all.json --force` at 80
// columns printed its recovery command across two lines, and a copy of it ran with the wrong
// arguments.
test("a stacked command wider than the width stays one line through fit at that width, with no mark in the text for a printer to strip", () => {
  const command = `agent settings --import '/tmp/copilot-env-${"x".repeat(64)}/all.json' --force`;
  const fitted = scannable({
    headline: "all.json is not a bundle of profile 'work' alone.",
    evidence: ["it carries the default credential"],
    lead: "Pick one:",
    actions: [
      [command, "import the whole store"],
      ["agent profile [<name>] settings --export", "export one profile's bundle"],
    ],
    color: false,
  }).fit(80);
  expect(fitted.split("\n")).toEqual([
    "all.json is not a bundle of profile 'work' alone.",
    "  it carries the default credential",
    "Pick one:",
    `  ${command}`,
    "    import the whole store",
    "",
    "  agent profile [<name>] settings --export",
    "    export one profile's bundle",
  ]);
  expect(/[^\n\x20-\x7e]/.test(fitted)).toBe(false);
});

test("a string context gets the render at stderr's width, an Error's message the same, and neither carries a mark", async () => {
  const message = scannable(PICK_ONE);
  await withColumns(60, () => {
    expect(String(message)).toBe(message.render(60));
    expect(`${message}`).not.toBe(message.render(null));
    expect(new ScannableError(PICK_ONE).message).toBe(message.render(60));
  });
  expect(/[^\n\x20-\x7e]/.test(new ScannableError(PICK_ONE).message)).toBe(false);
  expect(new ScannableError(PICK_ONE)).toBeInstanceOf(Error);
});

// A catch site used to interpolate the caught error's message into its sentence, which turned a
// thrown scannable back into a string a printer then wrapped, command row included.
test("caught keeps a thrown scannable's parts inside the catch site's sentence, rendering as the old interpolation did, and frames any other error's message", async () => {
  const frame = (message: string): string => `could not sync profile 'work': ${message}`;
  await withColumns(60, () => {
    const error = new ScannableError(PICK_ONE);
    const reported = caught(error, frame);
    expect(reported).toBeInstanceOf(ScannableMessage);
    expect(String(reported)).toBe(frame(error.message));
  });
  expect(String(caught(new ScannableError(PICK_ONE), frame)).split("\n")[0]).toBe(
    "could not sync profile 'work': gh cannot serve account 'octocat' by name.",
  );
  expect(caught(new Error("disk full"), frame)).toBe("could not sync profile 'work': disk full");
  // A frame with a tail closes around the headline and the parts follow it; the interpolation it
  // replaces closed after the table's last row, a parenthesis the reader had to find.
  const framed = caught(
    new ScannableError(PICK_ONE),
    (message) => `launching anyway (${message}).`,
  );
  const [first = "", ...rest] = String(framed).split("\n");
  expect(first).toBe("launching anyway (gh cannot serve account 'octocat' by name.).");
  expect(rest).toEqual(String(scannable(PICK_ONE)).split("\n").slice(1));
});

// The specimen: `agent profile work sync --claude` at a 20-column stderr printed the refusal's
// command as "agent profile" over "<other-name> add", because the wiring collector had joined the
// thrown message into one string under its own sentence.
test("a collected failure is evidence with parts of its own, laid out beneath the headline one indent deeper, its lead and table with it, and its command rows whole at 20 columns", () => {
  const composed = scannable({
    headline: "could not wire profile 'work':",
    evidence: [caught(new ScannableError(REFUSAL), (message) => `Claude: ${message}`)],
    color: false,
  });
  expect(composed.render(100).split("\n")).toEqual([
    "could not wire profile 'work':",
    "  Claude: settings-work.json is wired to something copilot-env does not manage.",
    "    overwrite refused",
    "  Pick one:",
    "    agent profile <other-name> add  a different profile name, so a different file",
    "    remove the file first           then rerun this command",
  ]);
  const narrow = composed.fit(20).split("\n");
  expect(narrow.slice(0, 2)).toEqual(["could not wire", "  profile 'work':"]);
  expect(narrow.filter((line) => line.length > 20)).toEqual([
    "    agent profile <other-name> add",
    "    remove the file first",
  ]);
  // The stacked table's blank line between its records stays blank under the indent.
  expect(narrow.filter((line) => line !== line.trimEnd())).toEqual([]);
  // A plain error's failure is a prose fact beside it.
  const mixed = scannable({
    headline: "could not wire profile 'work':",
    evidence: [
      caught(new ScannableError(REFUSAL), (message) => `Claude: ${message}`),
      caught(new Error("disk full"), (message) => `Codex: ${message}`),
    ],
    color: false,
  });
  expect(mixed.render(100).split("\n").slice(-2)).toEqual([
    "    remove the file first           then rerun this command",
    "  Codex: disk full",
  ]);
});

test("color paints only the command cell: the same bytes minus the escapes with color off", () => {
  const parts: ScannableParts = {
    headline: "gh refused.",
    evidence: ["exit 1"],
    lead: "Pick one:",
    actions: [["gh auth login", "log in again"]],
  };
  const painted = scannable({ ...parts, color: true }).render(80);
  expect(painted).toBe(
    ["gh refused.", "  exit 1", "Pick one:", `  ${CYAN}gh auth login${CLOSE}  log in again`].join(
      "\n",
    ),
  );
  expect(scannable({ ...parts, color: false }).render(80)).toBe(
    painted.replaceAll(CYAN, "").replaceAll(CLOSE, ""),
  );
});
