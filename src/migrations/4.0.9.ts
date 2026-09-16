// Away from 4.0.9: Codex (>= 0.134, the profile-v2 layout) reads a named profile from
// `<name>.config.toml` and refuses the old shape at startup, so every `cx --profile <name>` on a
// 4.0.9 install fails before it reaches our provider:
//
//   `[profiles.<name>]` table    -> `codex --profile <name>` refuses to start
//   top-level `profile = "..."`  -> every launch refuses to start
//
// The fix-up moves each table copilot-env wrote (its model_provider is our `copilot-env-<name>`)
// into the profile file and drops it from config.toml. Foreign tables and the `profile` key are
// the user's: left in place, reported with the Codex error they cause.
import { consola } from "consola";
import { join } from "node:path";
import { codexProviderId } from "../codex/config.ts";
import { knownCodexHomes } from "../codex/host.ts";
import { codexConfigPath, codexProfileConfigPath } from "../codex/paths.ts";
import { readCodexToml, saveCodexToml } from "../codex/toml_io.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CODEX_IDENTITY_NAME, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { isValidProfileName, parseProfileName } from "../copilot_api/profile.ts";
import { shellTargetFiles } from "../shell/integration.ts";
import { errMessage } from "../utils/error.ts";
import { readTextResult } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { writeFileReported } from "../utils/report_write.ts";
import { FENCE_LINES, LAUNCHERS_MARKER, LAUNCHERS_MARKER_END } from "./4.0.0.ts";
import type { Migration } from "./index.ts";

/** A parsed TOML table is a plain object; smol-toml's date-time scalar is a class instance with no
 *  enumerable keys, so recursing into it would spread it to an empty table. */
function isTable(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Key-wise, recursing into tables, `over`'s leaves winning: a table's `features.multi_agent`
 *  survives a file that only sets `features.shell_tool`, as Codex itself layers the two. */
function layer(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const under = out[key];
    out[key] = isTable(under) && isTable(value) ? layer(under, value) : value;
  }
  return out;
}

/** One home's config.toml: ours move, the rest is reported. Every table is visited before the
 *  file is saved, and an owned table whose profile file exists but cannot be parsed stays put and
 *  FAILS the step after the others moved (the runner then names the re-run), since no wiring
 *  command removes a legacy table. Exported for the migration test. */
export function moveCodexProfileTables(codexHome: string): void {
  const configPath = codexConfigPath(codexHome);
  const read = readCodexToml(configPath);
  if (read.kind === "absent") return;
  if (read.kind === "unparseable") {
    throw new Error(`${configPath} is not valid TOML (${read.error})`);
  }
  const doc = read.doc;
  if (doc.profile !== undefined) {
    consola.warn(
      `  ${configPath} carries a top-level \`profile = ${JSON.stringify(doc.profile)}\` that ` +
        'copilot-env never wrote; Codex refuses every launch on it ("legacy `profile` config is ' +
        'no longer supported"). Delete the line and use `codex --profile <name>` instead.',
    );
  }
  const profiles = isRecord(doc.profiles) ? doc.profiles : null;
  if (profiles === null) return;
  let changed = false;
  const stuck: string[] = [];
  for (const [name, table] of Object.entries(profiles)) {
    const ours = isValidProfileName(name) && isRecord(table) &&
      table.model_provider === codexProviderId(parseProfileName(name));
    if (!ours) {
      // The name may be one copilot-env would never mint, so the file is spelled without the brand.
      consola.warn(
        `  [profiles.${name}] in ${configPath} is not copilot-env's; \`codex --profile ${name}\` ` +
          `refuses to start until its keys move to ${join(codexHome, `${name}.config.toml`)} ` +
          "and the table is deleted.",
      );
      continue;
    }
    const profilePath = codexProfileConfigPath(codexHome, parseProfileName(name));
    const existing = readCodexToml(profilePath);
    if (existing.kind === "unparseable") {
      consola.warn(
        `  left [profiles.${name}] in ${configPath}: ${profilePath} is not valid TOML ` +
          `(${existing.error}); repair it, then re-run this migration`,
      );
      stuck.push(profilePath);
      continue;
    }
    // The file's own keys are what `codex --profile <name>` reads today, so they win over the
    // table's; the selector is ours either way.
    saveCodexToml(
      profilePath,
      {
        ...layer(table, existing.kind === "ok" ? existing.doc : {}),
        "model_provider": codexProviderId(parseProfileName(name)),
      },
      `moved from [profiles.${name}] in config.toml`,
    );
    delete profiles[name];
    changed = true;
  }
  if (changed) {
    if (Object.keys(profiles).length === 0) delete doc.profiles;
    saveCodexToml(configPath, doc, "legacy [profiles.<name>] tables moved to <name>.config.toml");
  }
  if (stuck.length > 0) {
    throw new Error(`profile file(s) not valid TOML: ${stuck.join(", ")}`);
  }
}

/** Every known Codex home; one home's failure is reported and the rest still run. */
export function moveCodexProfileTablesEverywhere(): void {
  const { homes, complete } = knownCodexHomes();
  if (!complete) {
    consola.warn(
      "  could not enumerate every ~/.codex/hosts home; a config there may keep a [profiles.<name>] table.",
    );
  }
  const failed: string[] = [];
  for (const home of homes) {
    try {
      moveCodexProfileTables(home);
    } catch (e) {
      consola.warn(`  could not convert ${codexConfigPath(home)}: ${errMessage(e)}`);
      failed.push(codexConfigPath(home));
    }
  }
  if (failed.length > 0) {
    throw new Error(`could not convert: ${failed.join(", ")}`);
  }
}

export const v409CodexProfileFiles: Migration = {
  version: "4.0.9",
  description: "move Codex named profiles from [profiles.<name>] to <name>.config.toml",
  run: moveCodexProfileTablesEverywhere,
};

// --- the `codex` integration-id pin ------------------------------------------------------
//
// Away from 4.0.9: `agent config --set integration-id codex` was accepted (the domain was a bare
// regex). The domain now refuses it (Direct's default identity sends no header, so nothing can pin
// it) and the reader folds the stored value to unset, but the key stays in preferences.json and
// the agent configs may still bake `Copilot-Integration-Id: codex` until the next rewire.

/** The RAW stored value, since the typed reader already folds `codex` to unset. Only the key goes;
 *  the agent configs are the wiring pass's to rebake. Exported for the migration test. */
export function dropCodexIdentityPin(): void {
  const paths = new CopilotApiPaths();
  const stored = new CopilotApiConfig(paths.envConfigFile, paths.envConfigLock).loadStrict()
    .integrationId;
  if (typeof stored !== "string" || stored.trim().toLowerCase() !== CODEX_IDENTITY_NAME) return;
  new CopilotEnvConfig().del("integrationId");
  consola.info(
    `  dropped the integration-id pin \`${stored}\` (Direct's default identity cannot be pinned; ` +
      "the identity now reads as auto, and Direct wiring rebakes at the next `agent init`)",
  );
}

export const v409IntegrationIdPin: Migration = {
  version: "4.0.9",
  description: "drop a stored integration-id pin of `codex` (Direct's default, no longer pinnable)",
  run: dropCodexIdentityPin,
};

// --- the `static-key` boolean --------------------------------------------------------------
//
// Away from 4.0.9: `static-key` was a boolean (bake the value into both agent configs, or into
// neither). It is now the scope `none | claude | codex | all`, and a stored boolean fails that
// domain and reads as `none`: an install that baked both would go back to the resolver command at
// its next wiring without being told.

/** The RAW stored value, since the typed reader already folds a boolean to unset. `true` becomes
 *  `all` (what the boolean baked); `false` was the default and goes. Exported for the migration test. */
export function scopeStaticKeyBoolean(): void {
  const paths = new CopilotApiPaths();
  const stored = new CopilotApiConfig(paths.envConfigFile, paths.envConfigLock).loadStrict()
    .staticKey;
  if (typeof stored !== "boolean") return;
  const config = new CopilotEnvConfig();
  if (stored) {
    config.set({ staticKey: "all" });
    consola.info(
      "  static-key `true` is now the scope `all` (both agent configs keep the baked value)",
    );
  } else {
    config.del("staticKey");
    consola.info("  dropped static-key `false` (the default, now spelled `none`)");
  }
}

export const v409StaticKeyScope: Migration = {
  version: "4.0.9",
  description: "turn the static-key boolean into its scope (`true` -> `all`, `false` -> unset)",
  run: scopeStaticKeyBoolean,
};

// --- the launchers rc block ------------------------------------------------------------------
//
// Away from 4.0.9: `agent shell` stripped the launchers block every pre-4.0.0 release wrote on
// every wire. The strip is a migration now, so an rc still carrying the block loses it once here.

/** A line equals `marker` ignoring a trailing CR (rc/profile files may be CRLF). */
const lineIs = (line: string | undefined, marker: string): boolean =>
  (line ?? "").replace(/\r$/, "") === marker;

/**
 * Every launchers block, bounded as the shell writer bounded its blocks: the marker through its
 * end fence (any other fence line first means the block was never closed and the marker line
 * alone is owned), plus the blank line before it and the ONE blank after its end fence (never the
 * file terminator). `leftBehind` is the user line directly under an unclosed marker, for the
 * caller to warn about. Exported for the migration test.
 */
export function stripLaunchersBlocks(
  content: string,
): { content: string; leftBehind: string[] } {
  const lines = content.split("\n");
  const skip = new Set<number>();
  const leftBehind: string[] = [];
  lines.forEach((line, idx) => {
    if (!lineIs(line, LAUNCHERS_MARKER)) return;
    let end = idx;
    for (let j = idx + 1; j < lines.length; j++) {
      const later = (lines[j] ?? "").replace(/\r$/, "");
      if (later === LAUNCHERS_MARKER_END) {
        end = j;
        break;
      }
      if (FENCE_LINES.includes(later)) break;
    }
    if (end === idx) {
      const next = idx + 1 < lines.length ? (lines[idx + 1] ?? "").replace(/\r$/, "") : null;
      if (next !== null && next !== "" && !FENCE_LINES.includes(next)) leftBehind.push(next);
    }
    if (idx > 0 && lineIs(lines[idx - 1], "")) skip.add(idx - 1);
    for (let i = idx; i <= end; i++) skip.add(i);
    const after = end + 1;
    if (
      after < lines.length && lineIs(lines[after], "") &&
      !(after === lines.length - 1 && lines[after] === "")
    ) skip.add(after);
  });
  if (skip.size === 0) return { content, leftBehind };
  return { content: lines.filter((_, idx) => !skip.has(idx)).join("\n"), leftBehind };
}

/** Every rc/profile file; a file that cannot be read fails the step after the others ran. */
export function stripLaunchersRcBlocks(): void {
  const failed: string[] = [];
  for (const file of shellTargetFiles()) {
    try {
      const read = readTextResult(file);
      if (read.kind === "absent") continue;
      if (read.kind === "unreadable") throw new Error(read.error);
      const stripped = stripLaunchersBlocks(read.text);
      for (const line of stripped.leftBehind) {
        consola.warn(
          `Unrecognized line under a copilot-env marker in ${file} -- ` +
            `not written by copilot-env, so it (and everything after it) was left in place: ${line}`,
        );
      }
      if (stripped.content === read.text) continue;
      writeFileReported(file, stripped.content, { detail: "copilot-env launchers block removed" });
    } catch (e) {
      consola.warn(`  could not strip ${file}: ${errMessage(e)}`);
      failed.push(file);
    }
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} file(s) were not converted: ${failed.join(", ")}`);
  }
}

export const v409LaunchersBlock: Migration = {
  version: "4.0.9",
  description: "remove the launchers rc block (the launchers are `agent env` emissions)",
  run: stripLaunchersRcBlocks,
};
