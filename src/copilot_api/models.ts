// Catalog-driven model-alias generation (pure; no I/O).
//
// The daemon proxies GitHub Copilot's live model catalog (fetched via
// `CopilotAdminClient.getModels`). We derive the alias map mechanically so it
// tracks new models without hand edits.
//
// The proxy's own request-time normalizer already maps the plain dash form to
// the dot form (`claude-opus-4-8` -> `claude-opus-4.8`); aliases are generated
// only for the forms it cannot parse: the `[1m]` suffix, reasoning-effort
// qualifiers, and the friendly `opus` / `sonnet` / `haiku` shorthands.

/** The display-only 1M-context suffix on catalog ids (single source of truth). */
export const ONE_M_SUFFIX = "[1m]";

/** A catalog entry, with the display-only `[1m]` suffix stripped from `id`. */
export interface CatalogModel {
  /** Raw upstream model id (e.g. `claude-opus-4.7-1m-internal`). */
  id: string;
  /** Whether this model exposes a 1M-token context window. */
  is1m: boolean;
}

/** A `claude-<family>-<version>[-<qualifier>]` id, decomposed. */
interface ParsedModel {
  id: string;
  family: string;
  version: string;
  qualifier: string | null;
  is1m: boolean;
}

const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+\.\d+)(?:-(.+))?$/;
const GPT_ID_PATTERN = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/;

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
 * - base id          -> dash alias (`claude-opus-4-8` -> `claude-opus-4.8`)
 * - `[1m]` requests  -> the family+version's 1m sibling, else the base id
 * - qualifier ids    -> dash alias (`claude-opus-4-7-high` -> `claude-opus-4.7-high`)
 * - `opus`/`opus[1m]`-> newest opus version that has a 1m variant
 * - `sonnet`/`haiku` -> newest of that family (1m sibling preferred)
 * - `gpt-latest`      -> newest non-mini GPT (the flagship)
 */
export function generateAliases(catalog: CatalogModel[]): Record<string, string> {
  const parsed: ParsedModel[] = [];
  for (const model of catalog) {
    const match = MODEL_ID_PATTERN.exec(model.id);
    if (!match) {
      continue; // non-claude (gpt/gemini/...) -- clients address these directly
    }
    const [, family, version, qualifier] = match;
    if (family === undefined || version === undefined) {
      continue;
    }
    parsed.push({ id: model.id, family, version, qualifier: qualifier ?? null, is1m: model.is1m });
  }

  // family+version -> the 1m-capable sibling's id, if any.
  const oneMByKey = new Map<string, string>();
  for (const p of parsed) {
    if (p.is1m) {
      oneMByKey.set(`${p.family}|${p.version}`, p.id);
    }
  }

  const aliases: Record<string, string> = {};
  for (const p of parsed) {
    const dashVersion = p.version.replace(".", "-");
    if (p.qualifier === null) {
      aliases[`claude-${p.family}-${dashVersion}`] = p.id;
      const oneM = oneMByKey.get(`${p.family}|${p.version}`) ?? p.id;
      aliases[`claude-${p.family}-${dashVersion}${ONE_M_SUFFIX}`] = oneM;
      aliases[`claude-${p.family}-${p.version}${ONE_M_SUFFIX}`] = oneM;
    } else {
      aliases[`claude-${p.family}-${dashVersion}-${p.qualifier}`] = p.id;
    }
  }

  // Friendly shorthands.
  const opus = newestPreferring1m(parsed, "opus");
  if (opus) {
    aliases.opus = opus.id;
    aliases[`opus${ONE_M_SUFFIX}`] = opus.id;
  }
  for (const family of ["sonnet", "haiku"]) {
    const pick = newestPreferring1m(parsed, family);
    if (pick) {
      aliases[family] = pick.id;
    }
  }

  // `gpt-latest` -> the newest non-mini GPT, so a small-model/config pin that
  // wants "whatever the current flagship GPT is" need not be re-set each release.
  const gptLatest = newestGpt(catalog);
  if (gptLatest) {
    aliases["gpt-latest"] = gptLatest;
  }

  return aliases;
}

/**
 * Newest non-mini GPT id in the catalog (the flagship), or undefined. The
 * reduced `mini`/`nano` tiers are excluded; on a version tie the bare id (no
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
    if (qualifier !== undefined && /mini|nano/.test(qualifier)) {
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

/** Newest model of `family`, preferring a 1m-context sibling and otherwise the newest of the family. */
function newestPreferring1m(parsed: ParsedModel[], family: string): ParsedModel | undefined {
  return newest(parsed, family, (p) => p.is1m) ?? newest(parsed, family, () => true);
}
