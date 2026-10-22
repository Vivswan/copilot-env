// Away from 5.0.2, one fix-up.
//
// `proxy.small-model` landed in each daemon's config.json under `smallModel`, a key the floating
// proxy stopped reading when it keyed its small model per provider (`smallModels.copilot`, the
// registry's path now). The proxy keeps every key it does not know, so the old one would ride in
// the file forever; it goes here, once, named as it goes.

import { join } from "node:path";
import { consola } from "consola";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { allDaemonHomes, PROXY_CONFIG_FILENAME } from "../copilot_api/paths.ts";
import { caught } from "../utils/message.ts";
import type { Migration } from "./index.ts";

/** The retired top-level key, the proxy's own spelling. */
const RETIRED_SMALL_MODEL_KEY = "smallModel";

/** Exported for the migration test; `homes` isolates. A config.json that cannot be read or
 *  parsed is named and left: the next `agent start` refuses it with the same reason. */
export function removeRetiredSmallModelKey(homes: readonly string[]): void {
  for (const home of homes) {
    const config = new CopilotApiConfig(join(home, PROXY_CONFIG_FILENAME));
    if (!(RETIRED_SMALL_MODEL_KEY in config.load())) continue;

    try {
      config.update((d) => {
        delete d[RETIRED_SMALL_MODEL_KEY];
      });
    } catch (e) {
      consola.warn(
        caught(e, (message) => `  could not update ${config.path} (${message}); left as it is`),
      );
      continue;
    }
    consola.info(
      `  removed ${RETIRED_SMALL_MODEL_KEY} from ${config.path} (the proxy reads smallModels.copilot now)`,
    );
  }
}

export const v502SmallModelKey: Migration = {
  version: "5.0.2",
  description: "drop the retired smallModel key from every daemon's config.json",
  run: () => removeRetiredSmallModelKey(allDaemonHomes()),
};
