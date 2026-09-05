// Per-host state persistence for the proxy pid, port, and active CODEX_HOME.
import { existsSync } from "node:fs";
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";
import type { Profile } from "./profile.ts";

/** Per-host runtime state we persist (`.run/<host>/.state.json`). */
export interface CopilotEnvRunStateData {
  /** Port the daemon was bound to by `start` (cleared by `stop`). */
  port?: number;
  /** Tracked daemon pid set by `start` (cleared by `stop`). */
  pid?: number;
  /** Active CODEX_HOME: the per-host farm, recorded (or cleared) by the `codex-host`
   *  derivation every default Codex wiring pass runs (src/codex/host.ts). */
  codexHome?: string;
  /**
   * Epoch ms of the most recent `start --record-event` heartbeat (an agent's proxy
   * resolver ran). The in-daemon idle watchdog treats this -- alongside the observed
   * inference activity -- as activity that resets the idle timer. Cleared by `stop` and on
   * idle auto-stop. (The observer's own mark lives in `.activity.json`, NOT here: this file
   * has concurrent CLI writers and the store is not atomic across load-mutate-save, so the
   * daemon never writes it outside clearIfPid.)
   */
  lastEnsureAt?: number;
}

type StatePatch = { [K in keyof CopilotEnvRunStateData]?: CopilotEnvRunStateData[K] | null };

// Lenient read schema: absent or ill-typed/out-of-range fields fall back to
// `undefined` (treated as "unset" by callers) rather than throwing. The port range
// is any valid TCP port (1..65535) -- WIDER than port.ts's >=1024 allocation floor
// on purpose, so we round-trip whatever port the daemon actually bound, not re-filter it.
const RUN_STATE_SCHEMA = v.object({
  port: v.fallback(
    v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
    undefined,
  ),
  pid: v.fallback(v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))), undefined),
  codexHome: v.fallback(v.optional(v.pipe(v.string(), v.minLength(1))), undefined),
  lastEnsureAt: v.fallback(v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))), undefined),
});

/**
 * Read/write helper for the per-host state file. Backed by CopilotApiConfig --
 * the project's atomic JSON store (sorted keys, 0600, atomic rename, Windows
 * EPERM/EBUSY retry) -- so there's no second I/O implementation.
 */
export class CopilotEnvRunState {
  private readonly store: CopilotApiConfig;
  /** The named profile this state belongs to (null = default) -- gates setIfExists. */
  private readonly profile: Profile;

  /** Takes the PROFILE, not a file path (unlike sibling CopilotApiConfig): the store
   *  path is derived from it, so path and profile can never disagree. */
  constructor(profile: Profile = null) {
    this.store = new CopilotApiConfig(new CopilotApiPaths(profile).stateFile);
    this.profile = profile;
  }

  /** The run state for `profile`'s daemon (null = the default daemon's state). */
  static forProfile(profile: Profile): CopilotEnvRunState {
    return new CopilotEnvRunState(profile);
  }

  /** Current state; absent or ill-typed/out-of-range fields come back `undefined`.
   *  The plain load() flatten (unreadable reads as "nothing recorded") is ACCEPTED
   *  here, decided rather than inherited: the in-daemon idle watchdog reads this
   *  every tick, where a throw would escape the timer callback and KILL the
   *  serving daemon -- and the destructive acts fed from this store (kill,
   *  orphan-sweep protection) never trust the record alone: they re-verify the
   *  pid's daemon identity through the owner-gated classification before acting,
   *  so a flattened empty can degrade a display, never authorize a kill. */
  read(): CopilotEnvRunStateData {
    return v.parse(RUN_STATE_SCHEMA, this.store.load());
  }

  /** Merge `patch` into the file; a `null` (or `undefined`) value deletes its key. */
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
   * Like `set`, but a NAMED profile's write lands only when its state file already
   * exists on disk (the default profile always writes). The store's atomic write
   * mkdirs the file's parent, so an unconditional write would FABRICATE a phantom
   * profile home for a typo'd `--profile <name>` -- one that profile --list /
   * stop --all / the proxy float would then all see. A real proxy profile always
   * has its state file (the port reservation wrote it).
   */
  setIfExists(patch: StatePatch): void {
    if (this.profile !== null && !existsSync(this.store.path)) return;
    this.set(patch);
  }

  /**
   * Atomically clear the daemon tracking (`pid`/`lastEnsureAt`, and `port` unless
   * `keepPort`) ONLY if the recorded pid is still `pid`. The check runs INSIDE the
   * read-modify-write, so it tests the value at write time, not a stale snapshot -- a daemon
   * that has been replaced by a newer one cannot clobber its successor's freshly written
   * pid/port. Used by the in-daemon idle watchdog when it auto-stops the proxy; a NAMED
   * profile's daemon passes `keepPort` because its port is the profile's stable
   * reservation (the baked agent wiring points at it).
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
