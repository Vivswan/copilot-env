// File-backed proxy config helper for config.json and persistent API keys.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { consola } from "consola";

import { acquireFileLockBounded, releaseFileLock } from "../utils/file_lock.ts";
import { isFile } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { sleepSync } from "../utils/time.ts";
import { CopilotApiPaths, PROXY_CONFIG_FILENAME } from "./paths.ts";
import type { Profile } from "./profile.ts";

const logger = consola.withTag("copilot_api.config");

// Bounded backoff for reading config.json across the daemon's non-atomic write (see load()):
// ~5 attempts x 4ms = up to ~16ms of retry, far longer than a truncate-then-write window.
const LOAD_RETRY_ATTEMPTS = 5;
const LOAD_RETRY_MS = 4;

// --- cross-process advisory lock for update()'s read-modify-write ---
//
// update() takes a best-effort `<file>.lock` (shared implementation in utils/file_lock.ts) so
// concurrent read-modify-writes to the SAME store file across processes (the CLI, the daemon
// shims, several shells at once) don't lost-update one another -- e.g. a `start --record-event`
// heartbeat clobbering a fresh pid/port, an `auth --del` undone by a concurrent catalog-throttle
// write, or two ensureApiKey callers each minting a key. It is BEST-EFFORT, not a hard mutex:
// the shared bounded-wait policy (acquireFileLockBounded) proceeds WITHOUT the lock after its
// wait rather than deadlock a command, and reclaims only a crashed/leaked holder.

/**
 * Atomic JSON store for `~/.local/share/copilot-api/` files: the proxy's
 * `config.json` and the small state files (`CopilotEnvState`, `CopilotEnvRunState`,
 * `AutoupdateState` all wrap one of these). Sorted keys, 0600, atomic rename with a
 * Windows EPERM/EBUSY retry.
 *
 * The class is intentionally schema-agnostic: it manipulates a JSON document and
 * exposes a small set of domain helpers for the keys this tooling cares about.
 * Unknown keys present in the file are preserved across writes so hand edits and
 * new upstream fields are not clobbered.
 */
export class CopilotApiConfig {
  readonly path: string;

  constructor(path?: string) {
    if (path === undefined) {
      path = new CopilotApiPaths().configFile;
    }
    this.path = path;
  }

  /** The proxy config for `profile`'s daemon home (null = the effective home). */
  static forProfile(profile: Profile): CopilotApiConfig {
    return new CopilotApiConfig(new CopilotApiPaths(profile).configFile);
  }

  // ---------- low-level I/O ----------

  load(): Record<string, unknown> {
    if (!isFile(this.path)) {
      return {};
    }
    // The proxy DAEMON writes config.json non-atomically (a plain truncate-then-write in the
    // floated package), so a concurrent read can momentarily see it empty or half-written.
    // Retry a few times before concluding it is really empty/corrupt -- otherwise update()'s
    // save would persist the emptied doc and WIPE the daemon's keys (api key, admin key,
    // providers). Only config.json needs this: our own stores (state, prefs) write via atomic
    // rename, so a reader never sees a partial state from us. The window is sub-millisecond, so
    // a short bounded backoff closes it at negligible cost.
    const retryTransient = basename(this.path) === PROXY_CONFIG_FILENAME;
    const maxAttempts = retryTransient ? LOAD_RETRY_ATTEMPTS : 1;
    for (let attempt = 1;; attempt++) {
      let raw: string;
      try {
        raw = readFileSync(this.path, "utf8");
      } catch (e) {
        logger.warn(`could not read ${this.path}: ${String(e)}`);
        return {};
      }
      if (raw.trim()) {
        try {
          const data: unknown = JSON.parse(raw);
          return isRecord(data) ? data : {};
        } catch (e) {
          if (attempt < maxAttempts) {
            sleepSync(LOAD_RETRY_MS);
            continue;
          }
          logger.warn(`${this.path} is not valid JSON (${String(e)}); treating as empty`);
          return {};
        }
      }
      // Empty read: retry (a transient truncate window) before accepting it as genuinely empty.
      if (attempt < maxAttempts) {
        sleepSync(LOAD_RETRY_MS);
        continue;
      }
      return {};
    }
  }

  /** Atomically write ``data`` to disk with mode 0600. */
  save(data: Record<string, unknown>): void {
    const sorted = sortKeys(data);
    // Created 0600 from the start, so a secret it may hold (the GitHub token, the
    // proxy admin key) is never briefly readable at the default umask -- the
    // rename publishes an already-restricted inode.
    atomicWriteFile(this.path, `${JSON.stringify(sorted, null, 2)}\n`, 0o600);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // ignore
    }
  }

  /** Load, apply ``mutate`` in place, save, and return the result. Serialized across processes
   *  by a best-effort `<file>.lock` so concurrent read-modify-writes don't lost-update. */
  update(mutate: (d: Record<string, unknown>) => void): Record<string, unknown> {
    const lockPath = `${this.path}.lock`;
    const held = acquireFileLockBounded(lockPath);
    try {
      const data = this.load();
      mutate(data);
      this.save(data);
      return data;
    } finally {
      if (held) releaseFileLock(lockPath);
    }
  }

  // ---------- domain helpers (auth) ----------

  /** A fresh 64-char hex secret (the entropy/encoding for persisted keys). */
  private generateToken(): string {
    return randomBytes(32).toString("hex");
  }

  /** The `auth` block narrowed to a record, or null when absent/ill-typed. */
  private readAuth(): Record<string, unknown> | null {
    const auth = this.load().auth;
    return isRecord(auth) ? auth : null;
  }

  /** Return ``auth.apiKeys[0]``, generating and persisting one if absent. */
  ensureApiKey(): string {
    // Fast path: a key already exists -> return it without writing.
    const auth = this.readAuth();
    if (auth) {
      const keys = auth.apiKeys;
      if (Array.isArray(keys) && keys.length > 0 && keys[0]) {
        return String(keys[0]);
      }
    }
    // Missing: generate INSIDE update() and re-check there, so two concurrent creators (each of
    // whom saw "missing" above) converge on ONE key -- the second's update() loads the first's
    // key (the lock serializes them) and returns it instead of appending a second.
    let result = "";
    this.update((d) => {
      const authBlock = ensureDict(d, "auth");
      const keys: unknown[] = Array.isArray(authBlock.apiKeys) ? [...authBlock.apiKeys] : [];
      const existing = keys.find((k) => typeof k === "string" && k);
      if (existing) {
        result = String(existing);
      } else {
        result = this.generateToken();
        keys.push(result);
      }
      authBlock.apiKeys = keys;
    });
    return result;
  }

  /**
   * Return ``auth.adminApiKey``, generating and persisting one if absent.
   * The admin key gates the ``/admin/*`` routes (e.g. live model-mapping
   * updates); without it those routes reject every request.
   */
  ensureAdminApiKey(): string {
    const auth = this.readAuth();
    if (auth && typeof auth.adminApiKey === "string" && auth.adminApiKey) {
      return auth.adminApiKey;
    }
    // Generate INSIDE update() and re-check there: unlike an api key (an array we could append
    // to), adminApiKey is a single value, so two concurrent creators must not each overwrite it
    // and hand back a token the other clobbered. The lock + re-check makes them converge.
    let result = "";
    this.update((d) => {
      const authBlock = ensureDict(d, "auth");
      if (typeof authBlock.adminApiKey === "string" && authBlock.adminApiKey) {
        result = authBlock.adminApiKey;
      } else {
        result = this.generateToken();
        authBlock.adminApiKey = result;
      }
    });
    return result;
  }
}

/** Return ``parent[key]`` as a dict, creating/replacing if needed. Also the record-walk
 *  primitive for nested config.json writes (setProxyConfigValue in launch.ts). */
export function ensureDict(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (isRecord(value)) {
    return value;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

/**
 * THE atomic file-write recipe: write to a fresh same-directory temp file
 * (`<name>.tmp.<pid>.<now>`, unique per writer), then renameWithRetry over the
 * target -- a reader never sees a torn file. The temp file is removed on failure.
 * `mode` (when given) restricts the temp file from creation, so the rename
 * publishes an already-restricted inode. Shared by the JSON store's save and
 * saveClaudeJson (src/claude/mcp_registration.ts).
 */
export function atomicWriteFile(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}.${Date.now()}`);
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    renameWithRetry(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Rename with a short retry. A POSIX rename over an open destination always
 * succeeds, but Windows can transiently throw EPERM/EBUSY/EACCES when another
 * process (the daemon, antivirus, the search indexer) holds the file open.
 * Retry briefly, then surface the original error.
 */
export function renameWithRetry(
  from: string,
  to: string,
  attempts = 5,
  rename: (f: string, t: string) => void = renameSync,
): void {
  for (let i = 0; i <= attempts; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (i >= attempts || !transient) {
        throw err;
      }
      sleepSync(50);
    }
  }
}

/**
 * Recursively return a copy of ``value`` with object keys sorted
 * alphabetically at every level. Mirrors Python's ``json.dump(...,
 * sort_keys=True)`` so the on-disk file is byte-stable with the
 * previous Python writer. Arrays preserve order; their elements are
 * sorted recursively.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}
