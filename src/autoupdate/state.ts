// A typed wrapper over CopilotApiConfig, the project's atomic JSON store, like CopilotEnvRunState,
// so autoupdate adds no second I/O implementation.
//
//   this file            -> throttle only: when the last check ran and how it went
//   `auto-update` config -> the preference itself, never copied here
import * as v from "valibot";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { autoupdateStateFile } from "./paths.ts";

/** Default release cooldown for autoupdate: adopt releases at least this old. */
export const DEFAULT_AUTOUPDATE_COOLDOWN_DAYS = 7;

/** Always the live `update-cooldown` config, never snapshotted into state, so `agent config
 *  --set update-cooldown N` takes effect on the next run. */
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

  /** The plain load() flatten (unreadable reads as "never checked") is ACCEPTED, decided rather
   *  than inherited: this state only paces the best-effort preflight, and its writes go
   *  through update(), which refuses. */
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
