// File-backed proxy config helper for config.json and persistent API keys.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { consola } from "consola";

import { isFile } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { sleepSync } from "../utils/time.ts";
import { CopilotApiPaths } from "./paths.ts";

const logger = consola.withTag("copilot_api.config");

// Bounded backoff for reading config.json across the daemon's non-atomic write (see load()):
// ~5 attempts x 4ms = up to ~16ms of retry, far longer than a truncate-then-write window.
const LOAD_RETRY_ATTEMPTS = 5;
const LOAD_RETRY_MS = 4;

// --- cross-process advisory lock for update()'s read-modify-write ---
//
// A `<file>.lock` sidecar serializes concurrent update() calls to the SAME store file across
// processes (the CLI, the daemon shims, several shells at once) so their load-mutate-saves
// don't lost-update one another -- e.g. a `start --record-event` heartbeat clobbering a fresh
// pid/port, an `auth --del` being undone by a concurrent catalog-throttle write, or two
// ensureApiKey callers each minting a key.
//
// It is a BEST-EFFORT advisory lock, not a hard mutex: perfect cross-process mutual exclusion
// needs OS advisory locks (flock/fcntl) that the portable Node/bun fs API doesn't expose, so we
// build on atomic filesystem primitives (linkSync to publish, renameSync to steal) and accept a
// vanishingly small residual race that also requires a CRASHED holder plus precisely-timed
// racers. In the COMMON path (no crash) it is exact. Two backstops keep a crashed or leaked lock
// from wedging the store forever: after LOCK_WAIT_MS we proceed WITHOUT the lock rather than
// deadlock a command, and a lock whose holder pid is dead (or which is older than LOCK_STALE_MS)
// is reclaimed. Because a real update() is a millisecond-scale read-modify-write, a LIVE holder
// is never seen stale and the wait effectively never expires -- the backstops only ever reclaim
// a dead holder.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 4_000;
const LOCK_RETRY_MS = 15;

/** Alive check without importing the heavier process.ts (avoids a module cycle). EPERM means
 *  the pid exists but this token can't signal it -- still alive. */
function pidAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Create the lock file with its content already in place. Writes a unique temp file, then
 *  hard-links it to `lockPath` -- linkSync is atomic and fails EEXIST if the lock is held, and
 *  a successful link exposes the FULLY-WRITTEN file in one step (so a concurrent reader never
 *  sees an empty lock and mistakes a live holder for stale). Returns false if held or on any
 *  error (treated as "couldn't lock" -- never throws out of a store write). */
function tryCreateLock(lockPath: string): boolean {
  const tmp = `${lockPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, `${process.pid}\n${Date.now()}\n`);
  } catch {
    return false;
  }
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch {
    return false; // EEXIST (held) or an unexpected error -> proceed as unlocked
  } finally {
    try {
      rmSync(tmp, { force: true }); // the hard link keeps the inode; the temp name is disposable
    } catch {
      // ignore
    }
  }
}

/** Read the lock file's raw marker (`${pid}\n${ts}\n`), or null if absent/unreadable. */
function readLockRaw(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
}

/** Whether a raw lock marker is stale: its holder pid is dead or it is older than
 *  LOCK_STALE_MS. A malformed marker reads stale (reclaim). */
function markerStale(raw: string): boolean {
  const [pidStr, tsStr] = raw.split("\n");
  const pid = Number.parseInt(pidStr ?? "", 10);
  const ts = Number.parseInt(tsStr ?? "", 10);
  if (Number.isNaN(pid) || pid <= 0 || Number.isNaN(ts)) return true;
  return Date.now() - ts > LOCK_STALE_MS || !pidAliveLocal(pid);
}

/** Acquire the lock, stealing a stale one, within a bounded wait. Returns whether it is held
 *  (false => the caller proceeds unlocked). */
function acquireStoreLock(lockPath: string): boolean {
  // Ensure the store directory exists so the lock's temp-file write can't ENOENT-fail forever
  // on the first write to a fresh home (save() creates it too, but that runs AFTER this).
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // if we can't even create the dir, tryCreateLock will fail and we proceed unlocked
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (tryCreateLock(lockPath)) return true;
    const observed = readLockRaw(lockPath);
    if (observed !== null && markerStale(observed)) {
      // Steal, but ONLY the exact stale lock we observed. renameSync atomically yanks whatever
      // is at lockPath; we then confirm the yanked marker MATCHES `observed`. If it does, the
      // stale lock was ours to reclaim -> drop it. If it does NOT (a fresh holder replaced the
      // stale lock between our read and the rename -- the race a plain rename-steal would lose),
      // restore it via linkSync, which fails EEXIST rather than clobbering a lock a third
      // process may have created meanwhile, and do NOT steal. Then re-create exclusively;
      // linkSync in tryCreateLock means at most one winner.
      const claimed = `${lockPath}.steal.${process.pid}.${Date.now()}`;
      let yanked: string | null = null;
      try {
        renameSync(lockPath, claimed);
        yanked = readLockRaw(claimed);
      } catch {
        yanked = null; // someone else already moved/removed it
      }
      if (yanked !== null) {
        if (yanked === observed) {
          try {
            rmSync(claimed, { force: true }); // reclaimed the stale lock
          } catch {
            // ignore
          }
        } else {
          // Yanked a DIFFERENT (fresh) lock -> put it back without clobbering, don't steal.
          // linkSync fails (EEXIST, or any other fs error) rather than overwriting a lock a
          // third process may have created meanwhile; on failure we simply don't restore and
          // the yanked holder re-locks on its next update.
          try {
            linkSync(claimed, lockPath);
          } catch {
            // lockPath re-occupied / fs error -> leave it; the yanked holder re-locks next update
          }
          try {
            rmSync(claimed, { force: true });
          } catch {
            // ignore
          }
        }
      }
      if (tryCreateLock(lockPath)) return true;
    }
    if (Date.now() >= deadline) return false;
    sleepSync(LOCK_RETRY_MS);
  }
}

/** Release the lock, but only if it is still OURS (pid match) -- never delete a successor's. */
function releaseStoreLock(lockPath: string): void {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").split("\n")[0] ?? "", 10);
    if (pid === process.pid) rmSync(lockPath, { force: true });
  } catch {
    // gone / unreadable -> nothing to release
  }
}

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
    const retryTransient = basename(this.path) === "config.json";
    const maxAttempts = retryTransient ? LOAD_RETRY_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
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
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `${basename(this.path)}.tmp.${process.pid}`);
    try {
      const sorted = sortKeys(data);
      // Create the temp file 0600 FROM THE START so a secret it may hold (the GitHub token,
      // the proxy admin key) is never briefly world-readable at the default umask -- the
      // rename then publishes an already-restricted inode, with no 0644 window. The explicit
      // chmod re-asserts 0600 in case a looser temp file from a crashed prior run is reused
      // (writeFileSync truncates but does not tighten an existing file's mode).
      writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // non-POSIX (Windows): file mode is a no-op there
      }
      renameWithRetry(tmp, this.path);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
      throw err;
    }
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
    const held = acquireStoreLock(lockPath);
    try {
      const data = this.load();
      mutate(data);
      this.save(data);
      return data;
    } finally {
      if (held) releaseStoreLock(lockPath);
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

/** Return ``parent[key]`` as a dict, creating/replacing if needed. */
function ensureDict(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (isRecord(value)) {
    return value;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
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
