// Proxy package version helpers shared by startup checks and the postinstall float.
import { join } from "node:path";

import type { ProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { versionLessThan } from "../utils/semver.ts";
import { readPackageVersion } from "../utils/version.ts";

export const PROXY_PACKAGE_NAME = "@jeffreycao/copilot-api";

export type ProxyVersionFloorStatus =
  | { ok: true; version: string }
  | { ok: false; reason: "missing"; version: null }
  | { ok: false; reason: "belowFloor"; version: string; floor: string };

export type ProxyVersionStatus =
  | ProxyVersionFloorStatus
  | { ok: false; reason: "aboveCeiling"; version: string; ceiling: string };

/** Installed proxy version (from its package.json), or null if unresolved. */
export function installedProxyVersion(root: string = PROJECT_ROOT): string | null {
  const packagePath = join(root, "node_modules", ...PROXY_PACKAGE_NAME.split("/"), "package.json");
  return readPackageVersion(packagePath);
}

export function assertProxyConfigBounds(config: ProjectConfig): void {
  if (
    config.proxyMaxVersion !== null &&
    versionLessThan(config.proxyMaxVersion, config.proxyMinVersion)
  ) {
    throw new Error(
      `PROXY_MAX_VERSION (${config.proxyMaxVersion}) is below PROXY_MIN_VERSION (${config.proxyMinVersion})`,
    );
  }
}

export function proxyVersionFloorStatus(
  version: string | null,
  config: Pick<ProjectConfig, "proxyMinVersion">,
): ProxyVersionFloorStatus {
  if (version === null) {
    return { "ok": false, "reason": "missing", "version": null };
  }
  if (versionLessThan(version, config.proxyMinVersion)) {
    return {
      "ok": false,
      "reason": "belowFloor",
      "version": version,
      "floor": config.proxyMinVersion,
    };
  }
  return { "ok": true, "version": version };
}

export function proxyVersionBoundsStatus(
  version: string | null,
  config: ProjectConfig,
): ProxyVersionStatus {
  const floorStatus = proxyVersionFloorStatus(version, config);
  if (!floorStatus.ok) {
    return floorStatus;
  }
  if (
    config.proxyMaxVersion !== null &&
    versionLessThan(config.proxyMaxVersion, floorStatus.version)
  ) {
    return {
      "ok": false,
      "reason": "aboveCeiling",
      "version": floorStatus.version,
      "ceiling": config.proxyMaxVersion,
    };
  }
  return floorStatus;
}
