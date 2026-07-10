// Migration from 3.3.17: drop the stale Codex image-generation disable.
//
// Up to 3.3.17 the Codex direct config writer set features.image_generation = false
// (Copilot Direct didn't serve image generation then; it does now). The writer no
// longer manages [features] at all, so an existing direct install that merely runs
// `agent update` would keep the stale disable forever. Remove the key from the
// managed config -- and the [features] table when that leaves it empty -- so Codex
// offers the feature again. User-added [features] keys survive.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { parse, stringify } from "smol-toml";

import { CODEX_PROVIDER_ID, effectiveCodexHome } from "../codex/config.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import type { Migration } from "./index.ts";

/**
 * Delete the managed `image_generation = false` from the Codex config's [features]
 * table (a parse/stringify rewrite: every field survives, TOML comments/formatting
 * do not -- same trade-off as the 3.3.6 migration). Idempotent: a config without the
 * disable is left untouched, as is one that is not actively ours (our provider table
 * present AND selected as model_provider -- a leftover table under another provider
 * is not ours to touch). Only `false` is scrubbed -- the value we wrote; a user who
 * set it to `false` themselves is indistinguishable, but direct mode force-rewrote
 * it every run anyway, so nothing user-authored can be lost that the old writer
 * wasn't already overwriting.
 */
function dropCodexImageGenerationDisable(): void {
  const configPath = join(effectiveCodexHome(), "config.toml");
  if (!existsSync(configPath)) return; // no Codex config -- nothing to heal
  try {
    const doc = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const providers = isRecord(doc.model_providers) ? doc.model_providers : null;
    if (providers === null || !isRecord(providers[CODEX_PROVIDER_ID])) return; // not managed
    if (doc.model_provider !== CODEX_PROVIDER_ID) return; // our table present but not selected
    if (!isRecord(doc.features) || doc.features.image_generation !== false) return;
    delete doc.features.image_generation;
    if (Object.keys(doc.features).length === 0) delete doc.features;
    writeFileSync(configPath, stringify(doc));
    consola.info(`Removed the stale image-generation disable from ${configPath}`);
  } catch (e) {
    consola.warn(`Could not remove the image-generation disable (non-fatal): ${errMessage(e)}`);
  }
}

export const migration: Migration = {
  version: "3.3.17",
  description: "drop the stale Codex image-generation disable (Copilot Direct serves it now)",
  run: () => {
    dropCodexImageGenerationDisable();
  },
};
