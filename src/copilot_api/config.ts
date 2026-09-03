// File-backed proxy config helper for config.json and persistent API keys.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { consola } from "consola";

import { BOUNDED_LOCK_POLICY, withFileLockSync } from "../utils/file_lock.ts";
import { entryAbsent, isEnoentOrNotdir } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { sleepSync } from "../utils/time.ts";
import { CopilotApiPaths, PROXY_CONFIG_FILENAME } from "./paths.ts";
import type { Profile } from "./profile.ts";

const logger = consola.withTag("copilot_api.config");

/** One read of a store file; see CopilotApiConfig.read() for the kinds' meaning. */
type StoreRead =
  | { kind: "doc"; data: Record<string, unknown> }
  | { kind: "unparseable"; error: string }
  | { kind: "unreadable"; error: string };

/** The shared unparseable degrade for the two read-only loaders: warn once,
 *  answer `{}` -- junk content reads as empty, never as a crash. */
function dataOrDegrade(
  path: string,
  read: Exclude<StoreRead, { kind: "unreadable" }>,
): Record<string, unknown> {
  if (read.kind === "unparseable") {
    logger.warn(`${path} is not valid JSON (${read.error}); treating as empty`);
    return {};
  }
  return read.data;
}

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
// the shared bounded-wait policy (BOUNDED_LOCK_POLICY) proceeds WITHOUT the lock after its
// wait rather than deadlock a command, and reclaims only a crashed/leaked holder.

/**
 * Atomic JSON store for `~/.local/share/copilot-env/` files: the proxy's
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

  /**
   * What one read of the store found. `doc` is a read that COMPLETED: the file
   * parsed, or it is genuinely absent/empty. `unparseable` is content that WAS
   * seen but is not JSON -- a proven fact about the file. `unreadable` is a read
   * that FAILED: absence was not established and the contents could not be seen
   * either. The kinds must not collapse, because `update()` writes back what this
   * returns -- persisting a failed (or half-seen) read as `{}` is what would WIPE
   * the file (the daemon's api key, admin key, providers).
   */
  private read(): StoreRead {
    // The proxy DAEMON writes config.json non-atomically (a plain truncate-then-write in the
    // floated package), so a concurrent read can momentarily see it empty, half-written, or --
    // on Windows -- fail outright with a sharing violation. Retry a few times before concluding
    // anything: otherwise update()'s save would persist the emptied doc and WIPE the daemon's
    // keys (api key, admin key, providers). Only config.json can be seen TORN, so only it gets
    // the empty/parse-arm retries: our own stores (state, prefs) write via atomic rename. The
    // read-ERROR arm retries for EVERY store -- a transient failure (a Windows sharing
    // violation) is not a fact about the file, and "unreadable" is refused at update() and
    // loadStrict(), so <=16ms of backoff is worth not refusing on a blip.
    const retryTorn = basename(this.path) === PROXY_CONFIG_FILENAME;
    for (let attempt = 1;; attempt++) {
      const last = attempt >= LOAD_RETRY_ATTEMPTS;
      let raw: string;
      try {
        raw = readFileSync(this.path, "utf8");
      } catch (e) {
        // Absence is a PROVEN answer (no file -> an empty document) -- proven by
        // entryAbsent, readTextResult's rule: a DANGLING SYMLINK reads ENOENT
        // through readFileSync but the entry itself exists, and writing "absent"
        // back would replace the user's link with a plain file. Every other
        // failure is a look that did not complete, reported honestly after the
        // retries rather than as empty.
        if (isEnoentOrNotdir(e) && entryAbsent(this.path)) return { kind: "doc", data: {} };
        if (!last) {
          sleepSync(LOAD_RETRY_MS);
          continue;
        }
        return { kind: "unreadable", error: String(e) };
      }
      if (raw.trim()) {
        try {
          const data: unknown = JSON.parse(raw);
          // A parsed non-object root (a scalar, an array) is the same class as a
          // parse failure: content we could not interpret as the store, which a
          // write-back would discard -- so it degrades on read and refuses on
          // update, never collapses to a writable empty doc.
          if (isRecord(data)) return { kind: "doc", data };
          return { kind: "unparseable", error: "the JSON root is not an object" };
        } catch (e) {
          if (retryTorn && !last) {
            sleepSync(LOAD_RETRY_MS);
            continue;
          }
          return { kind: "unparseable", error: String(e) };
        }
      }
      // Empty read: retry (a transient truncate window) before accepting it as genuinely empty.
      if (retryTorn && !last) {
        sleepSync(LOAD_RETRY_MS);
        continue;
      }
      return { kind: "doc", data: {} };
    }
  }

  /** The store as a document, with a failed or unparsed read flattened to `{}`
   *  (warned). The flatten is KEPT for readers whose degraded answer is safe --
   *  pure display, and the surfaces that must never throw (the in-daemon watchdog
   *  gates) -- but it is a real flatten: a reader that renders "owns nothing" /
   *  "no preference set" from this cannot tell an unreadable store from an empty
   *  one. Readers whose emptiness is a DECISION read `loadStrict()` instead; a
   *  caller that writes the result back goes through `update()`, which refuses. */
  load(): Record<string, unknown> {
    const read = this.read();
    if (read.kind === "unreadable") {
      logger.warn(`could not read ${this.path}: ${read.error}`);
      return {};
    }
    return dataOrDegrade(this.path, read);
  }

  /** `load()` for DECISION-bearing readers (ownership take-backs, wiring, the
   *  proxy float pin, credential resolution): a read that FAILED throws -- a
   *  destructive or ownership decision must never act on an unproven empty --
   *  while unparseable CONTENT still degrades to `{}` like `load()`: junk in the
   *  file is a proven fact about the file (warned), which the stores' lenient
   *  schemas already read as "owns less" / defaults. */
  loadStrict(): Record<string, unknown> {
    const read = this.read();
    if (read.kind === "unreadable") {
      throw new Error(
        `Could not read ${this.path} (${read.error}); refusing to treat an unreadable store as empty.`,
      );
    }
    return dataOrDegrade(this.path, read);
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
   *  by a best-effort `<file>.lock` so concurrent read-modify-writes don't lost-update.
   *  REFUSES on a store that could not be read OR parsed: this is a read-modify-WRITE, so
   *  treating either as an empty document would persist the emptiness and wipe every key the
   *  file holds. Same direction as codex/toml_io.ts's "refusing to overwrite it" -- an
   *  unreadable or unparsed document is never clobbered, it is reported. */
  update(mutate: (d: Record<string, unknown>) => void): Record<string, unknown> {
    const lockPath = `${this.path}.lock`;
    return withFileLockSync(lockPath, BOUNDED_LOCK_POLICY, () => {
      const read = this.read();
      if (read.kind === "unreadable") {
        throw new Error(
          `Could not read ${this.path}; refusing to overwrite it (writing now would discard everything it holds).`,
        );
      }
      if (read.kind === "unparseable") {
        // The same refusal as the unreadable arm, decided separately: a corrupt-but-
        // readable file is NOT a reset candidate here, because (a) for config.json the
        // daemon's torn-write window read() retries over can outlast the retries, so
        // "unparseable" may still be a half-written LIVE store, and (b) for our own
        // atomic stores it is outside corruption (a hand edit) whose salvageable
        // content a reset would silently discard. The reset stays an explicit user
        // act: fix or delete the file.
        throw new Error(
          `${this.path} is not valid JSON (${read.error}); refusing to overwrite it ` +
            `(a rewrite would discard whatever it still holds - fix or delete the file to reset it).`,
        );
      }
      const data = read.data;
      mutate(data);
      this.save(data);
      return data;
    });
  }

  // ---------- domain helpers (auth) ----------

  /** A fresh 64-char hex secret (the entropy/encoding for persisted keys). */
  private generateToken(): string {
    return randomBytes(32).toString("hex");
  }

  /** The `auth` block narrowed to a record, or null when absent/ill-typed. The
   *  plain load() flatten is ACCEPTED here: this only feeds the ensure* fast
   *  paths, and their slow path re-checks inside update(), which refuses an
   *  unreadable or unparsed store before anything could be clobbered. */
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
