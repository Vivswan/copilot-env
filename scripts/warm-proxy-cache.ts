// Produce a REAL floated install under `.proxy-cache/`, for the floated-spawn test to
// execute against.
//
// It runs the actual float, pinned to the locked proxy version, so the fixture is not a
// hand-built approximation: the daemon config, the proxy lockfile, the warmed DENO_DIR
// and the resolved-version record are all genuine float output. The test then launches
// the proxy out of it exactly as a floated install would.
//
// `deno ci` cannot stand in for this. It caches the WORKSPACE graph -- our source and
// its imports -- and never resolves the proxy's bin entrypoint, whose own dependencies
// (citty and friends) only appear once that entrypoint is cached.
//
// Run it where there IS a network (a container build, a CI step); the test that depends
// on it then runs offline.
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
