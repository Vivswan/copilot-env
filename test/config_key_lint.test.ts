// Every mention of a config key must be the registry's spelling. Three ways a stale name slips in
// after a rename, all caught here rather than by a reader:
//   an `agent config set|unset|get <key>` or `agent profile [<name>] set|unset|get <key>` hint
//     spelled by hand -> must go through configSetCommand / configDelCommand / configGetCommand (typed key)
//   a dotted key named bare in a string ("(daemon.auto-start on)")   -> must be a registry key
//   a retired spelling cited anywhere, comments included             -> the migration's table says which
// The registry file owns the helpers and the descriptions, so it is exempt from the string scans.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CONFIG_REGISTRY } from "../src/copilot_api/env_config.ts";
import { PREFERENCE_RENAMES } from "../src/migrations/4.0.9.ts";
import { escapeRegExp } from "../src/utils/regexp.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, test } from "./helpers/testing.ts";

const SRC = join(PROJECT_ROOT, "src");
const REGISTRY_FILE = join(SRC, "copilot_api", "env_config.ts");

/** Dotted tokens with a key-group prefix that are NOT config keys: file names and health check ids
 *  that happen to share the shape. A new key never lands here; a new file name or check id does. */
const NOT_KEYS = new Set([
  "daemon.lock",
  "update.lock",
  "claude.json",
  "claude.exe",
  "claude.mcp",
  "claude.live",
  "codex.live",
  "proxy.package",
  "proxy.sidecar",
  "proxy.resolved",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The string and template literals of a file, `${...}` holes removed, full-line comments and
 *  import/export specifiers (module paths such as `./daemon.ts`) dropped. */
function stringLiterals(source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => !/^\s*(import|export)\b.*\bfrom\s+["']/.test(line))
    .filter((line) => !/^\s*\}\s*from\s+["']/.test(line))
    .join("\n");
  const literals = code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
  return literals.map((lit) => lit.slice(1, -1).replace(/\$\{[^}]*\}/g, " "));
}

const KEYS: ReadonlySet<string> = new Set(CONFIG_REGISTRY.map((def) => def.key));
const GROUPS = [...new Set(CONFIG_REGISTRY.map((def) => def.key.split(".")[0]))]
  .filter((group) => CONFIG_REGISTRY.some((def) => def.key.startsWith(`${group}.`)));
const DOTTED_KEY_SHAPE = new RegExp(
  `\\b(?:${GROUPS.join("|")})\\.[a-z][a-z-]*(?:\\.[a-z][a-z-]*)*\\b`,
  "g",
);
/** `agent config [set|unset|get] <key> ...` or `agent profile [<name>] set|unset|get <key> ...`; a
 *  `<placeholder>`, a bare verb, or a verb menu (`set|unset|get`) is not a key. The name may be a
 *  template hole (blanked to a space by stringLiterals), so any run of spaces precedes the verb. */
const HAND_SPELLED_HINT =
  /agent (?:config (?:(?:set|unset|get) )?|profile(?: [a-z0-9][a-z0-9-]*)? +(?:set|unset|get) )(?!<|(?:set|unset|get)\b)[a-z][a-z0-9.-]*/g;
/** "the <key> config key", "`<key>` config key", or a dotted/dashed "<key> config key". */
const KEY_MENTION = /(?:(?:the |`)([a-z][a-z0-9.-]*)`?|([a-z0-9]+(?:[.-][a-z0-9]+)+)) config key/g;

test("no source string spells an `agent config` hint by hand or names a dotted key the registry lacks", () => {
  const offences: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === REGISTRY_FILE) continue;
    const where = relative(PROJECT_ROOT, file);
    for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
      for (const hint of literal.match(HAND_SPELLED_HINT) ?? []) {
        offences.push(`${where}: hand-spelled hint \`${hint}\` (use configSetCommand and friends)`);
      }
      for (const token of literal.match(DOTTED_KEY_SHAPE) ?? []) {
        if (KEYS.has(token) || NOT_KEYS.has(token)) continue;
        offences.push(`${where}: \`${token}\` is not a registry key`);
      }
      for (const mention of literal.matchAll(KEY_MENTION)) {
        const token = mention[1] ?? mention[2] ?? "";
        if (KEYS.has(token)) continue;
        offences.push(`${where}: "${token} config key" names no registry key`);
      }
    }
  }
  expect(offences).toEqual([]);
  // Negative controls: the scan sees what it is meant to see.
  expect(
    stringLiterals('x("agent config set daemon.port 4242")').join("").match(HAND_SPELLED_HINT),
  )
    .toEqual(["agent config set daemon.port"]);
  expect('"agent profile work set identity copilot-developer-cli"'.match(HAND_SPELLED_HINT))
    .toEqual(["agent profile work set identity"]);
  expect('"agent profile 2work set identity auto"'.match(HAND_SPELLED_HINT))
    .toEqual(["agent profile 2work set identity"]);
  expect(
    stringLiterals("w(`agent profile ${profile} set identity auto`)").join("").match(
      HAND_SPELLED_HINT,
    ),
  )
    .toEqual(["agent profile   set identity"]);
  expect(stringLiterals("y(`(${key} on)`)").join("").match(DOTTED_KEY_SHAPE)).toBeNull();
  expect(stringLiterals('z("(daemon.auto-stop on)")').join("").match(DOTTED_KEY_SHAPE))
    .toEqual(["daemon.auto-stop"]);
  expect(KEYS.has("daemon.auto-stop")).toBe(false);
  expect('"pinned via `agent config integration-id`"'.match(HAND_SPELLED_HINT))
    .toEqual(["agent config integration-id"]);
  expect('"usage: agent config set <key> <value>"'.match(HAND_SPELLED_HINT)).toBeNull();
  expect('"agent profile [<name>] set|unset|get; agent config get"'.match(HAND_SPELLED_HINT))
    .toBeNull();
  expect('"agent profile work add --proxy"'.match(HAND_SPELLED_HINT)).toBeNull();
  expect([...'"the `launchers` config key"'.matchAll(KEY_MENTION)].map((m) => m[1] ?? m[2]))
    .toEqual(["launchers"]);
  expect([...'"unknown config key"'.matchAll(KEY_MENTION)]).toEqual([]);
});

/** Every file under src/ except src/migrations/, the one directory where the old spellings live. */
function everyFile(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path !== join(SRC, "migrations")) out.push(...everyFile(path));
    } else out.push(path);
  }
  return out;
}

/** The old CLI spellings the 4.0.9 migration renames, from its own table; a spelling the rename kept
 *  (`passthrough`, `static-key`) is not old. */
const OLD_KEY_NAMES = PREFERENCE_RENAMES.filter(([, cli, key]) => cli !== key).map(([, cli]) =>
  cli
);

/** A key is cited in backticks, alone or with one value word (`` `codex-host` ``, `` `claude-desktop false` ``,
 *  the backticks escaped inside a template literal or not), or named by an `agent config` flag
 *  (`--set codex-host true`, even when the hint wraps onto a comment's next line). A template literal's
 *  own opening backtick (`` `port ${n} is busy` ``) is not a citation: `${` is no word. */
const OLD_KEY_CITATION = new RegExp(
  `\\\\?\`(?:${OLD_KEY_NAMES.map(escapeRegExp).join("|")})( [\\w-]+)?\\\\?\`` +
    `|--(?:set|del|get) (?:${OLD_KEY_NAMES.map(escapeRegExp).join("|")})\\b`,
  "g",
);

test("no source file, comments included, cites a config key by a spelling the 4.0.9 migration retired", () => {
  const offences: string[] = [];
  for (const file of everyFile(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const hit of line.match(OLD_KEY_CITATION) ?? []) {
        offences.push(`${relative(PROJECT_ROOT, file)}:${i + 1}: ${hit} is a retired spelling`);
      }
    });
  }
  expect(offences).toEqual([]);
  // Negative controls: the citation shapes are seen, a template literal's opening backtick and a
  // dotted or flag spelling are not, and the list really comes from the migration's table.
  expect("the `codex-host` key".match(OLD_KEY_CITATION)).toEqual(["`codex-host`"]);
  expect(" *  --set update-cooldown N` takes effect".match(OLD_KEY_CITATION))
    .toEqual(["--set update-cooldown"]);
  expect("run `agent config --set update.cooldown 3` or pass `--port`".match(OLD_KEY_CITATION))
    .toBeNull();
  expect("busy (\\`strict-port\\`); free it".match(OLD_KEY_CITATION)).toEqual([
    "\\`strict-port\\`",
  ]);
  expect("the `claude-desktop false` sweep".match(OLD_KEY_CITATION)).toEqual([
    "`claude-desktop false`",
  ]);
  expect("`port ${def} is busy (`daemon.strict-port`); pass `--port`".match(OLD_KEY_CITATION))
    .toBeNull();
  expect(OLD_KEY_NAMES).toContain("integration-id");
  expect(OLD_KEY_NAMES).not.toContain("passthrough");
});
