// A typed wrapper over CopilotApiConfig, the project's atomic JSON store, like CopilotEnvRunState,
// so autoupdate adds no second I/O implementation.
//
//   this file            -> throttle only: when the last check ran and how it went
//   `update.auto` config -> the preference itself, never copied here
//
// Autoupdate state is machine state, not release payload, so it lives clear of the version dirs a
// later update garbage-collects: installStateRoot maps `<top>/current` to `<top>` rather than
// resolving the link into one.
//
//   versioned install  -> `<top>/.autoupdate/`, beside `versions/` (installStateRoot)
//   dev checkout       -> `<root>/.autoupdate/`
import { join } from "node:path";
import * as v from "valibot";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { installStateRoot, PROJECT_ROOT } from "../utils/root.ts";

/** The autoupdate state directory: `<install>/.autoupdate`. */
export function autoupdateDir(root: string = PROJECT_ROOT): string {
  return join(installStateRoot(root), ".autoupdate");
}

/** The autoupdate throttle file's basename: named for what it holds, not "state" (that word is
 *  the account-wide store's, src/copilot_api/state_store.ts). */
export const AUTOUPDATE_FILENAME = "autoupdate.json";

/** Persistent autoupdate throttle file (JSON): `<install>/.autoupdate/autoupdate.json`. */
export function autoupdateStateFile(root: string = PROJECT_ROOT): string {
  return join(autoupdateDir(root), AUTOUPDATE_FILENAME);
}

/** Lock file guarding concurrent preflight updates. */
export function autoupdateLockFile(root: string = PROJECT_ROOT): string {
  return join(autoupdateDir(root), "update.lock");
}

/** Default release cooldown for autoupdate: adopt releases at least this old. */
export const DEFAULT_AUTOUPDATE_COOLDOWN_DAYS = 7;

/** Always the live `update.cooldown` config, never snapshotted into state, so `agent config set
 *  update.cooldown N` takes effect on the next run. */
export function effectiveUpdateCooldownDays(): number {
  return new CopilotEnvConfig().updateCooldownDays() ?? DEFAULT_AUTOUPDATE_COOLDOWN_DAYS;
}

export interface AutoupdateData {
  /** Epoch ms of the last completed check (0 if never). */
  lastCheckMs: number;
  /** Human summary of the last check, e.g. "updated v1.2.3" / "up to date". */
  lastResult: string;
}

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

  /** Both fields land together; keys this schema does not know survive the write. */
  set(data: AutoupdateData): void {
    this.store.update((d) => Object.assign(d, data));
  }
}
