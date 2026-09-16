// Every user-facing mention of a config key must be the registry's spelling. Two ways a stale name
// slips in after a rename, both caught here rather than by a reader:
//   an `agent config --set|--del|--get <key>` hint spelled by hand -> must go through the
//     configSetCommand / configDelCommand / configGetCommand helpers (typed key)
//   a dotted key named bare in a string ("(daemon.auto-start on)")   -> must be a registry key
// The registry file owns the helpers and the descriptions, so it is the one file exempt.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CONFIG_REGISTRY } from "../src/copilot_api/env_config.ts";
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
/** `agent config --set <key> ...` or a bare `agent config <key>`; a `<placeholder>` or a second flag is
 *  not a key. */
const HAND_SPELLED_HINT = /agent config (?:--(?:set|del|get) )?(?!<|--)[a-z][a-z0-9.-]*/g;
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
    stringLiterals('x("agent config --set daemon.port 4242")').join("").match(HAND_SPELLED_HINT),
  )
    .toEqual(["agent config --set daemon.port"]);
  expect(stringLiterals("y(`(${key} on)`)").join("").match(DOTTED_KEY_SHAPE)).toBeNull();
  expect(stringLiterals('z("(daemon.auto-stop on)")').join("").match(DOTTED_KEY_SHAPE))
    .toEqual(["daemon.auto-stop"]);
  expect(KEYS.has("daemon.auto-stop")).toBe(false);
  expect('"pinned via `agent config integration-id`"'.match(HAND_SPELLED_HINT))
    .toEqual(["agent config integration-id"]);
  expect('"usage: agent config --set <key> <value>"'.match(HAND_SPELLED_HINT)).toBeNull();
  expect([...'"the `launchers` config key"'.matchAll(KEY_MENTION)].map((m) => m[1] ?? m[2]))
    .toEqual(["launchers"]);
  expect([...'"unknown config key"'.matchAll(KEY_MENTION)]).toEqual([]);
});
