import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DAEMON_CLIENT_HEADERS_ENV,
  DAEMON_COPILOT_HOST_ENV,
} from "../src/copilot_api/integration_identity.ts";
import { DAEMON_GH_TOKEN_ENV } from "../src/copilot_api/process.ts";
import { ROOT } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";
import shimImportsPlugin, { SHIM_FILES } from "./lint/no_shim_imports.ts";

// Some `--preload` shims run import-free inside the proxy daemon (a CLI import would drag that
// layer into the daemon), so each env-var contract between launchDaemon and such a shim is spelled
// twice, and a drift fails silently at launch (a token-less daemon, a daemon under the proxy's own identity).
//   the shim's literal, read as text  -> must equal the CLI constant (importing the shim would defeat the design)
//   the shim's runtime imports        -> none; `deno lint` runs test/lint/no_shim_imports.ts (deno.json) over them

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
    key: DAEMON_CLIENT_HEADERS_ENV,
    keyName: "DAEMON_CLIENT_HEADERS_ENV",
    shim: "client_headers_preload.ts",
    localConst: "CLIENT_HEADERS_ENV",
  },
  {
    key: DAEMON_COPILOT_HOST_ENV,
    keyName: "DAEMON_COPILOT_HOST_ENV",
    shim: "copilot_host_preload.ts",
    localConst: "COPILOT_HOST_ENV",
  },
  {
    key: DAEMON_COPILOT_HOST_ENV,
    keyName: "DAEMON_COPILOT_HOST_ENV",
    shim: "client_headers_preload.ts",
    localConst: "COPILOT_HOST_ENV",
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
 * Offset-preserving (a blanked character becomes a space) so extractStringConst can compare
 * positions across its two passes. Not a full parser, and each consumer bounds the damage:
 *   misread `/` here                  -> caught when the two passes then disagree (the exactly-one/
 *                                        same-offset cross-check); a misread both share passes
 *   the sweep test (a miss is silent) -> parser-backed, never this scanner
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
      // After an operand a slash is division; anywhere else, including after a keyword like
      // `return` (identifier characters, but no operand), it opens a regex literal, lexed here
      // so the comment checks above never see its body.
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

/** The value group admits only a plain literal, no escapes and no `$` (so no template
 *  interpolation): whatever it captures is the exact runtime string. */
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
 * Two passes cross-check each other; both must find exactly one candidate at the same offset.
 *   structural pass, strings blanked  -> a look-alike `const ENV_KEY = "..."` quoted in a message cannot pose as the declaration
 *   value pass                        -> extracts the literal
 * Missing, duplicated, or shadowed throws, so a shim refactor breaks loudly; a literal followed by a
 * concatenated suffix is read as its first literal (keysIn's fragment check is the guard for that).
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
}

// The lint gate keeps the shims import-free only if the rule has teeth and covers them, so pin
// both against doctored sources: (source, path) -> diagnostic count.
test("no-shim-imports: rejects every runtime-import shape in a shim, allows type-only, silent elsewhere", () => {
  const shim = SHIM_FILES[0];
  const importing = 'import { x } from "./cli.ts";';
  const rows: { source: string; path: string; diagnostics: number }[] = [
    { source: importing, path: shim, diagnostics: 1 },
    { source: 'import "./side_effect.ts";', path: shim, diagnostics: 1 },
    { source: 'export * from "./cli.ts";', path: shim, diagnostics: 1 },
    { source: 'export { x } from "./cli.ts";', path: shim, diagnostics: 1 },
    { source: 'const m = await import("./cli" + ".ts");', path: shim, diagnostics: 1 },
    // Aliasing require is still caught.
    { source: 'const r = require; r("node:fs");', path: shim, diagnostics: 1 },
    // Erased at runtime: type-only imports and plain sourceless exports stay legal.
    { source: 'import type { T } from "./cli.ts"; export {};', path: shim, diagnostics: 0 },
    { source: "export function f(): number { return 1; }", path: shim, diagnostics: 0 },
    // Outside the shim files the rule says nothing.
    { source: importing, path: "src/commands/profile.ts", diagnostics: 0 },
  ];
  for (const row of rows) {
    const count = Deno.lint.runPlugin(shimImportsPlugin, row.path, row.source).length;
    expect({ ...row, count }).toEqual({ ...row, count: row.diagnostics });
  }
  // Every pinned shim is inside the rule's scope -- the two lists may not drift.
  for (const { shim } of PINNED_PAIRS) {
    expect(SHIM_FILES.map((f) => f.split("/").at(-1))).toContain(shim);
  }
});

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
  // A COPILOT_ENV_* key is always set by the CLI layer, so one spelled (not imported) in
  // src/scripts/ is a duplicated cross-boundary contract and belongs in PINNED_PAIRS.
  //   script-side keys != pinned set     -> fails, a pair born drifted included
  //   `*` quantifier catches a fragment  -> keysIn below rejects it
  const ENV_KEY_RE = /\bCOPILOT_ENV_[A-Z0-9_]*/g;
  // Scanned through deno's own parser (string literals, template chunks, identifiers; comments
  // are never AST nodes), so no text heuristic can silently hide a key.
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
        // A key assembled by concatenation would dodge the set comparison. A leading fragment
        // ending in "_" (as the bare prefix does) is rejected here; a whole pinned key with a
        // concatenated suffix is not caught (the collector reports the first literal).
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
