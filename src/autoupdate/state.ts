// Autoupdate THROTTLE state, persisted to `<install>/.autoupdate/state.json`: the
// last check and its result. The preference itself is the `auto-update` config key
// (CopilotEnvConfig), never this file: a pre-key `enabled` field is never read and
// is dropped (printed) by the next write.
//
// Thin typed wrapper over CopilotApiConfig (the project's atomic JSON store:
// sorted keys, 0600, atomic rename, Windows retry) -- mirroring CopilotEnvRunState,
// so there's no second I/O implementation.
import * as v from "valibot";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { autoupdateStateFile } from "./paths.ts";

const logger = createStderrLogger();

/** The state-file key that carried the preference before the `auto-update` config key. */
const LEGACY_ENABLED_KEY = "enabled";

/** Default release cooldown for autoupdate: adopt releases at least this old. */
export const DEFAULT_AUTOUPDATE_COOLDOWN_DAYS = 7;

/**
 * The effective autoupdate cooldown is always the live `update-cooldown` config, so
 * `agent config --set update-cooldown N` takes effect on the next run; it is never
 * snapshotted into state.
 */
export function effectiveUpdateCooldownDays(): number {
  return new CopilotEnvConfig().updateCooldownDays() ?? DEFAULT_AUTOUPDATE_COOLDOWN_DAYS;
}

export interface AutoupdateData {
  /** Epoch ms of the last completed check (0 if never). */
  lastCheckMs: number;
  /** Human summary of the last check, e.g. "updated v1.2.3" / "up to date". */
  lastResult: string;
}

type AutoupdatePatch = { [K in keyof AutoupdateData]?: AutoupdateData[K] | null };

// Lenient read schema: absent or ill-typed fields fall back to safe defaults rather
// than throwing. `lastCheckMs` must be finite (rejects NaN/Infinity).
const AUTOUPDATE_SCHEMA = v.object({
  lastCheckMs: v.fallback(v.pipe(v.number(), v.finite(), v.minValue(0)), 0),
  lastResult: v.fallback(v.string(), ""),
});

export class AutoupdateState {
  private readonly store: CopilotApiConfig;
  readonly path: string;

  constructor(path?: string) {
    this.path = path ?? autoupdateStateFile();
    this.store = new CopilotApiConfig(this.path);
  }

  /** Current state; absent or ill-typed fields fall back to safe defaults. The
   *  plain load() flatten (unreadable reads as "never checked") is ACCEPTED,
   *  decided rather than inherited: this state only paces the best-effort
   *  preflight, and its writes go through update(), which refuses. */
  read(): AutoupdateData {
    return v.parse(AUTOUPDATE_SCHEMA, this.store.load());
  }

  /** Merge `patch` into the file; a `null` (or `undefined`) value deletes its key. A
   *  pre-key `enabled` field still in the file leaves with this write, reported. */
  set(patch: AutoupdatePatch): void {
    let droppedLegacy = false;
    this.store.update((d) => {
      if (LEGACY_ENABLED_KEY in d) {
        delete d[LEGACY_ENABLED_KEY];
        droppedLegacy = true;
      }
      for (const key of Object.keys(patch) as (keyof AutoupdatePatch)[]) {
        const value = patch[key];
        if (value === null || value === undefined) {
          delete d[key];
        } else {
          d[key] = value;
        }
      }
    });
    if (droppedLegacy) {
      logger.info(
        `Dropped the legacy autoupdate flag (the preference is the auto-update config key) -> ${this.path}`,
      );
    }
  }
}
