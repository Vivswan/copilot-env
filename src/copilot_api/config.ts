import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { consola } from "consola";

import { BOUNDED_LOCK_POLICY, withFileLockSync } from "../utils/file_lock.ts";
import { entryAbsent, isEnoentOrNotdir } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { atomicWriteFile, chmodReported } from "../utils/report_write.ts";
import { sleepSync } from "../utils/time.ts";
import { CopilotApiPaths, PROXY_CONFIG_FILENAME } from "./paths.ts";
import type { Profile } from "./profile.ts";

const logger = consola.withTag("copilot_api.config");

/** One read of a store file; see CopilotApiConfig.read() for the kinds' meaning. */
type StoreRead =
  | { kind: "doc"; data: Record<string, unknown> }
  | { kind: "unparseable"; error: string }
  | { kind: "unreadable"; error: string };

/** Junk content reads as empty (warned), never as a crash; both read-only loaders share the rule. */
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

// Covers the daemon's truncate-then-write window on config.json (see read()): five attempts with a 4 ms
// sleep before each retry, so at most four sleeps (16 ms), far longer than the window.
const LOAD_RETRY_ATTEMPTS = 5;
const LOAD_RETRY_MS = 4;

// update()'s read-modify-write takes a best-effort `<file>.lock` (utils/file_lock.ts): the CLI, the daemon
// shims, and several shells write the SAME store, and BOUNDED_LOCK_POLICY proceeds WITHOUT the lock after
// its wait rather than deadlock a command.
//   `start --record-event` heartbeat vs a fresh pid/port  -> without it, the heartbeat clobbers them
//   two ensureApiKey callers                              -> without it, two keys minted

/**
 * Atomic JSON store under the copilot-env home: the proxy's `config.json` and the small state files.
 * Schema-agnostic on purpose: unknown keys survive every write, so hand edits and new upstream fields
 * in the daemon's config.json are never clobbered.
 */
export class CopilotApiConfig {
  readonly path: string;
  /** The ROOT stores pass CopilotApiPaths' `locks/` path so permanent sidecars do not clutter the home. */
  readonly lockPath: string;

  constructor(path?: string, lockPath?: string) {
    if (path === undefined) {
      path = new CopilotApiPaths().configFile;
    }
    this.path = path;
    this.lockPath = lockPath ?? `${path}.lock`;
  }

  /** The proxy config for `profile`'s daemon home (null = the effective home). */
  static forProfile(profile: Profile): CopilotApiConfig {
    return new CopilotApiConfig(new CopilotApiPaths(profile).configFile);
  }

  // ---------- low-level I/O ----------

  /**
   * The kinds must not collapse: update() writes back what this returns, and persisting a failed
   * or half-seen read as `{}` would WIPE the file (the daemon's api key, admin key, providers).
   *   doc          -> the read COMPLETED: parsed, or the file is proven absent/empty
   *   unparseable  -> content WAS seen and is not JSON, a proven fact about the file
   *   unreadable   -> the read FAILED: neither absence nor contents were established
   */
  private read(): StoreRead {
    // The daemon owns config.json and its write path floats with the version (the 2.3.14 build renames
    // atomically, the 2.0.1 floor truncates in place), so a read can still land mid-write; accepting that
    // would let update() WIPE the daemon's keys.
    //   empty file or a JSON syntax error, config.json only  -> retried; our own stores rename atomically, so junk in one is a fact
    //   valid JSON whose root is not an object               -> NOT retried; the read completed, so there is nothing torn to wait out
    //   read error, every store                              -> retried; a transient failure (a Windows sharing violation) is no fact about the file
    const retryTorn = basename(this.path) === PROXY_CONFIG_FILENAME;
    for (let attempt = 1;; attempt++) {
      const last = attempt >= LOAD_RETRY_ATTEMPTS;
      let raw: string;
      try {
        raw = readFileSync(this.path, "utf8");
      } catch (e) {
        // Absence is proven by entryAbsent, never by ENOENT alone: a DANGLING SYMLINK reads ENOENT but
        // the entry exists, and writing "absent" back would replace the user's link with a plain file.
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
          // A scalar or array root is content the store cannot interpret, so it takes the parse-failure
          // path: a write-back would discard it.
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
      // An empty read may be the daemon's truncate window.
      if (retryTorn && !last) {
        sleepSync(LOAD_RETRY_MS);
        continue;
      }
      return { kind: "doc", data: {} };
    }
  }

  /** The flatten cannot tell an unreadable store from an empty one, so only readers whose degraded
   *  answer is safe use it: display, preference reads that fall back to their built-in defaults, the
   *  in-daemon gates that must never throw, and fast paths whose slow path re-checks. */
  load(): Record<string, unknown> {
    const read = this.read();
    if (read.kind === "unreadable") {
      logger.warn(`could not read ${this.path}: ${read.error}`);
      return {};
    }
    return dataOrDegrade(this.path, read);
  }

  /** For DECISION-bearing readers (ownership take-backs, wiring, the proxy float pin, credential
   *  resolution): a read that FAILED throws, since a destructive decision must never act on an
   *  unproven empty. Unparseable CONTENT still degrades to `{}`: junk in the file is a proven fact. */
  loadStrict(): Record<string, unknown> {
    const read = this.read();
    if (read.kind === "unreadable") {
      throw new Error(
        `Could not read ${this.path} (${read.error}); refusing to treat an unreadable store as empty.`,
      );
    }
    return dataOrDegrade(this.path, read);
  }

  save(data: Record<string, unknown>): void {
    const sorted = sortKeys(data);
    // Created 0600 from the start, so a secret it may hold (the GitHub token, the proxy admin key)
    // is never briefly readable at the default umask.
    atomicWriteFile(this.path, `${JSON.stringify(sorted, null, 2)}\n`, 0o600);
    try {
      chmodReported(this.path, 0o600);
    } catch {
      // ignore
    }
  }

  /** REFUSES a store that could not be read OR parsed: treating either as empty would wipe every key
   *  the file holds (the same direction as codex/toml_io.ts's "refusing to overwrite it"). Public so
   *  a caller about to destroy its SOURCE can clear these refusals for the destination first. */
  loadForUpdate(): Record<string, unknown> {
    const read = this.read();
    if (read.kind === "unreadable") {
      throw new Error(
        `Could not read ${this.path}; refusing to overwrite it (writing now would discard everything it holds).`,
      );
    }
    if (read.kind === "unparseable") {
      // A corrupt-but-readable file is NOT a reset candidate: config.json may still be mid-write past
      // read()'s retries, and a hand-edited store holds salvageable content. The reset stays an
      // explicit user act: fix or delete the file.
      throw new Error(
        `${this.path} is not valid JSON (${read.error}); refusing to overwrite it ` +
          `(a rewrite would discard whatever it still holds - fix or delete the file to reset it).`,
      );
    }
    return read.data;
  }

  update(mutate: (d: Record<string, unknown>) => void): Record<string, unknown> {
    return withFileLockSync(this.lockPath, BOUNDED_LOCK_POLICY, () => {
      const data = this.loadForUpdate();
      mutate(data);
      this.save(data);
      return data;
    });
  }

  // ---------- domain helpers (auth) ----------

  private generateToken(): string {
    return randomBytes(32).toString("hex");
  }

  /** The plain load() flatten is safe here: it feeds only the ensure* fast paths, whose slow path
   *  re-checks inside update(). */
  private readAuth(): Record<string, unknown> | null {
    const auth = this.load().auth;
    return isRecord(auth) ? auth : null;
  }

  ensureApiKey(): string {
    const auth = this.readAuth();
    if (auth) {
      const keys = auth.apiKeys;
      if (Array.isArray(keys) && keys.length > 0 && keys[0]) {
        return String(keys[0]);
      }
    }
    // Generated INSIDE update() with a re-check, so two concurrent creators that both saw "missing"
    // converge on ONE key - unless update()'s best-effort lock times out and both write unlocked.
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

  /** The daemon rejects every `/admin/*` request without this key. */
  ensureAdminApiKey(): string {
    const auth = this.readAuth();
    if (auth && typeof auth.adminApiKey === "string" && auth.adminApiKey) {
      return auth.adminApiKey;
    }
    // Generated INSIDE update() with a re-check: adminApiKey is a single value, so two concurrent
    // creators must not each overwrite it and hand back a token the other clobbered.
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

/** Also the record-walk primitive for nested config.json writes (setProxyConfigValue in launch.ts). */
export function ensureDict(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (isRecord(value)) {
    return value;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

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
