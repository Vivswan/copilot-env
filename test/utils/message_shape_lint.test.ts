// What would drift silently: a headline the terminal wraps mid-thought, a headline of two
// sentences, or a lead with nothing under it (and rows with no lead) prints as a paragraph again,
// which the census of PR #523 converted away. The scanner is swept over src/, and its teeth are
// pinned against doctored specimens at the budget's edges.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT } from "../../src/utils/root.ts";
import { expect, test } from "../helpers/testing.ts";
import { tsFilesUnder } from "../helpers/tree.ts";
import { type Rule, scanMessageShape } from "../lint/message_shape.ts";

/** The path the specimens are scanned under; the scanner uses it to parse, never to filter. */
const SPECIMEN = "src/commands/example.ts";

/** The budget's edges as literals, never derived from the scanner's constants: 71 columns pass. */
const H71 = "the default profile could not be wired for either agent; nothing moved.";

/** One column more than H71: 72 fail. */
const H72 = "the default profile could not be wired for either agent; nothing stayed.";

function rules(source: string): Rule[] {
  return scanMessageShape(SPECIMEN, source)
    .map((finding) => finding.rule)
    .sort();
}

test("every literal scannable and ScannableError headline under src/ is one sentence under 72 columns, with a lead exactly where there are rows", () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(join(PROJECT_ROOT, "src"))) {
    const path = relative(PROJECT_ROOT, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    for (const finding of scanMessageShape(path, source)) {
      const line = source.slice(0, finding.start).split("\n").length;
      offenders.push(`${path}:${line} ${finding.rule}: ${finding.message}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the scanner fails a headline at 72 columns and passes one at 71, measures a placeholder at its label maximum or its const's string, reads a lead against its rows, and skips what is not literal", () => {
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the rows are source text under test
  const rows: Array<[string, Rule[]]> = [
    [`scannable({ headline: '${H71}' })`, []],
    [`scannable({ headline: '${H72}' })`, ["budget"]],
    [`new ScannableError({ headline: '${H72}' })`, ["budget"]],
    [`const H = '${H72}'; scannable({ headline: H })`, ["budget"]],
    // A placeholder named in the label table takes its maximum: 32 for a profile name.
    ["scannable({ headline: `profile '${name}' is ready.` })", []],
    [
      "scannable({ headline: `profile '${name}' is wired for Direct, and the proxy is left as it was.` })",
      ["budget"],
    ],
    ["scannable({ headline: `port ${port} is busy; pick another one below.` })", []],
    // A placeholder bound to a string const of the file takes that string.
    ["const WHAT = 'the proxy'; scannable({ headline: `${WHAT} did not start.` })", []],
    [
      "const WHAT = 'the proxy daemon copilot-env manages for every profile on this machine'; scannable({ headline: `${WHAT} did not start.` })",
      ["budget"],
    ],
    // one-sentence: one terminal mark at the end; a colon or a second sentence is not.
    ["scannable({ headline: 'gh refused' })", ["one-sentence"]],
    ["scannable({ headline: 'could not wire the default profile:' })", ["one-sentence"]],
    ["scannable({ headline: 'gh refused. Log in again.' })", ["one-sentence"]],
    ["scannable({ headline: 'gh 2.40 refused?' })", []],
    ["scannable({ headline: `gh refused ${name}` })", []],
    // lead-iff-actions over literal fields.
    ["scannable({ headline: 'Stored.', lead: 'Then:' })", ["lead-iff-actions"]],
    ["scannable({ headline: 'Stored.', lead: 'Then:', actions: [] })", ["lead-iff-actions"]],
    [
      "scannable({ headline: 'Stored.', actions: [['agent start', 'run it']] })",
      ["lead-iff-actions"],
    ],
    ["scannable({ headline: 'Stored.', lead: 'Then:', actions: [['agent start', 'run it']] })", []],
    // Not literal, so skipped: a call, a member, a let, a parts helper, a spread (before or after
    // a field), a conditional lead or actions, a const name declared twice with two strings, a
    // name that is only an inherited property of the label table.
    ["scannable({ headline: describe(x) })", []],
    ["scannable({ headline: `${cli.name} on PATH shadows the new install.` })", []],
    [`let H = '${H72}'; scannable({ headline: H })`, []],
    ["scannable(credentialMissParts(x))", []],
    ["scannable({ ...parts, lead: 'Then:' })", []],
    ["scannable({ headline: 'Stored.', lead: ok ? 'Then:' : 'Fix:', actions: [] })", []],
    ["scannable({ headline: 'Stored.', lead: 'Then:', actions: rowsFor(x) })", []],
    ["scannable({ headline: 'Stored.', lead: 'Then:', actions: [...more] })", []],
    ["const parts = { headline: 'Stored.' }; scannable({ headline: 'gh refused', ...parts })", []],
    [
      "function a() { const name = 'first'; } function b() { const name = 'second'; scannable({ headline: `gh refused ${name} today` }); }",
      [],
    ],
    ["const toString = describe(x); scannable({ headline: `gh refused ${toString} today` })", []],
  ];
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: the rows are source text under test
  for (const [source, expected] of rows) expect(rules(source), source).toEqual(expected);
});
