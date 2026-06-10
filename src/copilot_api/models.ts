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

const ONE_M_SUFFIX = "[1m]";

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
 */
export function generateAliases(catalog: CatalogModel[]): Record<string, string> {
  const parsed: ParsedModel[] = [];
  for (const model of catalog) {
    const match = MODEL_ID_PATTERN.exec(model.id);
    if (!match) {
      continue; // non-claude (gpt/gemini/...) — clients address these directly
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
  const opus = newest(parsed, "opus", (p) => p.is1m) ?? newest(parsed, "opus", () => true);
  if (opus) {
    aliases.opus = opus.id;
    aliases[`opus${ONE_M_SUFFIX}`] = opus.id;
  }
  for (const family of ["sonnet", "haiku"]) {
    const pick = newest(parsed, family, (p) => p.is1m) ?? newest(parsed, family, () => true);
    if (pick) {
      aliases[family] = pick.id;
    }
  }

  return aliases;
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
