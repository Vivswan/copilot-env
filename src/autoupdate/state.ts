// Opt-in autoupdate state, persisted to `<install>/.autoupdate/state.json`.
//
// Thin typed wrapper over CopilotApiConfig (the project's atomic JSON store:
// sorted keys, 0600, atomic rename, Windows retry) -- mirroring CopilotEnvRunState,
// so there's no second I/O implementation.
import * as v from "valibot";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { autoupdateStateFile } from "./paths.ts";

/** Default release cooldown for autoupdate: adopt releases at least this old. */
export const DEFAULT_AUTOUPDATE_COOLDOWN_DAYS = 7;

/**
 * The effective autoupdate cooldown is always the live `update-cooldown` config, so
 * `agent config --set update-cooldown N` takes effect on the next run; it is never
 * snapshotted into state.
 */
export function effectiveUpdateCooldownDays(): number {
  return new CopilotEnvConfig().read().updateCooldown ?? DEFAULT_AUTOUPDATE_COOLDOWN_DAYS;
}

export interface AutoupdateData {
  /** Whether the once-per-day self-update preflight is active. */
  enabled: boolean;
  /** Epoch ms of the last completed check (0 if never). */
  lastCheckMs: number;
  /** Human summary of the last check, e.g. "updated v1.2.3" / "up to date". */
  lastResult: string;
}

type AutoupdatePatch = { [K in keyof AutoupdateData]?: AutoupdateData[K] | null };

// Lenient read schema: absent or ill-typed fields fall back to safe defaults rather
// than throwing. `lastCheckMs` must be finite (rejects NaN/Infinity).
const AUTOUPDATE_SCHEMA = v.object({
  enabled: v.fallback(v.boolean(), false),
  lastCheckMs: v.fallback(v.pipe(v.number(), v.finite(), v.minValue(0)), 0),
  lastResult: v.fallback(v.string(), ""),
});

export class AutoupdateState {
  private readonly store: CopilotApiConfig;

  constructor(path?: string) {
    this.store = new CopilotApiConfig(path ?? autoupdateStateFile());
  }

  /** Current state; absent or ill-typed fields fall back to safe defaults. */
  read(): AutoupdateData {
    return v.parse(AUTOUPDATE_SCHEMA, this.store.load());
  }

  /** Merge `patch` into the file; a `null` (or `undefined`) value deletes its key. */
  set(patch: AutoupdatePatch): void {
    this.store.update((d) => {
      for (const key of Object.keys(patch) as (keyof AutoupdatePatch)[]) {
        const value = patch[key];
        if (value === null || value === undefined) {
          delete d[key];
        } else {
          d[key] = value;
        }
      }
    });
  }
}
