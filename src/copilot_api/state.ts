// Per-host state persistence for the gateway pid, port, and active CODEX_HOME.
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";

/** Per-host runtime state we persist (`.run/<host>/.state.json`). */
export interface CopilotState {
  /** Port the daemon was bound to by `start` (cleared by `stop`). */
  port?: number;
  /** Tracked daemon pid set by `start` (cleared by `stop`). */
  pid?: number;
  /** Active CODEX_HOME set by `setup-codex-host` (cleared by `setup-codex-host --delete`). */
  codexHome?: string;
}

type StatePatch = { [K in keyof CopilotState]?: CopilotState[K] | null };

/**
 * Read/write helper for the per-host state file. Backed by CopilotApiConfig —
 * the project's atomic JSON store (sorted keys, 0600, atomic rename, Windows
 * EPERM/EBUSY retry) — so there's no second I/O implementation and no new dep.
 */
export class CopilotApiState {
  private readonly store: CopilotApiConfig;

  constructor(path?: string) {
    this.store = new CopilotApiConfig(path ?? new CopilotApiPaths().stateFile);
  }

  /** Current state; absent or ill-typed/out-of-range fields come back `undefined`. */
  read(): CopilotState {
    const d = this.store.load();
    const port = d.port;
    const pid = d.pid;
    return {
      port:
        typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
          ? port
          : undefined,
      pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined,
      codexHome: typeof d.codexHome === "string" && d.codexHome ? d.codexHome : undefined,
    };
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
}
