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
  const parsed: ParsedModel[] = [];
  for (const model of catalog) {
    const match = MODEL_ID_PATTERN.exec(model.id);
    if (!match) {
      continue; // non-claude (gpt/gemini/...) -- clients address these directly
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
    if (qualifier !== undefined && qualifier.split("-").some((t) => REDUCED_GPT_TIERS.has(t))) {
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

/** Newest model of `family`, preferring the 1m-capable sibling of that newest version. */
function newestPreferring1m(parsed: ParsedModel[], family: string): ParsedModel | undefined {
  const pick = newest(parsed, family, () => true);
  if (!pick) {
    return undefined;
  }
  return newest(parsed, family, (p) => p.is1m && p.version === pick.version) ?? pick;
}
