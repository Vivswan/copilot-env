import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DAEMON_INTEGRATION_ID_ENV } from "../src/copilot_api/integration_identity.ts";
import { DAEMON_GH_TOKEN_ENV } from "../src/copilot_api/process.ts";
import { ROOT } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";
import shimImportsPlugin, { SHIM_FILES } from "./lint/no_shim_imports.ts";

// Some daemon preload shims stay import-free: a `--preload` shim runs inside the proxy
// daemon, and pulling a CLI module in with it would drag the whole CLI layer into that
// process. The price of the isolation is duplication -- each env-var contract between
// launchDaemon and such a shim is spelled TWICE, once as an exported CLI constant and once
// as a local literal in the shim, synchronized by nothing but comments. If the copies
// drift, nothing fails at launch: the daemon just comes up token-less (or skips the
// integration-id rewrite) silently. These tests pin each pair by reading the shim as TEXT
// (importing it would defeat the import-free design) and comparing the extracted literal
// against the imported CLI constant, and they pin the import-free invariant itself --
// the moment a shim may import, the duplication should be replaced by an import.

const SRC_DIR = join(ROOT, "src");
const SCRIPTS_DIR = join(SRC_DIR, "scripts");

/** Every env key spelled both as a CLI constant and as a local literal in an import-free
 *  shim. The sweep test below fails when a new cross-boundary key appears, pointing here. */
const PINNED_PAIRS = [
  {
    key: DAEMON_GH_TOKEN_ENV,
    keyName: "DAEMON_GH_TOKEN_ENV",
    shim: "token_argv_preload.ts",
    localConst: "ENV_KEY",
  },
  {
    key: DAEMON_INTEGRATION_ID_ENV,
    keyName: "DAEMON_INTEGRATION_ID_ENV",
    shim: "pat_passthrough_preload.ts",
    localConst: "INTEGRATION_ID_ENV",
  },
] as const;

/** Keywords a `/` can directly follow while still opening a regex literal (they end in
 *  identifier characters, so the operand check alone would misread division there). */
const REGEX_POSITION_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "case",
  "default",
  "delete",
  "void",
  "instanceof",
  "in",
  "of",
  "new",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * `source` with comments and regex-literal bodies blanked out and, when `stripStrings`,
 * string-literal contents too (the quotes stay). Blanking is offset-preserving -- every
 * blanked character becomes a space (newlines stay) -- so positions are comparable across
 * passes. A character scanner rather than regexes, so a `//` inside a string or a quote
 * inside a comment cannot derail it; regex literals are recognized by the token before
 * the `/` (expression position => regex). The heuristic is not a full parser: it can
 * misread a `/` (say, after a control-condition `)`), which mangles or hides the
 * declaration -- and extractStringConst's exactly-one/same-offset cross-checks turn that
 * into a LOUD failure. That loud-by-construction property is why this scanner backs only
 * extraction; the sweep, where a miss would be silent, is parser-backed instead.
 */
function blankSource(source: string, stripStrings: boolean): string {
  let out = "";
  let i = 0;
  const pad = (from: number, to: number): string => {
    let s = "";
    for (let j = from; j < to && j < source.length; j += 1) {
      s += source[j] === "\n" ? "\n" : " ";
    }
    return s;
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i += 1;
      out += pad(start, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += pad(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/") {
      // After an operand (identifier, number, `)`, `]`, `}`, or a closed literal) a slash
      // is division; anywhere else -- including right after a keyword like `return`,
      // which ends in identifier characters but cannot be an operand -- it opens a regex
      // literal, which must be lexed here so the comment checks above never see its body.
      const trimmed = out.trimEnd();
      const prev = trimmed.slice(-1);
      const word = trimmed.match(/[A-Za-z_$][\w$]*$/)?.[0];
      const afterKeyword = word !== undefined && REGEX_POSITION_KEYWORDS.has(word);
      if (prev === "" || afterKeyword || !/[A-Za-z0-9_$)\]}"'`]/.test(prev)) {
        out += "/";
        i += 1;
        const bodyStart = i;
        let inClass = false;
        while (i < source.length && source[i] !== "\n") {
          const c = source[i];
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          i += 1;
        }
        out += pad(bodyStart, i);
        if (source[i] === "/") {
          out += "/";
          i += 1;
        }
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== ch) {
        const take = source[i] === "\\" ? 2 : 1;
        out += stripStrings ? pad(i, i + take) : source.slice(i, i + take);
        i += take;
      }
      if (i < source.length) {
        out += ch;
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Matches `const NAME = "value"` with any quote style, any whitespace (including line
 *  breaks a formatter might introduce), and an optional type annotation. The value group
 *  admits only a plain single-token literal -- no escapes and, since `$` is excluded, no
 *  template interpolation -- so whatever it captures is the exact runtime string. */
const STRING_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(["'`])([^"'`\\$\r\n]*)\2/g;

function constMatches(code: string, name: string): { value: string; index: number }[] {
  const out: { value: string; index: number }[] = [];
  for (const m of code.matchAll(STRING_CONST_RE)) {
    if (m[1] === name && m[3] !== undefined && m.index !== undefined) {
      out.push({ value: m[3], index: m.index });
    }
  }
  return out;
}

/**
 * The exact string literal assigned to `const <name>` in `source`. Two passes cross-check
 * each other: the structural pass runs with string contents blanked, so text INSIDE some
 * other string (say, a stale `const ENV_KEY = "..."` quoted in a message) cannot pose as
 * the declaration, and the value pass extracts the literal. Each must find exactly one
 * candidate AND both at the same source offset (blanking preserves offsets), so the
 * passes provably saw the same declaration; anything else -- missing, duplicated,
 * shadowed by a look-alike inside a string, or not a plain literal -- throws, so a shim
 * refactor breaks this test loudly, never silently.
 */
function extractStringConst(source: string, name: string, file: string): string {
  const structural = constMatches(blankSource(source, true), name);
  const values = constMatches(blankSource(source, false), name);
  const aligned = structural.length === 1 && values.length === 1 &&
    structural[0]?.index === values[0]?.index;
  const value = aligned ? values[0]?.value : undefined;
  if (value === undefined) {
    throw new Error(
      `expected exactly one plain-string \`const ${name} = "..."\` in ${file}, ` +
        `found ${values.length} -- if the shim was refactored, update PINNED_PAIRS ` +
        "in test/daemon_env_keys.test.ts",
    );
  }
  return value;
}

for (const { key, keyName, shim, localConst } of PINNED_PAIRS) {
  test(`${shim}: ${localConst} matches ${keyName} (drift guard)`, () => {
    const source = readFileSync(join(SCRIPTS_DIR, shim), "utf8");
    expect(extractStringConst(source, localConst, shim)).toBe(key);
  });

  test(`${shim} stays free of runtime imports (why the literal is duplicated)`, () => {
    // The repo's own lint rule, run through deno's real parser: it reports every
    // runtime module reference -- static imports, side-effect imports, re-exports
    // with a source, dynamic import(), and any bare `require` identifier -- while
    // type-only imports are erased at runtime and stay allowed. The same rule is
    // registered in deno.json, so `deno lint` enforces the invariant too; this
    // test pins it (and the rule itself, below) even if that registration goes
    // away. If this ever needs to change, the duplicated literal should become an
    // import and the PINNED_PAIRS entry above should go away with it.
    const file = join(SCRIPTS_DIR, shim);
    const diagnostics = Deno.lint.runPlugin(shimImportsPlugin, file, readFileSync(file, "utf8"));
    expect(diagnostics).toEqual([]);
  });
}

// The clean-shim assertions above prove nothing if the rule itself is a no-op,
// so pin its teeth (and its file scoping) against doctored sources.
test("no-shim-imports: rejects every runtime-import shape, allows type-only", () => {
  const shim = SHIM_FILES[0];
  const lint = (source: string): string[] =>
    Deno.lint.runPlugin(shimImportsPlugin, shim, source).map((d) => d.message);

  expect(lint('import { x } from "./cli.ts";')).toHaveLength(1);
  expect(lint('import "./side_effect.ts";')).toHaveLength(1);
  expect(lint('export * from "./cli.ts";')).toHaveLength(1);
  expect(lint('export { x } from "./cli.ts";')).toHaveLength(1);
  expect(lint('const m = await import("./cli" + ".ts");')).toHaveLength(1);
  expect(lint('const r = require; r("node:fs");')).toHaveLength(1); // aliasing still caught
  // Erased at runtime: type-only imports and plain sourceless exports stay legal.
  expect(lint('import type { T } from "./cli.ts"; export {};')).toEqual([]);
  expect(lint("export function f(): number { return 1; }")).toEqual([]);
});

test("no-shim-imports: scoped to the shim files, silent elsewhere", () => {
  const importing = 'import { x } from "./cli.ts";';
  expect(Deno.lint.runPlugin(shimImportsPlugin, "src/commands/init.ts", importing)).toEqual([]);
  // Every pinned shim is inside the rule's scope -- the two lists may not drift.
  for (const { shim } of PINNED_PAIRS) {
    expect(SHIM_FILES.map((f) => f.split("/").at(-1))).toContain(shim);
  }
});

/** All .ts files under `dir`, recursively. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Escape hatch for a COPILOT_ENV_* key legitimately spelled in a script yet NOT a
 *  shim/CLI pair (say, a user-facing message naming a key). Empty today; add to it
 *  consciously, never to silence a real new pair. */
const SCRIPT_ONLY_KEYS: ReadonlySet<string> = new Set();

test("every env key spelled in a script is a pinned CLI pair (sweep)", () => {
  // The pair list must stay complete. A COPILOT_ENV_* key is always set by the CLI layer,
  // so one spelled in the .ts code (not comments) of src/scripts/ -- rather than imported
  // -- is by definition a duplicated cross-boundary contract with the same silent-drift
  // failure mode, and belongs in PINNED_PAIRS. (The .sh/.ps1 scripts there spell no such
  // keys today and could never import a TS constant anyway.) Requiring the script-side
  // key set to EQUAL the pinned set (not merely intersect the CLI side) also catches a
  // pair that is born drifted, where the two spellings never match anywhere. A script
  // that imports the CLI constant never spells the literal and never trips this. The `*`
  // quantifier surfaces key FRAGMENTS too: a key assembled by concatenation or
  // interpolation would dodge the set comparison, and its leading fragment ends with "_"
  // (as does the bare prefix), while no whole key ever does -- so any
  // underscore-terminated match is rejected outright on either side. Files are scanned
  // through deno's own parser (the collector below visits string literals, template
  // chunks, and identifiers -- comments are never AST nodes), so no text heuristic
  // can silently HIDE a key here.
  const ENV_KEY_RE = /\bCOPILOT_ENV_[A-Z0-9_]*/g;
  const envKeyCollector: Deno.lint.Plugin = {
    name: "env-key-collector",
    rules: {
      "collect": {
        create(context) {
          const report = (node: Deno.lint.Node, text: string): void => {
            for (const match of text.match(ENV_KEY_RE) ?? []) {
              context.report({ node, message: `key:${match}` });
            }
          };
          return {
            "Literal"(node) {
              if (typeof node.value === "string") report(node, node.value);
            },
            "TemplateElement"(node) {
              report(node, node.cooked ?? node.raw);
            },
            "Identifier"(node) {
              report(node, node.name);
            },
          };
        },
      },
    },
  };
  const keysIn = (files: string[]): Set<string> => {
    const found = new Set<string>();
    for (const file of files) {
      const diagnostics = Deno.lint.runPlugin(envKeyCollector, file, readFileSync(file, "utf8"));
      for (const diagnostic of diagnostics) {
        const match = diagnostic.message.slice("key:".length);
        if (match.endsWith("_")) {
          throw new Error(
            `env-key fragment "${match}" in ${relative(SRC_DIR, file)} -- spell env ` +
              "keys whole so this sweep can pair them across the src/scripts/ boundary",
          );
        }
        found.add(match);
      }
    }
    return found;
  };
  const scriptFiles = tsFilesUnder(SCRIPTS_DIR);
  const cliFiles = tsFilesUnder(SRC_DIR).filter((f) => !f.startsWith(SCRIPTS_DIR + sep));
  const pinnedKeys = new Set<string>(PINNED_PAIRS.map((p) => p.key));
  const scriptKeys = keysIn(scriptFiles);
  const unexpected = [...scriptKeys].filter((k) => !pinnedKeys.has(k) && !SCRIPT_ONLY_KEYS.has(k));
  if (unexpected.length > 0) {
    throw new Error(
      `env key(s) ${unexpected.join(", ")} are spelled in src/scripts/ but not pinned -- ` +
        "add a PINNED_PAIRS entry in test/daemon_env_keys.test.ts (or, for a key that is " +
        "genuinely not a shim/CLI pair, SCRIPT_ONLY_KEYS)",
    );
  }
  const missing = [...pinnedKeys].filter((k) => !scriptKeys.has(k));
  if (missing.length > 0) {
    throw new Error(
      `pinned env key(s) ${missing.join(", ")} are no longer spelled in src/scripts/ -- ` +
        "if the shim went away, drop the PINNED_PAIRS entry in test/daemon_env_keys.test.ts",
    );
  }
  // Each pinned key is really spelled on the CLI side too -- the other half of the pair.
  const cliKeys = keysIn(cliFiles);
  for (const { key } of PINNED_PAIRS) expect([...cliKeys]).toContain(key);
  // And the pinned shims are where the sweep expects them: under src/scripts/.
  for (const { shim } of PINNED_PAIRS) {
    expect(scriptFiles.map((f) => relative(SCRIPTS_DIR, f))).toContain(shim);
  }
});
