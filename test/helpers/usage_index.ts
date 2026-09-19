// The usage index as a test reads it from outside: the database file under a data home, the
// paths its `files` table holds, and every byte SQLite left on disk for it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { USAGE_INDEX_DB_NAME } from "../../src/usage/index.ts";
import { USAGE_INDEX_DIR_NAME } from "../../src/copilot_api/paths.ts";

/** The index database under the data home `home`. */
export function indexDbFile(home: string): string {
  return join(home, USAGE_INDEX_DIR_NAME, USAGE_INDEX_DB_NAME);
}

/** The paths stored in a CLOSED index's `files` table, sorted, read through a second connection. */
export function storedIndexPaths(dbFile: string): string[] {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT "path" FROM "files" ORDER BY "path"`).all() as {
      path: string;
    }[];
    return rows.map((row) => row.path);
  } finally {
    db.close();
  }
}

/** Every byte SQLite left on disk for the index at `dbFile`, as latin1 text: the database and
 *  whichever sidecars exist. */
export function indexBytesOnDisk(dbFile: string): string {
  let text = "";
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = `${dbFile}${suffix}`;
    if (existsSync(file)) text += readFileSync(file).toString("latin1");
  }
  return text;
}
