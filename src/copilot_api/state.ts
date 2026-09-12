import { existsSync } from "node:fs";
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";
import type { Profile } from "./profile.ts";

/** Per-host runtime state (`.run/<host>/.state.json`). */
export interface CopilotEnvRunStateData {
  port?: number;
  pid?: number;
  /** The per-host Codex farm, recorded by the `codex-host` derivation (src/codex/host.ts). */
  codexHome?: string;
  /**
   * Epoch ms of the last `start --record-event` heartbeat; the in-daemon idle watchdog counts it as
   * activity. The observer's own mark lives in `.activity.json`, NOT here: this file has concurrent
   * CLI writers and the store is not atomic across load-mutate-save, so the daemon writes it only via clearIfPid.
   */
  lastEnsureAt?: number;
}

type StatePatch = { [K in keyof CopilotEnvRunStateData]?: CopilotEnvRunStateData[K] | null };

// Every field falls back to `undefined` rather than throwing. The port range is any valid TCP port,
// WIDER than port.ts's >=1024 allocation floor on purpose: this round-trips whatever the daemon bound.
const RUN_STATE_SCHEMA = v.object({
  port: v.fallback(
    v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
    undefined,
  ),
  pid: v.fallback(v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))), undefined),
  codexHome: v.fallback(v.optional(v.pipe(v.string(), v.minLength(1))), undefined),
  lastEnsureAt: v.fallback(v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))), undefined),
});

export class CopilotEnvRunState {
  private readonly store: CopilotApiConfig;
  private readonly profile: Profile;

  /** Takes the PROFILE, not a file path: the store path is derived from it, so path and profile can never disagree. */
  constructor(profile: Profile = null) {
    this.store = new CopilotApiConfig(new CopilotApiPaths(profile).stateFile);
    this.profile = profile;
  }

  static forProfile(profile: Profile): CopilotEnvRunState {
    return new CopilotEnvRunState(profile);
  }

  /** The plain load() flatten is accepted here: the in-daemon idle watchdog reads this every tick, where
   *  a throw would escape the timer callback and KILL the serving daemon. The destructive acts fed from
   *  this store never trust the record alone; they re-verify the pid's identity before acting. */
  read(): CopilotEnvRunStateData {
    return v.parse(RUN_STATE_SCHEMA, this.store.load());
  }

  /** A `null` value deletes its key. */
  set(patch: StatePatch): void {
    this.store.update((d) => {
      for (const key of Object.keys(patch) as (keyof StatePatch)[]) {
        const value = patch[key];
        if (value === null || value === undefined) {
          delete d[key];
        } else {
          d[key] = value;
        }
      }
    });
  }

  /**
   * The store's atomic write mkdirs the parent, so an unconditional write would FABRICATE a phantom
   * profile home for a typo'd `--profile <name>`. A real proxy profile always has its state file: the
   * port reservation wrote it.
   */
  setIfExists(patch: StatePatch): void {
    if (this.profile !== null && !existsSync(this.store.path)) return;
    this.set(patch);
  }

  /**
   * The pid check runs INSIDE the read-modify-write, so a daemon replaced by a newer one cannot clobber
   * its successor's freshly written pid/port while update()'s best-effort lock holds; past its bounded
   * wait both writers proceed unlocked. A NAMED profile's daemon passes `keepPort`: its port is the
   * profile's stable reservation the baked agent wiring points at.
   */
  clearIfPid(pid: number, keepPort = false): void {
    this.store.update((d) => {
      if (d.pid !== pid) return;
      delete d.pid;
      if (!keepPort) delete d.port;
      delete d.lastEnsureAt;
    });
  }
}
