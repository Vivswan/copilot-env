// Catalog-driven model-alias generation (pure; no I/O).
//
// The daemon proxies GitHub Copilot's live model catalog (fetched via
// `CopilotAdminClient.getModels`). We derive the alias map mechanically so it
// tracks new models without hand edits.
//
// The proxy's own request-time normalizer already maps the plain dash form to
// the dot form (`claude-opus-4-8` -> `claude-opus-4.8`); aliases are generated
// only for the forms it cannot parse: the `[1m]` suffix, reasoning-effort
// qualifiers, and the friendly shorthands (one per Claude family, plus
// `claude-latest` / `gpt-latest`). Identity mappings (key === target) are
// skipped: an unmapped id that already equals a catalog id passes through
// unchanged, so they would be no-ops.

import { isRecord } from "../utils/json.ts";

/** The display-only 1M-context suffix on catalog ids (single source of truth). */
export const ONE_M_SUFFIX = "[1m]";

const ONE_M_TOKENS = 1_000_000;

/** A catalog entry, with the display-only `[1m]` suffix stripped from `id`. */
export interface CatalogModel {
  /** Raw upstream model id (e.g. `claude-opus-4.7-1m-internal`). */
  id: string;
  /** Whether this model exposes a 1M-token context window. */
  is1m: boolean;
}

/**
 * Parse a raw `/models` body (proxy and direct serve the same shape) into
 * `CatalogModel[]`, normalizing the display-only `[1m]` suffix. Malformed
 * entries are skipped, never thrown on.
 */
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

/** Read `capabilities.limits.max_context_window_tokens` defensively. */
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

/** A `claude-<family>-<version>[-<qualifier>]` id, decomposed. */
interface ParsedModel {
  id: string;
  family: string;
  version: string;
  qualifier: string | null;
  is1m: boolean;
}

// The version separator may arrive dash- or dot-form: the live catalog returns
// `claude-opus-4-8`, while a hand-built dot-form id (`claude-opus-4.8`) is also
// valid. We capture either and normalize to the canonical dot form below. The
// minor part is optional so single-number generations (`claude-sonnet-5`,
// `claude-fable-5`) parse too, and capped at two digits so a dated snapshot
// (`claude-fable-5-20251001`) stays a qualifier instead of becoming version
// 5.20251001. Greediness keeps `claude-haiku-4-5` as version 4.5 (not version
// 4 with qualifier `5`), while `claude-fable-5-1m` backtracks to version 5
// with qualifier `1m`.
const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+(?:[.-]\d{1,2})?)(?:-(.+))?$/;
const GPT_ID_PATTERN = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/;

// Frontier Claude families ordered by capability, most capable first;
// `claude-latest` resolves to the newest model of the first family present in
// the catalog. Reduced families (sonnet, haiku) are deliberately excluded:
// with no frontier family in the catalog there is no `claude-latest`.
// These family names are upstream id contracts -- do not rename.
const CLAUDE_FAMILY_RANK = ["fable", "opus"];

// Reduced GPT tiers that are never the flagship, matched as whole dash-
// separated qualifier tokens (so `terra-preview` is excluded but a qualifier
// merely containing `mini` is not). Upstream id contracts -- do not rename.
const REDUCED_GPT_TIERS = new Set(["mini", "nano", "luna", "terra"]);

/** Compare two `major.minor` version strings; >0 when `a` is newer. */
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
 * Derive the alias map from a catalog. Deterministic (no clock / randomness).
 *
 * - base id            -> dash alias (`claude-opus-4-8` -> `claude-opus-4.8`)
 * - `[1m]` requests    -> the family+version's 1m sibling, else the base id
 * - qualifier ids      -> dash alias (`claude-opus-4-7-high` -> `claude-opus-4.7-high`)
 * - `<family>`/`[1m]`  -> newest of that family, preferring that version's
 *                         1m-capable sibling (every Claude family in the
 *                         catalog, sorted order)
 * - `claude-latest`    -> newest model of the most capable frontier family
 *                         present (`fable` > `opus`; sonnet/haiku excluded)
 * - `gpt-latest`       -> newest best-of-class GPT (mini/nano/luna/terra
 *                         excluded; bare beats qualified on ties)
 *
 * Identity mappings (key === target) are skipped: pass-through is equivalent.
 */
export function generateAliases(catalog: CatalogModel[]): Record<string, string> {
  const parsed = parseClaudeModels(catalog);

  // family+version -> the 1m-capable sibling's id, if any.
  const oneMByKey = new Map<string, string>();
  for (const p of parsed) {
    if (p.is1m) {
      oneMByKey.set(`${p.family}|${p.version}`, p.id);
    }
  }

  const aliases: Record<string, string> = {};
  // Identity mappings are pass-through no-ops (the proxy resolves an unmapped
  // exact catalog id itself); skip them. Single-number versions hit this: the
  // dash and dot forms of `claude-sonnet-5` are both the id itself.
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

  // Friendly shorthands: `<family>` and `<family>[1m]` for every Claude family
  // in the catalog, resolving to the newest version and preferring that
  // version's 1m-capable sibling. Sorted so the emitted map is deterministic
  // regardless of catalog order.
  const families = [...new Set(parsed.map((p) => p.family))].sort();
  for (const family of families) {
    const pick = newestPreferring1m(parsed, family);
    if (pick) {
      aliases[family] = pick.id;
      aliases[`${family}${ONE_M_SUFFIX}`] = pick.id;
    }
  }

  // `claude-latest` -> the most capable Claude available: the newest model of
  // the highest-ranked frontier family present. Sonnet/haiku and unranked
  // families keep only their own `<family>` shorthand.
  for (const family of CLAUDE_FAMILY_RANK) {
    const pick = newestPreferring1m(parsed, family);
    if (pick) {
      aliases["claude-latest"] = pick.id;
      aliases[`claude-latest${ONE_M_SUFFIX}`] = pick.id;
      break;
    }
  }

  // `gpt-latest` -> the most capable GPT available, so a small-model/config
  // pin that wants "whatever the current flagship GPT is" need not be re-set
  // each release.
  const gptLatest = newestGpt(catalog);
  if (gptLatest) {
    aliases["gpt-latest"] = gptLatest;
  }

  return aliases;
}

/**
 * Most capable GPT id in the catalog (the flagship), or undefined. Latest
 * always points at a best-of-class model: the reduced tiers in
 * `REDUCED_GPT_TIERS` are excluded outright. On a version tie the bare id (no
 * qualifier) wins, so `gpt-6` beats a hypothetical `gpt-6-<qualifier>`.
 */
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
      continue; // a reduced tier is never the flagship
    }
    const bare = qualifier === undefined;
    const cmp = best ? compareVersion(version, best.version) : 1;
    if (!best || cmp > 0 || (cmp === 0 && bare && !best.bare)) {
      best = { id: model.id, version, bare };
    }
  }
  return best?.id;
}

/** Parse the Claude ids out of a catalog; non-Claude ids (gpt/gemini/...) are skipped --
 *  clients address those directly. The ONE place MODEL_ID_PATTERN is applied. */
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
    // Canonical version is dot-form ("4-8" -> "4.8") so sibling lookups and
    // version compares stay separator-agnostic regardless of the catalog's form.
    const version = rawVersion.replace("-", ".");
    parsed.push({ id: model.id, family, version, qualifier: qualifier ?? null, is1m: model.is1m });
  }
  return parsed;
}

/** One Claude catalog model -- see claudeCatalogRows. */
export interface ClaudeCatalogRow {
  family: string;
  id: string;
  is1m: boolean;
  /** This is the family's newest model (the pick the `<family>` alias makes). */
  familyDefault: boolean;
}

/** EVERY Claude model in `catalog`, deduped by id (a 1m sibling entry folds into
 *  `is1m`), family-ascending then newest-first, with each family's newest marked as
 *  its default -- the same choice the `<family>` alias shorthands make. For consumers
 *  needing the whole picker list rather than an alias map (the Claude Desktop
 *  model list). */
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

/** Newest model of `family` matching `predicate`, by version. */
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

/** Newest model of `family`, preferring the 1m-capable sibling of that newest version. */
function newestPreferring1m(parsed: ParsedModel[], family: string): ParsedModel | undefined {
  const pick = newest(parsed, family, () => true);
  if (!pick) {
    return undefined;
  }
  return newest(parsed, family, (p) => p.is1m && p.version === pick.version) ?? pick;
}

/** One catalog entry: the addressable id plus the display fields `agent models` shows. */
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
  /** True for models the catalog does not advertise but discovery VERIFIED servable
   *  (src/copilot_api/discovery.ts). parseModelList never sets it. */
  unlisted?: boolean;
}

/** Fold discovery's verified-but-unadvertised models into a parsed model list --
 *  the shared render/consume shape, so every consumer of the unified pipeline
 *  (agent models, the Desktop wiring) sees the same rows. */
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
 * Parse a raw `/models` body into id-sorted, id-deduped entries (pure) -- the ONE
 * pipeline behind `agent models` and the Claude Desktop model list.
 * Ids are kept VERBATIM -- including a display-only `[1m]` suffix -- because
 * the listing answers "what can a client address", not "what is distinct".
 * An envelope without a `data` array is an ERROR, not an empty catalog, so
 * upstream schema drift cannot silently print "no models"; `{data: []}`
 * stays a valid (empty) catalog. Duplicate ids merge field-wise, first
 * non-null value wins, so a bare duplicate cannot mask a named one.
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
