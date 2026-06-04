import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { consola } from "consola";

import { CopilotApiPaths } from "./paths.ts";

const logger = consola.withTag("copilot_api.utils.config");

/**
 * Read/write helper for ``~/.local/share/copilot-api/config.json``.
 *
 * The class is intentionally schema-agnostic: it manipulates a JSON
 * document and exposes a small set of domain helpers for the keys this
 * tooling cares about. Unknown keys present in the file
 * are preserved across writes so hand edits and new upstream fields
 * are not clobbered.
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
    return isPlainObject(data) ? data : {};
  }

  /** Atomically write ``data`` to disk with mode 0600. */
  save(data: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `${basename(this.path)}.tmp.${process.pid}`);
    try {
      const sorted = sortKeys(data);
      writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
      renameSync(tmp, this.path);
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

  /** Return ``auth.apiKeys[0]``, generating and persisting one if absent. */
  ensureApiKey(): string {
    const data = this.load();
    const authRaw = data.auth;
    const auth = isPlainObject(authRaw) ? authRaw : null;
    if (auth) {
      const keys = auth.apiKeys;
      if (Array.isArray(keys) && keys.length > 0 && keys[0]) {
        return String(keys[0]);
      }
    }

    const token = randomBytes(32).toString("hex");

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
    const data = this.load();
    const authRaw = data.auth;
    const auth = isPlainObject(authRaw) ? authRaw : null;
    if (auth && typeof auth.adminApiKey === "string" && auth.adminApiKey) {
      return auth.adminApiKey;
    }

    const token = randomBytes(32).toString("hex");

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
  if (isPlainObject(value)) {
    return value;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
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
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}
