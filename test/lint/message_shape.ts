// Every scannable({...}) and new ScannableError({...}) under src/ whose headline the scanner reads
// as a literal (a string, a template whose placeholders are names in the label table or consts
// of this file bound to a string, or such a const) is one sentence under HEADLINE_COLUMNS with
// every placeholder at its label maximum, and a literal `lead` sits exactly where a literal
// `actions` array has a row. Anything the scanner cannot read as a literal is skipped: a
// headline from a call or a member, a parts object from a helper, a spread, a `let`. Run over
// src/ by test/utils/message_shape_lint.test.ts, which fails on any finding.
import type { Expression, ObjectExpression } from "oxc-parser";
import stringWidth from "string-width";
import { parseModule, visit } from "../helpers/syntax.ts";

/** A headline at this many columns fails, one fewer passes; test/utils/message_shape_lint.test.ts pins the edge. */
const HEADLINE_COLUMNS = 72;

/** The widest value a placeholder so named takes: a profile name, a GitHub login, a port, a version, a count. */
const LABEL_MAXIMUM: ReadonlyMap<string, number> = new Map([
  ["profile", 32],
  ["name", 32],
  ["login", 39],
  ["user", 39],
  ["port", 5],
  ["version", 12],
  ["count", 6],
]);

/** Stands in for a placeholder where the sentence rule reads the text. */
const PLACEHOLDER_MARK = "X";

export type Rule = "budget" | "one-sentence" | "lead-iff-actions";

/** One finding; `start` is the offset of the maker call in the source. */
export interface ShapeFinding {
  start: number;
  rule: Rule;
  message: string;
}

/** A headline as read: its text with each placeholder marked, its columns with each placeholder
 *  at its maximum, and whether it ends in a placeholder (so the sentence rule cannot see its end). */
interface Headline {
  text: string;
  columns: number;
  openEnded: boolean;
}

/** The string consts of a file by name; a name declared twice with different strings is null. */
type StringConsts = Map<string, string | null>;

function stringConsts(path: string, source: string): StringConsts {
  const consts: StringConsts = new Map();
  visit(parseModule(path, source).program, {
    VariableDeclaration(node) {
      if (node.kind !== "const") return;
      for (const { id, init } of node.declarations) {
        if (
          id.type !== "Identifier" ||
          init?.type !== "Literal" ||
          typeof init.value !== "string"
        ) {
          continue;
        }
        const known = consts.get(id.name);
        consts.set(id.name, known === undefined || known === init.value ? init.value : null);
      }
    },
  });
  return consts;
}

/** A placeholder's text and columns: a string or number literal, a name in the label table at
 *  its maximum, a string const of the file; null for anything else. */
function placeholder(node: Expression, consts: StringConsts): [string, number] | null {
  if (
    node.type === "Literal" &&
    (typeof node.value === "string" || typeof node.value === "number")
  ) {
    const text = String(node.value);
    return [text, stringWidth(text)];
  }
  if (node.type !== "Identifier") return null;
  const bound = consts.get(node.name);
  if (typeof bound === "string") return [bound, stringWidth(bound)];
  // A name declared twice with different strings is no label either: it is skipped.
  const max = bound === null ? undefined : LABEL_MAXIMUM.get(node.name);
  return max === undefined ? null : [PLACEHOLDER_MARK, max];
}

/** The headline as read, or null for one the scanner cannot read as a literal. */
function headlineOf(node: Expression, consts: StringConsts): Headline | null {
  if (node.type === "Literal" && typeof node.value === "string") {
    return { text: node.value, columns: stringWidth(node.value), openEnded: false };
  }
  if (node.type === "Identifier") {
    const bound = consts.get(node.name);
    return typeof bound === "string"
      ? { text: bound, columns: stringWidth(bound), openEnded: false }
      : null;
  }
  if (node.type !== "TemplateLiteral") return null;
  let text = "";
  let columns = 0;
  for (const [i, quasi] of node.quasis.entries()) {
    const literal = quasi.value.cooked ?? quasi.value.raw;
    text += literal;
    columns += stringWidth(literal);
    const expression = node.expressions[i];
    if (expression === undefined) continue;
    const read = placeholder(expression, consts);
    if (read === null) return null;
    text += read[0];
    columns += read[1];
  }
  const last = node.quasis.at(-1);
  return { text, columns, openEnded: last !== undefined && last.value.cooked === "" };
}

function literalLead(value: Expression): string | undefined {
  return value.type === "Literal" && typeof value.value === "string" ? value.value : undefined;
}

/** `actions` as its row count; undefined for a value that is no array literal, or one with a
 *  spread. */
function literalActionRows(value: Expression): number | undefined {
  if (value.type !== "ArrayExpression") return undefined;
  if (value.elements.some((row) => row?.type === "SpreadElement")) return undefined;
  return value.elements.length;
}

/** The literal fields of a parts object: `lead` as its string, `actions` as its row count; a
 *  field written otherwise is undefined. A spread, a string key, or a literal computed key leaves
 *  no field literal; a computed identifier key (`[k]`) is read as the name it spells, a stated
 *  limit no src maker reaches. An absent field is no lead and no rows. */
function fieldsOf(parts: ObjectExpression): {
  headline?: Expression;
  lead?: string | null;
  actions?: number;
} {
  const fields: { headline?: Expression; lead?: string | null; actions?: number } = {
    lead: null,
    actions: 0,
  };
  for (const property of parts.properties) {
    if (property.type !== "Property" || property.key.type !== "Identifier") return {};
    const { value } = property;
    if (property.key.name === "headline") fields.headline = value as Expression;
    if (property.key.name === "lead") fields.lead = literalLead(value);
    if (property.key.name === "actions") fields.actions = literalActionRows(value);
  }
  return fields;
}

function judge(start: number, parts: ObjectExpression, consts: StringConsts): ShapeFinding[] {
  const findings: ShapeFinding[] = [];
  const { headline, lead, actions } = fieldsOf(parts);
  const read = headline === undefined ? null : headlineOf(headline, consts);
  if (read !== null) {
    if (read.columns >= HEADLINE_COLUMNS) {
      findings.push({
        start,
        rule: "budget",
        message: `the headline takes ${read.columns} columns, not under ${HEADLINE_COLUMNS}: "${read.text}"`,
      });
    }
    const marks = read.text.match(/[.!?](?=\s|$)/g) ?? [];
    const ended = /[.!?]$/.test(read.text) || read.openEnded;
    if (!ended || marks.length > 1) {
      findings.push({
        start,
        rule: "one-sentence",
        message: `the headline is not one sentence ending in a terminal mark: "${read.text}"`,
      });
    }
  }
  if (lead !== undefined && actions !== undefined && (lead !== null) !== actions > 0) {
    findings.push({
      start,
      rule: "lead-iff-actions",
      message:
        lead === null
          ? "actions with no lead above them"
          : `lead "${lead}" with no actions under it`,
    });
  }
  return findings;
}

/** Every finding under the three rules in `source`. */
export function scanMessageShape(path: string, source: string): ShapeFinding[] {
  const consts = stringConsts(path, source);
  const findings: ShapeFinding[] = [];
  const inspect = (callee: Expression, args: unknown[], start: number, maker: string): void => {
    const [parts] = args as Expression[];
    if (callee.type !== "Identifier" || callee.name !== maker) return;
    if (parts === undefined || parts.type !== "ObjectExpression") return;
    findings.push(...judge(start, parts, consts));
  };
  visit(parseModule(path, source).program, {
    CallExpression(node) {
      inspect(node.callee, node.arguments, node.start, "scannable");
    },
    NewExpression(node) {
      inspect(node.callee, node.arguments, node.start, "ScannableError");
    },
  });
  return findings;
}
