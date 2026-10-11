import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DAEMON_CLIENT_HEADERS_ENV,
  DAEMON_COPILOT_HOST_ENV,
} from "../../src/copilot_api/integration_identity.ts";
import { DAEMON_GH_TOKEN_ENV } from "../../src/copilot_api/process.ts";
import { ROOT } from "../helpers/run.ts";
import { parseModule, visit } from "../helpers/syntax.ts";
import { expect, test } from "../helpers/testing.ts";
import { tsFilesUnder } from "../helpers/tree.ts";

// Some `--preload` shims run import-free inside the proxy daemon (a CLI import would drag that
// layer into the daemon), so each env-var contract between launchDaemon and such a shim is spelled
// twice, and a drift fails silently at launch (a token-less daemon, a daemon under the proxy's own identity).
//   the shim's literal, read as text  -> must equal the CLI constant (importing the shim would defeat the design)
//   the shim's runtime imports        -> none; `biome ci` runs biome/no_shim_imports.grit over them
//                                        (scope and teeth pinned by test/utils/shim_imports_lint.test.ts)

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

/**
 * The one top-level `const NAME = "..."` of the shim, read from the parsed tree: a look-alike in a
 * comment or a message is not a declaration, and an initializer that is anything but one plain
 * string literal (a concatenation, a template, an alias) is refused rather than read as its first
 * piece. Missing or duplicated throws, so a shim refactor breaks loudly.
 */
function extractStringConst(source: string, name: string, file: string): string {
  const values: string[] = [];
  visit(parseModule(file, source).program, {
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || node.id.name !== name) return;
      const literal = node.init?.type === "Literal" && typeof node.init.value === "string"
        ? node.init.value
        : null;
      if (literal === null) {
        throw new Error(
          `${file}: const ${name} must be initialized with one plain string literal -- ` +
            "the daemon reads the key from that literal alone",
        );
      }
      values.push(literal);
    },
  });
  const [value, ...extra] = values;
  if (value === undefined || extra.length > 0) {
    throw new Error(
      `expected exactly one \`const ${name} = "..."\` in ${file}, found ${values.length} -- ` +
        "if the shim was refactored, update PINNED_PAIRS in test/copilot_api/daemon_env_keys.test.ts",
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
  // Scanned through the parser (string literals, template chunks, identifiers; comments are
  // never nodes), so no text heuristic can silently hide a key.
  const keysIn = (files: string[]): Set<string> => {
    const found = new Set<string>();
    const collect = (file: string, text: string): void => {
      for (const match of text.match(ENV_KEY_RE) ?? []) {
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
    };
    for (const file of files) {
      visit(parseModule(file).program, {
        Literal(node) {
          if (typeof node.value === "string") collect(file, node.value);
        },
        TemplateElement(node) {
          collect(file, node.value.cooked ?? node.value.raw);
        },
        Identifier(node) {
          collect(file, node.name);
        },
      });
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
        "add a PINNED_PAIRS entry in test/copilot_api/daemon_env_keys.test.ts (or, for a key that is " +
        "genuinely not a shim/CLI pair, SCRIPT_ONLY_KEYS)",
    );
  }
  const missing = [...pinnedKeys].filter((k) => !scriptKeys.has(k));
  if (missing.length > 0) {
    throw new Error(
      `pinned env key(s) ${missing.join(", ")} are no longer spelled in src/scripts/ -- ` +
        "if the shim went away, drop the PINNED_PAIRS entry in test/copilot_api/daemon_env_keys.test.ts",
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
