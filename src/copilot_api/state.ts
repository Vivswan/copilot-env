// Per-host state persistence for the proxy pid, port, and active CODEX_HOME.
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";

/** Per-host runtime state we persist (`.run/<host>/.state.json`). */
export interface CopilotEnvRunStateData {
  /** Port the daemon was bound to by `start` (cleared by `stop`). */
  port?: number;
  /** Tracked daemon pid set by `start` (cleared by `stop`). */
  pid?: number;
  /** Active CODEX_HOME set by `codex --host` (cleared by `codex --host --delete-host`). */
  codexHome?: string;
  /**
   * Epoch ms of the most recent `start --ensure` heartbeat (an agent's proxy resolver
   * ran). The in-daemon idle watchdog treats this -- alongside the proxy log mtime -- as
   * activity that resets the idle timer. Cleared by `stop` and on idle auto-stop.
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

  constructor(path?: string) {
    this.store = new CopilotApiConfig(path ?? new CopilotApiPaths().stateFile);
  }

  /** Current state; absent or ill-typed/out-of-range fields come back `undefined`. */
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
   * Atomically clear the daemon tracking (`pid`/`port`/`lastEnsureAt`) ONLY if the recorded
   * pid is still `pid`. The check runs INSIDE the read-modify-write, so it tests the value at
   * write time, not a stale snapshot -- a daemon that has been replaced by a newer one cannot
   * clobber its successor's freshly written pid/port. Used by the in-daemon idle watchdog when
   * it auto-stops the proxy.
   */
  clearIfPid(pid: number): void {
    this.store.update((d) => {
      if (d.pid !== pid) return;
      delete d.pid;
      delete d.port;
      delete d.lastEnsureAt;
    });
  }
}
