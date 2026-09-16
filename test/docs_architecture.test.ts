// The architecture page names real code: every mermaid box that starts a segment with a path
// names a file that exists and, after it, only symbols that file exports (as `deno doc` reads
// them); every concept diagram has a `Demonstrated by:` line whose links resolve to a test or a
// smoke scenario; the concept count is pinned; and the GENERATED module map equals a fresh render
// of architecture.json. Existence only: a caption box is not checked, and a demonstration link is
// checked to resolve, not to test its claim.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATED_BEGIN,
  GENERATED_END,
  readArchitecture,
  renderArchitectureMap,
  spliceGeneratedRegion,
} from "./lint/architecture.ts";
import { ROOT, runSync } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

const PAGE = join("docs", "architecture.md");
/** Changes only when a concept diagram is added or removed on purpose: a fence a stray edit
 *  swallowed would otherwise vanish from every other check here. */
const CONCEPT_DIAGRAMS = 7;

const page = readFileSync(join(ROOT, PAGE), "utf8").replaceAll("\r\n", "\n").split("\n");

interface Fence {
  /** Zero-based line of the opening fence. */
  line: number;
  mermaid: boolean;
  body: string;
  /** Inside the GENERATED region: the declaration's diagram, not the author's. */
  generated: boolean;
}

/** The page's fences, and which lines are page text (headings and demonstration lines are read
 *  from those only, so a quoted example never steers the walk). */
function readPage(lines: readonly string[]): { fences: Fence[]; text: (string | undefined)[] } {
  const fences: Fence[] = [];
  const text: (string | undefined)[] = [];
  let open: { line: number; mermaid: boolean; body: string[] } | null = null;
  let generated = false;
  for (const [index, line] of lines.entries()) {
    if (open === null) {
      if (line === GENERATED_BEGIN) generated = true;
      if (line === GENERATED_END) generated = false;
      const fence = /^```(\w*)\s*$/.exec(line);
      if (fence !== null) {
        open = { line: index, mermaid: fence[1] === "mermaid", body: [] };
        text.push(undefined);
      } else {
        text.push(line);
      }
      continue;
    }
    text.push(undefined);
    if (/^```\s*$/.test(line)) {
      fences.push({ ...open, body: open.body.join("\n"), generated });
      open = null;
    } else {
      open.body.push(line);
    }
  }
  expect(open).toBeNull();
  return { fences, text };
}

const { fences, text } = readPage(page);
const concepts = fences.filter((fence) => fence.mermaid && !fence.generated);

// --- labels ------------------------------------------------------------------

const PATH_ROOTS = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name);
const PATH_TOKEN = new RegExp(`^(?:${PATH_ROOTS.join("|")})/[\\w./-]+$`);
const SYMBOL_TOKEN = /^[A-Za-z_$][\w$]*(?:\(\))?$/;

interface Claim {
  label: string;
  path: string;
  /** The names after the path, `()` stripped. */
  symbols: string[];
}

/** The (path, symbols) claims one label makes, per `<br>` segment: a segment opening with a path
 *  binds it and the rest are its exported symbols; a segment with no path continues the bound
 *  path's symbols, or is a caption when nothing is bound yet. Malformed segments are problems. */
function readLabel(label: string): { claims: Claim[]; problems: string[] } {
  const claims: Claim[] = [];
  const problems: string[] = [];
  let bound: string | undefined;
  for (const segment of label.split("<br>")) {
    const tokens = segment.trim().split(/[\s,]+/).filter((token) => token !== "");
    const [head] = tokens;
    let path: string;
    let names: string[];
    if (head !== undefined && PATH_TOKEN.test(head)) {
      path = head;
      names = tokens.slice(1);
    } else if (bound !== undefined) {
      path = bound;
      names = tokens;
    } else {
      // A caption; a slash or a call shape in one is a mistyped path, not a caption.
      if (segment.includes("()") || segment.includes("/")) {
        problems.push(`"${label}": "${segment.trim()}" looks like code but reads as a caption`);
      }
      continue;
    }
    bound = path;
    const symbols: string[] = [];
    for (const name of names) {
      if (SYMBOL_TOKEN.test(name)) symbols.push(name.replace(/\(\)$/, ""));
      else problems.push(`"${label}": "${name}" is neither a symbol nor a path`);
    }
    claims.push({ label, path, symbols });
  }
  return { claims, problems };
}

interface DenoDoc {
  nodes: Record<
    string,
    { symbols?: { name: string; declarations: { declarationKind: string }[] }[] }
  >;
}

/** The exported names of each TypeScript file, as `deno doc --json` reads them: `export { a as b }`
 *  is b, `export * from` carries the target's names, a re-export keeps the exported name. */
function exportedNames(files: readonly string[]): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  if (files.length === 0) return byFile;
  const result = runSync(Deno.execPath(), ["doc", "--json", ...files], { cwd: ROOT });
  if (result.exitCode !== 0) throw new Error(`deno doc failed: ${result.stderr}`);
  for (const [url, entry] of Object.entries((JSON.parse(result.stdout) as DenoDoc).nodes)) {
    const file = relative(ROOT, fileURLToPath(url)).replaceAll("\\", "/");
    const names = (entry.symbols ?? [])
      .filter((symbol) => symbol.declarations.some((d) => d.declarationKind === "export"))
      .map((symbol) => symbol.name);
    byFile.set(file, new Set(names));
  }
  return byFile;
}

// --- the tests -------------------------------------------------------------------

test("every mermaid box names a file that exists and symbols it exports", () => {
  const problems: string[] = [];
  const claims: (Claim & { at: string })[] = [];
  for (const fence of fences.filter((fence) => fence.mermaid)) {
    const at = `${PAGE}:${fence.line + 1}`;
    // A node is an id followed by an opening shape run (`[`, `(`, `{`, `[[`, `([`, ...); the label
    // check needs it quoted. Quoted text is blanked first, so a `()` inside a label is not a node,
    // and the run must end before the lookahead, so `[[` cannot pass as `[` plus an unquoted `[`.
    const blanked = fence.body.replaceAll(/"[^"]*"/g, '""');
    for (const unquoted of blanked.matchAll(/\b[A-Za-z_]\w*[[({]+(?![[({"])/g)) {
      problems.push(`${at}: node "${unquoted[0]}" has an unquoted label; quote it`);
    }
    for (const node of fence.body.matchAll(/\b[A-Za-z_]\w*[[({]+"([^"]*)"/g)) {
      const read = readLabel(node[1] ?? "");
      problems.push(...read.problems.map((problem) => `${at}: ${problem}`));
      claims.push(...read.claims.map((claim) => ({ ...claim, at })));
    }
  }
  const present = claims.filter((claim) => {
    if (existsSync(join(ROOT, claim.path))) return true;
    problems.push(`${claim.at}: "${claim.label}": ${claim.path} does not exist`);
    return false;
  });
  const modules = [
    ...new Set(
      present
        .filter((claim) => claim.symbols.length > 0 && claim.path.endsWith(".ts"))
        .map((claim) => claim.path),
    ),
  ];
  const exports = exportedNames(modules);
  for (const claim of present) {
    for (const symbol of claim.symbols) {
      if (!claim.path.endsWith(".ts")) {
        problems.push(
          `${claim.at}: "${claim.label}": ${claim.path} is not a TypeScript module, so it exports no ${symbol}`,
        );
      } else if (!exports.get(claim.path)?.has(symbol)) {
        problems.push(`${claim.at}: "${claim.label}": ${claim.path} exports no ${symbol}`);
      }
    }
  }
  expect(problems).toEqual([]);
});

test("every concept diagram has a Demonstrated by line whose links resolve to tests", () => {
  const problems: string[] = [];
  const headings = text.flatMap((line, index) =>
    line !== undefined && /^#/.test(line) ? [index] : []
  );
  const demonstrations = text.flatMap((line, index) =>
    line !== undefined && line.startsWith("Demonstrated by:") ? [index] : []
  );
  const claimed = new Set<number>();
  for (const fence of concepts) {
    const at = `${PAGE}:${fence.line + 1}`;
    const sectionEnd = headings.find((line) => line > fence.line) ?? page.length;
    const demo = demonstrations.find(
      (line) => line > fence.line && line < sectionEnd && !claimed.has(line),
    );
    if (demo === undefined) {
      problems.push(`${at}: the diagram has no "Demonstrated by:" line before the next heading`);
      continue;
    }
    claimed.add(demo);
    const links = [...(page[demo] ?? "").matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");
    if (links.length === 0) problems.push(`${at}: the "Demonstrated by:" line links nothing`);
    for (const link of links) {
      const file = resolve(ROOT, dirname(PAGE), link.split("#")[0] ?? "");
      const rel = relative(ROOT, file).replaceAll("\\", "/");
      if (!existsSync(file) || statSync(file).isDirectory()) {
        problems.push(`${at}: "${link}" names no file`);
      } else if (!/^(?:test\/[\w./-]+\.test\.ts|\.github\/scripts\/[\w.-]+-smoke\.ts)$/.test(rel)) {
        problems.push(`${at}: "${link}" is not a test file or a smoke scenario`);
      }
    }
  }
  expect(problems).toEqual([]);
  expect(demonstrations).toHaveLength(concepts.length);
});

test(`the page carries exactly ${CONCEPT_DIAGRAMS} concept diagrams`, () => {
  expect(concepts).toHaveLength(CONCEPT_DIAGRAMS);
});

test("the generated module map equals a fresh render of architecture.json", () => {
  const current = page.join("\n");
  expect(spliceGeneratedRegion(current, renderArchitectureMap(readArchitecture(ROOT)))).toBe(
    current,
  );
});
