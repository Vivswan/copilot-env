import * as v from "valibot";
import * as fs from "../utils/fs_facade.ts";
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";
import type { Profile } from "./profile.ts";

/** Per-host runtime state (`.run/<host>/.state.json`). The daemon's own activity mark lives in
 *  `.activity.json`, NOT here: this file has concurrent CLI writers and the store is not atomic
 *  across load-mutate-save, so the daemon writes it only via clearIfPid. */
interface CopilotEnvRunStateData {
  /** The daemon's bound port; a named profile's is its stable reservation, kept by clearIfPid. */
  port?: number;

  /** The daemon's; a destructive act re-verifies the pid's identity before trusting it (read()). */
  pid?: number;

  /** The per-host Codex farm, recorded by the `codex.host` derivation (src/codex/host.ts). */
  codexHome?: string;

  /** Epoch ms of the last `start --record-event` heartbeat, which the in-daemon idle watchdog counts as activity. */
  lastEnsureAt?: number;
}

type StatePatch = { [K in keyof CopilotEnvRunStateData]?: CopilotEnvRunStateData[K] | null };

// Every field degrades to undefined; the port admits any TCP port, WIDER than port.ts's >=1024 floor (read()).
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
   *  this store never trust the record alone; they re-verify the pid's identity before acting. For the
   *  same reason every schema field falls back to `undefined` rather than throwing, and the port admits
   *  any valid TCP port, WIDER than port.ts's >=1024 allocation floor: this round-trips whatever the
   *  daemon bound. */
  read(): CopilotEnvRunStateData {
    return v.parse(RUN_STATE_SCHEMA, this.store.load());
  }

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
    // Through the facade: a state file the previewed start planned exists for the heartbeat that
    // follows, as the real start's file does. Only a proven absence skips; an unreadable file (a
    // dangling link) reaches the store, which refuses to overwrite it.
    if (this.profile !== null && fs.readTextResult(this.store.path).kind === "absent") return;
    this.set(patch);
  }

  /**
   * The pid check runs INSIDE the read-modify-write, so a daemon replaced by a newer one cannot clobber
   * its successor's freshly written pid/port under update()'s lock (a holder past its bounded wait is
   * an error, never a second writer). A NAMED profile's daemon passes `keepPort`: its port is the
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
