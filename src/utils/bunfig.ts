// bunfig.toml is embedded in the binary beside copilot-env.config: its `[install]
// minimumReleaseAge` is the one source of the proxy float's default release cooldown, so the proxy
// a float selects is never younger than what `bun install` itself would take.
import { join } from "node:path";
import * as fs from "./fs_facade.ts";
import { ASSET_ROOT } from "./root.ts";
import { isTomlTable, parseToml } from "./toml.ts";

export const BUNFIG_FILE = "bunfig.toml";

/** `root` is for test fixtures. */
export function readInstallMinimumReleaseAge(root: string = ASSET_ROOT): number {
  const path = join(root, BUNFIG_FILE);
  const install = parseToml(fs.readText(path)).install;
  const age = isTomlTable(install) ? install.minimumReleaseAge : undefined;
  if (typeof age !== "number" || !Number.isInteger(age) || age < 0) {
    throw new Error(
      `${path}: [install] minimumReleaseAge must be a whole number of seconds, got ${JSON.stringify(
        age,
      )}`,
    );
  }
  return age;
}
