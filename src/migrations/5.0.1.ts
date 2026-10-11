// Away from 5.0.1: the file lock (src/utils/file_lock.ts) held an OS advisory lock on a permanent
// `<lock>.oslock` sidecar beside every marker, never unlinked by design. The lock is the marker
// file itself now, so every sidecar is debris: swept out of the root home (the store locks, each
// profile home's daemon.lock, the run dirs' start locks, the usage index) and the install's
// `.autoupdate/`, each named as it goes.

import { join } from "node:path";
import { consola } from "consola";
import { autoupdateDir } from "../autoupdate/state.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import * as fs from "../utils/fs_facade.ts";
import type { Migration } from "./index.ts";

const OS_LOCK_SUFFIX = ".oslock";

/** Every `*.oslock` under `dir`, through links never (a link is the link). */
function osLockSidecarsUnder(dir: string): string[] {
  let entries: ReturnType<typeof fs.readdirEntries>;
  try {
    entries = fs.readdirEntries(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return osLockSidecarsUnder(path);
    return entry.isFile() && entry.name.endsWith(OS_LOCK_SUFFIX) ? [path] : [];
  });
}

/** Exported for the migration test; `roots` isolates. */
export function removeOsLockSidecars(roots: readonly string[]): void {
  for (const path of roots.flatMap(osLockSidecarsUnder)) {
    fs.rm(path, { force: true });
    consola.info(`  removed ${path} (the lock is the marker file itself now)`);
  }
}

export const v501OsLockSidecars: Migration = {
  version: "5.0.1",
  description: "remove the file locks' retired .oslock sidecars",
  run: (installRoot) => removeOsLockSidecars([resolveRootHome(), autoupdateDir(installRoot)]),
};
