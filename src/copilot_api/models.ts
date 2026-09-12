// Aliases are derived from the live catalog so they track new models without hand edits. The proxy's
// own normalizer already maps `claude-opus-4-8` -> `claude-opus-4.8`, so aliases cover only what it
// cannot parse: the `[1m]` suffix, reasoning-effort qualifiers, and the friendly shorthands.

import { isRecord } from "../utils/json.ts";

export const ONE_M_SUFFIX = "[1m]";

const ONE_M_TOKENS = 1_000_000;

/** `id` has the display-only `[1m]` suffix stripped. */
export interface CatalogModel {
  id: string;
  is1m: boolean;
}

/** Malformed entries are skipped, never thrown on. */
export function parseCatalogModels(body: unknown): CatalogModel[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const out: CatalogModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      continue;
    }
    const suffixed = entry.id.endsWith(ONE_M_SUFFIX);
    const rawId = suffixed ? entry.id.slice(0, -ONE_M_SUFFIX.length) : entry.id;
    out.push({ id: rawId, is1m: suffixed || contextWindow(entry) === ONE_M_TOKENS });
  }
  return out;
}

function contextWindow(entry: Record<string, unknown>): number | undefined {
  const capabilities = entry.capabilities;
  if (!isRecord(capabilities)) {
    return undefined;
  }
  const limits = capabilities.limits;
  if (!isRecord(limits)) {
    return undefined;
  }
  const tokens = limits.max_context_window_tokens;
  return typeof tokens === "number" ? tokens : undefined;
}

interface ParsedModel {
  id: string;
  family: string;
  version: string;
  qualifier: string | null;
  is1m: boolean;
}

// The version accepts dash or dot (the live catalog returns `claude-opus-4-8`; a hand-built
// `claude-opus-4.8` is also valid) and an optional minor part capped at two digits.
//   claude-sonnet-5            -> version 5, no qualifier
//   claude-haiku-4-5           -> version 4.5 (greedy), not version 4 with qualifier 5
//   claude-fable-5-1m          -> version 5, qualifier 1m (backtracks)
//   claude-fable-5-20251001    -> version 5, qualifier 20251001, not version 5.20251001 (the 2-digit cap)
const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+(?:[.-]\d{1,2})?)(?:-(.+))?$/;
const GPT_ID_PATTERN = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/;

// Most capable first; `claude-latest` is the newest of the first family present. Reduced families
// (sonnet, haiku) are excluded on purpose: with no frontier family there is no `claude-latest`.
// Upstream id contracts: do not rename.
const CLAUDE_FAMILY_RANK = ["fable", "opus"];

// Matched as whole dash-separated qualifier tokens, so `terra-preview` is excluded but a qualifier
// merely containing `mini` is not. Upstream id contracts: do not rename.
const REDUCED_GPT_TIERS = new Set(["mini", "nano", "luna", "terra"]);

function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Deterministic; identity mappings are skipped because the proxy resolves an unmapped exact catalog id itself.
 *   claude-opus-4-7-high            -> claude-opus-4.7-high
 *   claude-opus-4-7[1m]             -> the family+version's 1m sibling, else the base id
 *   <family>, <family>[1m]          -> newest of that family, preferring its 1m sibling
 *   claude-latest                   -> newest of the most capable frontier family present (CLAUDE_FAMILY_RANK)
 *   gpt-latest                      -> newest non-reduced GPT; bare beats qualified on ties
 */
export function generateAliases(catalog: CatalogModel[]): Record<string, string> {
  const parsed = parseClaudeModels(catalog);

  const oneMByKey = new Map<string, string>();
  for (const p of parsed) {
    if (p.is1m) {
      oneMByKey.set(`${p.family}|${p.version}`, p.id);
    }
  }

  const aliases: Record<string, string> = {};
  // Single-number versions hit the identity skip: the dash and dot forms of `claude-sonnet-5` are the id itself.
  const put = (key: string, target: string): void => {
    if (key !== target) {
      aliases[key] = target;
    }
  };
  for (const p of parsed) {
    const dashVersion = p.version.replace(".", "-");
    if (p.qualifier === null) {
      put(`claude-${p.family}-${dashVersion}`, p.id);
      const oneM = oneMByKey.get(`${p.family}|${p.version}`) ?? p.id;
      put(`claude-${p.family}-${dashVersion}${ONE_M_SUFFIX}`, oneM);
      if (dashVersion !== p.version) {
        put(`claude-${p.family}-${p.version}${ONE_M_SUFFIX}`, oneM);
      }
    } else {
      put(`claude-${p.family}-${dashVersion}-${p.qualifier}`, p.id);
    }
  }

  // Sorted so the emitted map's key order is deterministic; a version tie still falls to catalog order.
  const families = [...new Set(parsed.map((p) => p.family))].sort();
  for (const family of families) {
    const pick = newestPreferring1m(parsed, family);
    if (pick) {
      aliases[family] = pick.id;
      aliases[`${family}${ONE_M_SUFFIX}`] = pick.id;
    }
  }

  for (const family of CLAUDE_FAMILY_RANK) {
    const pick = newestPreferring1m(parsed, family);
    if (pick) {
      aliases["claude-latest"] = pick.id;
      aliases[`claude-latest${ONE_M_SUFFIX}`] = pick.id;
      break;
    }
  }

  const gptLatest = newestGpt(catalog);
  if (gptLatest) {
    aliases["gpt-latest"] = gptLatest;
  }

  return aliases;
}

/** On a version tie the bare id wins, so `gpt-6` beats `gpt-6-<qualifier>`. */
function newestGpt(catalog: CatalogModel[]): string | undefined {
  let best: { id: string; version: string; bare: boolean } | undefined;
  for (const model of catalog) {
    const match = GPT_ID_PATTERN.exec(model.id);
    if (!match) {
      continue;
    }
    const [, version, qualifier] = match;
    if (version === undefined) {
      continue;
    }
    if (qualifier?.split("-").some((t) => REDUCED_GPT_TIERS.has(t))) {
      continue;
    }
    const bare = qualifier === undefined;
    const cmp = best ? compareVersion(version, best.version) : 1;
    if (!best || cmp > 0 || (cmp === 0 && bare && !best.bare)) {
      best = { id: model.id, version, bare };
    }
  }
  return best?.id;
}

/** Non-Claude ids are skipped: clients address those directly. The ONE place MODEL_ID_PATTERN is applied. */
function parseClaudeModels(catalog: CatalogModel[]): ParsedModel[] {
  const parsed: ParsedModel[] = [];
  for (const model of catalog) {
    const match = MODEL_ID_PATTERN.exec(model.id);
    if (!match) {
      continue;
    }
    const [, family, rawVersion, qualifier] = match;
    if (family === undefined || rawVersion === undefined) {
      continue;
    }
    // Canonical dot form ("4-8" -> "4.8") keeps sibling lookups and version compares separator-agnostic.
    const version = rawVersion.replace("-", ".");
    parsed.push({ id: model.id, family, version, qualifier: qualifier ?? null, is1m: model.is1m });
  }
  return parsed;
}

export interface ClaudeCatalogRow {
  family: string;
  id: string;
  is1m: boolean;
  /** The same pick the `<family>` alias makes. */
  familyDefault: boolean;
}

/** The whole picker list (the Claude Desktop model list) rather than an alias map: deduped by id (a
 *  1m sibling folds into `is1m`), family-ascending then newest-first. */
export function claudeCatalogRows(catalog: CatalogModel[]): ClaudeCatalogRow[] {
  const byId = new Map<string, ParsedModel>();
  for (const p of parseClaudeModels(catalog)) {
    const prev = byId.get(p.id);
    if (prev === undefined) byId.set(p.id, { ...p });
    else prev.is1m = prev.is1m || p.is1m;
  }
  const unique = [...byId.values()];
  const rows: ClaudeCatalogRow[] = [];
  for (const family of [...new Set(unique.map((p) => p.family))].sort()) {
    const pick = newestPreferring1m(unique, family);
    const members = unique
      .filter((p) => p.family === family)
      .sort((a, b) => compareVersion(b.version, a.version));
    for (const m of members) {
      rows.push({ family, id: m.id, is1m: m.is1m, familyDefault: m.id === pick?.id });
    }
  }
  return rows;
}

function newest(
  parsed: ParsedModel[],
  family: string,
  predicate: (p: ParsedModel) => boolean,
): ParsedModel | undefined {
  let best: ParsedModel | undefined;
  for (const p of parsed) {
    if (
      p.family === family &&
      predicate(p) &&
      (!best || compareVersion(p.version, best.version) > 0)
    ) {
      best = p;
    }
  }
  return best;
}

/** The 1m sibling of the newest version wins over the newest version itself. */
function newestPreferring1m(parsed: ParsedModel[], family: string): ParsedModel | undefined {
  const pick = newest(parsed, family, () => true);
  if (!pick) {
    return undefined;
  }
  return newest(parsed, family, (p) => p.is1m && p.version === pick.version) ?? pick;
}

export interface ModelListEntry {
  id: string;
  name: string | null;
  vendor: string | null;
  /** Upstream `capabilities.type` ("chat", "embeddings", ...). */
  type: string | null;
  /** Upstream `capabilities.limits.max_context_window_tokens`. */
  contextWindow: number | null;
  /** Upstream `capabilities.limits.max_output_tokens`. */
  maxOutput: number | null;
  preview: boolean;
  /** Not advertised by the catalog but VERIFIED servable by discovery.ts. parseModelList never sets it. */
  unlisted?: boolean;
}

/** The shared row shape, so `agent models` and the Desktop wiring see the same list. */
export function mergeUnlistedModels(
  entries: ModelListEntry[],
  discovered: { models: CatalogModel[]; unlisted: string[] },
): ModelListEntry[] {
  const extras: ModelListEntry[] = [];
  for (const id of discovered.unlisted) {
    const model = discovered.models.find((m) => m.id === id);
    if (model === undefined) continue;
    extras.push({
      id,
      name: null,
      vendor: "Anthropic",
      type: "chat",
      // The 1m probe proved the window class; a non-1m extra's exact cap is unknown.
      contextWindow: model.is1m ? 1_000_000 : null,
      maxOutput: null,
      preview: false,
      unlisted: true,
    });
  }
  return [...entries, ...extras].sort((a, b) => a.id.localeCompare(b.id));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function toEntry(raw: Record<string, unknown>, id: string): ModelListEntry {
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
  const limits = isRecord(capabilities.limits) ? capabilities.limits : {};
  return {
    id,
    name: nonEmptyString(raw.name),
    vendor: nonEmptyString(raw.vendor),
    type: nonEmptyString(capabilities.type),
    contextWindow: positiveNumber(limits.max_context_window_tokens),
    maxOutput: positiveNumber(limits.max_output_tokens),
    preview: raw.preview === true,
  };
}

/**
 * The ONE pipeline behind `agent models` and the Claude Desktop model list. Ids are kept VERBATIM,
 * `[1m]` suffix included: the listing answers "what can a client address", not "what is distinct".
 *   no `data` array   -> ERROR, so upstream schema drift cannot silently print "no models"
 *   `{data: []}`      -> a valid empty catalog
 *   duplicate ids     -> merged field-wise, first non-null wins, so a bare duplicate cannot mask a named one
 */
export function parseModelList(body: unknown): ModelListEntry[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("unexpected /models response shape (no data array)");
  }
  const byId = new Map<string, ModelListEntry>();
  for (const raw of body.data) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") {
      continue;
    }
    const entry = toEntry(raw, raw.id);
    const existing = byId.get(entry.id);
    if (existing === undefined) {
      byId.set(entry.id, entry);
      continue;
    }
    existing.name ??= entry.name;
    existing.vendor ??= entry.vendor;
    existing.type ??= entry.type;
    existing.contextWindow ??= entry.contextWindow;
    existing.maxOutput ??= entry.maxOutput;
    // preview has no "missing" state (absent parses as false), so any-true wins.
    existing.preview ||= entry.preview;
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
