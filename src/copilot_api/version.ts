// Gateway package version helpers shared by startup checks and the postinstall float.
import { join } from "node:path";

import type { ProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { versionLessThan } from "../utils/semver.ts";
import { readPackageVersion } from "../utils/version.ts";

export const GATEWAY_PACKAGE_NAME = "@jeffreycao/copilot-api";

export type GatewayVersionFloorStatus =
  | { ok: true; version: string }
  | { ok: false; reason: "missing"; version: null }
  | { ok: false; reason: "belowFloor"; version: string; floor: string };

export type GatewayVersionStatus =
  | GatewayVersionFloorStatus
  | { ok: false; reason: "aboveCeiling"; version: string; ceiling: string };

/** Installed gateway version (from its package.json), or null if unresolved. */
export function installedGatewayVersion(root: string = PROJECT_ROOT): string | null {
  const packagePath = join(
    root,
    "node_modules",
    ...GATEWAY_PACKAGE_NAME.split("/"),
    "package.json",
  );
  return readPackageVersion(packagePath);
}

export function assertGatewayConfigBounds(config: ProjectConfig): void {
  if (
    config.gatewayMaxVersion !== null &&
    versionLessThan(config.gatewayMaxVersion, config.gatewayMinVersion)
  ) {
    throw new Error(
      `GATEWAY_MAX_VERSION (${config.gatewayMaxVersion}) is below GATEWAY_MIN_VERSION (${config.gatewayMinVersion})`,
    );
  }
}

export function gatewayVersionFloorStatus(
  version: string | null,
  config: Pick<ProjectConfig, "gatewayMinVersion">,
): GatewayVersionFloorStatus {
  if (version === null) {
    return { "ok": false, "reason": "missing", "version": null };
  }
  if (versionLessThan(version, config.gatewayMinVersion)) {
    return {
      "ok": false,
      "reason": "belowFloor",
      "version": version,
      "floor": config.gatewayMinVersion,
    };
  }
  return { "ok": true, "version": version };
}

export function gatewayVersionBoundsStatus(
  version: string | null,
  config: ProjectConfig,
): GatewayVersionStatus {
  const floorStatus = gatewayVersionFloorStatus(version, config);
  if (!floorStatus.ok) {
    return floorStatus;
  }
  if (
    config.gatewayMaxVersion !== null &&
    versionLessThan(config.gatewayMaxVersion, floorStatus.version)
  ) {
    return {
      "ok": false,
      "reason": "aboveCeiling",
      "version": floorStatus.version,
      "ceiling": config.gatewayMaxVersion,
    };
  }
  return floorStatus;
}
