import { expect, test } from "bun:test";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

// Enforce: the codebase is ASCII everywhere EXCEPT inside string / template literal
// TEXT, which carries user-facing output (boxes, arrows, check marks, ...). Non-ASCII
// in a comment, identifier, regex, or `${}` expression (the usual culprit: a generated
// em dash or a "double arrow" U+21D4) is flagged.
//
// For .ts/.js files we PARSE with the TypeScript compiler and collect the source
// ranges of string/template-literal text, then flag any non-ASCII char outside them.
// Parsing (not a hand lexer) is what makes this reliable around regex literals, where
// a `/'/`-style pattern would otherwise be mistaken for a string. Non-code files
// (shell, toml, bin scripts) must be pure ASCII. This file is itself pure ASCII.

const ROOTS = ["src", "test", "scripts", "bin", "shell"];
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const TS_EXTS = new Set([".ts", ".mts", ".cts", ".tsx", ".mjs", ".js", ".jsx"]);
const OTHER_EXTS = new Set([".sh", ".ps1", ".bashrc", ".toml"]);
const NUL = String.fromCharCode(0);

function* walk(dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

// `bin/` holds extensionless scripts (e.g. `agent`); scan those too.
function scannable(file: string, root: string): boolean {
  return TS_EXTS.has(extname(file)) || OTHER_EXTS.has(extname(file)) || root === "bin";
}

const STRING_TEXT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** [start, end) source offsets of every string/template-literal text token. */
function stringRanges(sf: ts.SourceFile): [number, number][] {
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (STRING_TEXT_KINDS.has(node.kind)) ranges.push([node.getStart(sf), node.end]);
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return ranges;
}

function nonAsciiOffsets(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) out.push(i);
  return out;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function codePoint(text: string, off: number): string {
  return (text.codePointAt(off) ?? 0).toString(16).toUpperCase().padStart(4, "0");
}

function checkTsFile(file: string, text: string, offenders: string[]): void {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const ranges = stringRanges(sf);
  const inString = (off: number) => ranges.some(([s, e]) => off >= s && off < e);
  for (const off of nonAsciiOffsets(text)) {
    if (!inString(off)) offenders.push(`${file}:${lineOf(text, off)} U+${codePoint(text, off)}`);
  }
}

test("source is ASCII outside string literals (non-ASCII allowed only in user output)", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const isTs = TS_EXTS.has(extname(file));
      if (!scannable(file, root)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes(NUL)) continue; // binary
      if (isTs) checkTsFile(file, text, offenders);
      else
        for (const off of nonAsciiOffsets(text))
          offenders.push(`${file}:${lineOf(text, off)} U+${codePoint(text, off)}`);
    }
  }
  expect(offenders).toEqual([]);
});
