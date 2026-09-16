// Claude Code sends the model it resolved verbatim, and Copilot answers an id outside its catalog
// with an empty result on every turn while the Direct wiring still probes fine. The launcher warns
// once and never writes a model: the saved choice stays the user's.
import { homedir } from "node:os";
import { sep } from "node:path";
import type { ManagedAgentMode } from "../agents/provider_mode.ts";
import {
  type CatalogModel,
  claudeCatalogRows,
  generateAliases,
  ONE_M_SUFFIX,
} from "../copilot_api/models.ts";
import { readTextOrNull } from "../utils/fs.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";

/** Claude Code's own env override; it beats every settings `model` key. */
const MODEL_ENV = "ANTHROPIC_MODEL";

/**
 * Resolved in Claude Code's order. `--model` or an extra `--settings` in the passthrough args is the
 * user's own override and is not parsed; the built-in default is one copilot-env cannot know.
 *   $ANTHROPIC_MODEL (process env, then a settings `env` block)  -> known
 *   `model` of the first settings file that carries one          -> known
 */
export type ClaudeModelChoice =
  | { kind: "user-supplied" }
  | { kind: "known"; model: string; source: string }
  | { kind: "builtin" };

/** `settingsPaths` in precedence order: `claude --settings <profile>` merges over settings.json. */
export function claudeModelChoice(
  args: readonly string[],
  settingsPaths: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ClaudeModelChoice {
  const overrides = ["--model", "--settings"];
  if (args.some((a) => overrides.some((o) => a === o || a.startsWith(`${o}=`)))) {
    return { kind: "user-supplied" };
  }
  const fromEnv = env[MODEL_ENV];
  if (fromEnv) return { kind: "known", model: fromEnv, source: `$${MODEL_ENV}` };
  const docs = settingsPaths.flatMap((path) => {
    const text = readTextOrNull(path);
    const doc = text === null ? null : parseJsonRecord(text);
    return doc === null ? [] : [{ path, doc }];
  });
  // Claude Code merges the files per key, so a blank value in the winning file MASKS the one below
  // it and then reads as unset; hence "first file that has the key", then "is it blank".
  const firstWith = (read: (doc: Record<string, unknown>) => string | null) => {
    for (const { path, doc } of docs) {
      const value = read(doc);
      if (value !== null) return { path, value };
    }
    return null;
  };
  const envBlock = firstWith((doc) =>
    isRecord(doc.env) ? readStringField(doc.env, MODEL_ENV) : null
  );
  if (envBlock?.value) {
    return {
      kind: "known",
      model: envBlock.value,
      source: `env.${MODEL_ENV} in ${displayPath(envBlock.path)}`,
    };
  }
  const modelKey = firstWith((doc) => readStringField(doc, "model"));
  if (modelKey?.value) {
    return { kind: "known", model: modelKey.value, source: displayPath(modelKey.path) };
  }
  return { kind: "builtin" };
}

/** Claude Code strips `[1m]` before the request, so the bare value is what the endpoint judges. */
function servable(bare: string, catalog: CatalogModel[], mode: ManagedAgentMode): boolean {
  if (catalog.some((m) => m.id === bare)) return true;
  // The proxy resolves every generated alias; Direct resolves nothing, so only the family
  // shorthands Claude Code itself accepts (`opus`, `sonnet`) count there.
  if (mode === "proxy") return bare in generateAliases(catalog);
  return claudeCatalogRows(catalog).some((r) => r.family === bare);
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Null = the session's model is servable, or unknown with a catalog that can serve some Claude
 *  model. One line, stderr-bound. A user-supplied choice never reaches here: the caller skips the
 *  fetch. */
export function unservableClaudeModelWarning(
  choice: Exclude<ClaudeModelChoice, { kind: "user-supplied" }>,
  catalog: CatalogModel[],
  mode: ManagedAgentMode,
): string | null {
  const rows = claudeCatalogRows(catalog);
  if (choice.kind === "builtin") {
    return rows.length === 0
      ? "WARN the Copilot catalog lists no Claude model, so Claude Code's built-in default model cannot be served"
      : null;
  }
  const bare = choice.model.endsWith(ONE_M_SUFFIX)
    ? choice.model.slice(0, -ONE_M_SUFFIX.length)
    : choice.model;
  if (servable(bare, catalog, mode)) return null;
  // Catalog order, not the picker's most-capable-first: the hint only has to be servable.
  const claudeIds = new Set(rows.map((r) => r.id));
  const first = catalog.find((m) => claudeIds.has(m.id));
  const hint = first === undefined ? "it lists no Claude model" : `try /model ${first.id}`;
  return `WARN Claude model '${choice.model}' (from ${choice.source}) ` +
    `is not in the Copilot catalog; ${hint}`;
}
