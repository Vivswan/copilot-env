// File-backed proxy config helper for config.json and persistent API keys.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { consola } from "consola";

import { isFile } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { sleepSync } from "../utils/time.ts";
import { CopilotApiPaths } from "./paths.ts";

const logger = consola.withTag("copilot_api.config");

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
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (e) {
      logger.warn(`could not read ${this.path}: ${String(e)}`);
      return {};
    }
    if (!raw.trim()) {
      return {};
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      logger.warn(`${this.path} is not valid JSON (${String(e)}); treating as empty`);
      return {};
    }
    return isRecord(data) ? data : {};
  }

  /** Atomically write ``data`` to disk with mode 0600. */
  save(data: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `${basename(this.path)}.tmp.${process.pid}`);
    try {
      const sorted = sortKeys(data);
      writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
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

  /** Load, apply ``mutate`` in place, save, and return the result. */
  update(mutate: (d: Record<string, unknown>) => void): Record<string, unknown> {
    const data = this.load();
    mutate(data);
    this.save(data);
    return data;
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
    const auth = this.readAuth();
    if (auth) {
      const keys = auth.apiKeys;
      if (Array.isArray(keys) && keys.length > 0 && keys[0]) {
        return String(keys[0]);
      }
    }

    const token = this.generateToken();

    const mutate = (d: Record<string, unknown>): void => {
      const authBlock = ensureDict(d, "auth");
      const existing = authBlock.apiKeys;
      const keys: unknown[] = Array.isArray(existing) ? [...existing] : [];
      if (!keys.includes(token)) {
        keys.push(token);
      }
      authBlock.apiKeys = keys;
    };

    this.update(mutate);
    return token;
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

    const token = this.generateToken();

    this.update((d) => {
      const authBlock = ensureDict(d, "auth");
      authBlock.adminApiKey = token;
    });
    return token;
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
