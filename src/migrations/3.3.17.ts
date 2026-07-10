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

/**
 * Raise the managed direct provider's `auth.timeout_ms` from 15000 (the value every
 * release up to 3.3.17 wrote) to 30000: the auth command now also runs a bounded,
 * at-most-daily model-catalog refresh after printing the token (a /models fetch plus
 * a `codex debug models --bundled` dump), which can overrun the old budget. Without
 * this, an existing install that only ever runs `agent update` keeps 15000 and Codex
 * can time the auth command out on the one call per day that refreshes the catalog.
 * Idempotent and surgical: only OUR selected provider's auth block, and only the
 * exact 15000 the old writer produced -- any other value is user-tuned, not ours.
 */
function raiseCodexDirectAuthTimeout(): void {
  const configPath = join(effectiveCodexHome(), "config.toml");
  if (!existsSync(configPath)) return; // no Codex config -- nothing to heal
  try {
    const doc = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const providers = isRecord(doc.model_providers) ? doc.model_providers : null;
    if (providers === null || !isRecord(providers[CODEX_PROVIDER_ID])) return; // not managed
    if (doc.model_provider !== CODEX_PROVIDER_ID) return; // our table present but not selected
    const auth = providers[CODEX_PROVIDER_ID].auth;
    if (!isRecord(auth) || auth.timeout_ms !== 15000) return;
    // The 15000 budget belongs to the DIRECT auth command (agent auth --get); the
    // proxy resolver writes 180000 and different args. Match the args as a SUFFIX:
    // POSIX invokes the launcher with exactly ["auth", "--get"], while Windows
    // prepends the PowerShell boilerplate (-NoProfile ... -File agent.ps1) before
    // the same two elements. Two distinct elements, not a joined string, so a
    // lookalike single-element ["auth --get"] never matches.
    if (!Array.isArray(auth.args) || auth.args.length < 2) return;
    const [subcommand, flag] = auth.args.slice(-2);
    if (subcommand !== "auth" || flag !== "--get") return;
    auth.timeout_ms = 30000;
    writeFileSync(configPath, stringify(doc));
    consola.info(`Raised the Codex direct auth timeout to 30s in ${configPath}`);
  } catch (e) {
    consola.warn(`Could not raise the Codex direct auth timeout (non-fatal): ${errMessage(e)}`);
  }
}

export const migration: Migration = {
  version: "3.3.17",
  description:
    "drop the stale Codex image-generation disable; raise the direct auth timeout for the catalog refresh",
  run: () => {
    dropCodexImageGenerationDisable();
    raiseCodexDirectAuthTimeout();
  },
};
