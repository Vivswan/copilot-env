// A REAL floated install under `.proxy-cache/` for the floated-spawn test to launch from: the
// daemon config, proxy lockfile, warmed DENO_DIR and resolved-version record are genuine float
// output. Run it where there IS a network (the container build); the test then runs offline.
//
//   deno ci   -> caches the workspace graph only; never resolves the proxy's bin entrypoint
//   the float -> caches that entrypoint, and only then its own dependencies (citty and friends)
import { join } from "node:path";
import { installedProxyVersion, PROXY_PACKAGE_NAME } from "../src/copilot_api/version.ts";
import { floatProxy, readResolvedVersionRecord } from "../src/proxy_float.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";

/** The fixture root home. Inside the checkout so it survives from a container build
 *  into the test run; gitignored, because it is build output. */
export const PROXY_CACHE_FIXTURE = join(PROJECT_ROOT, ".proxy-cache");

if (import.meta.main) {
  const version = installedProxyVersion(PROJECT_ROOT);
  if (version === null) {
    console.error(`${PROXY_PACKAGE_NAME} is not installed; run \`deno install\` first`);
    Deno.exit(1);
  }

  // Pin to the locked version and disable the cooldown: this fixture must be
  // reproducible, so it must never depend on what the registry happens to offer today.
  Deno.env.set("COPILOT_API_VERSION", version);
  await floatProxy({ "rootHome": PROXY_CACHE_FIXTURE, "cooldownSeconds": 0 });

  const record = readResolvedVersionRecord(PROXY_CACHE_FIXTURE);
  if (record?.version !== version) {
    console.error(`the float did not record ${version} (got ${record?.version ?? "nothing"})`);
    Deno.exit(1);
  }
  console.log(`warmed ${PROXY_PACKAGE_NAME}@${version} into ${PROXY_CACHE_FIXTURE}`);
}
