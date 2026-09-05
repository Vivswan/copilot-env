// Autoupdate THROTTLE state, persisted to `<install>/.autoupdate/state.json`: the
// last check and its result. The preference itself is the `auto-update` config key
// (CopilotEnvConfig), never this file.
//
// Thin typed wrapper over CopilotApiConfig (the project's atomic JSON store:
// sorted keys, 0600, atomic rename, Windows retry) -- mirroring CopilotEnvRunState,
// so there's no second I/O implementation.
import * as v from "valibot";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { autoupdateStateFile } from "./paths.ts";

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

  /** The pre-key `enabled` field, if this file still carries one: present with any
   *  value (a junk value is still a leftover to drop), on only when exactly `true`. */
  legacyEnabled(): { present: false } | { present: true; on: boolean } {
    const doc = this.store.load();
    if (!(LEGACY_ENABLED_KEY in doc)) return { present: false };
    return { present: true, on: doc[LEGACY_ENABLED_KEY] === true };
  }

  /** Current state; absent or ill-typed fields fall back to safe defaults. The
   *  plain load() flatten (unreadable reads as "never checked") is ACCEPTED,
   *  decided rather than inherited: this state only paces the best-effort
   *  preflight, and its writes go through update(), which refuses. */
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

  /** Drop the pre-key `enabled` flag from the file. */
  dropLegacyEnabled(): void {
    this.store.update((d) => {
      delete d[LEGACY_ENABLED_KEY];
    });
  }
}

/** The state-file key that carried the preference before the `auto-update` config key. */
const LEGACY_ENABLED_KEY = "enabled";

/** Self-heal for pre-key installs (the manual update and the preflight run it): a
 *  legacy `enabled: true` in state.json moves into an UNSET `auto-update` key, then
 *  the field leaves the file. `report` fires right after each write. */
export function adoptLegacyEnabledFlag(
  report: (line: string) => void,
  state: AutoupdateState = new AutoupdateState(),
  config: CopilotEnvConfig = new CopilotEnvConfig(),
): void {
  const legacy = state.legacyEnabled();
  if (!legacy.present) return;
  if (legacy.on && config.adopt("autoUpdate", true)) {
    report(
      `Recorded auto-update = true (adopted the legacy autoupdate flag from ${state.path}) -> ${
        new CopilotApiPaths().envConfigFile
      }`,
    );
  }
  state.dropLegacyEnabled();
  report(`Dropped the legacy autoupdate flag -> ${state.path}`);
}
