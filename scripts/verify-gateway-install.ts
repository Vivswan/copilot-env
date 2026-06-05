// CI/dev guard: assert that `bun install`'s postinstall gateway float actually
// installed @jeffreycao/copilot-api within the [GATEWAY_MIN_VERSION,
// GATEWAY_MAX_VERSION] window from copilot-env.config.
//
// The float (src/gateway_float.ts, run as the postinstall hook) is best-effort —
// it never fails `bun install` — so a silently broken float would otherwise only
// surface at daemon launch (start.ts's assertGatewayFloor). This script makes the
// postinstall's real effect a first-class, OS-matrix CI check: it resolves the
// installed gateway through the SAME createRequire path the daemon uses
// (copilotApiVersion) and compares it to the floor (and ceiling, when set).
//
// Exits non-zero with a ::error:: annotation when the gateway is missing, below
// the floor, or above the ceiling; prints the resolved version otherwise.

import { copilotApiVersion } from "../src/copilot_api/process.ts";
import { readProjectConfig } from "../src/project_config.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { versionLessThan } from "../src/utils/semver.ts";

// Anchor the config read at PROJECT_ROOT (not process.cwd()) so it matches the
// root copilotApiVersion() resolves the gateway from — and start.ts's floor gate
// — keeping the check cwd-independent.
const { gatewayMinVersion: floor, gatewayMaxVersion: ceiling } = readProjectConfig(PROJECT_ROOT);
const version = copilotApiVersion();

if (version === null) {
  console.error(
    "::error::gateway float did not install @jeffreycao/copilot-api (module resolution failed) — the `bun install` postinstall (src/gateway_float.ts) is broken.",
  );
  process.exit(1);
}

if (versionLessThan(version, floor)) {
  console.error(
    `::error::installed @jeffreycao/copilot-api ${version} is below the ${floor} floor — the postinstall gateway float failed to reach the floor.`,
  );
  process.exit(1);
}

if (ceiling !== null && versionLessThan(ceiling, version)) {
  console.error(
    `::error::installed @jeffreycao/copilot-api ${version} is above the ${ceiling} ceiling — the postinstall gateway float overshot GATEWAY_MAX_VERSION.`,
  );
  process.exit(1);
}

const window = ceiling === null ? `>= ${floor} floor` : `within [${floor}, ${ceiling}]`;
console.log(`gateway float OK: @jeffreycao/copilot-api ${version} (${window})`);
