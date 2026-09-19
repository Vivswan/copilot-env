import { join } from "node:path";

import * as fs from "../utils/fs_facade.ts";
import { parseJsonRecord } from "../utils/json.ts";
import type { ProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { versionLessThan } from "../utils/semver.ts";

export const PROXY_PACKAGE_NAME = "@jeffreycao/copilot-api";

type ProxyVersionFloorStatus =
  | { ok: true; version: string }
  | { ok: false; reason: "missing"; version: null }
  | { ok: false; reason: "belowFloor"; version: string; floor: string };

export type ProxyVersionStatus =
  | ProxyVersionFloorStatus
  | { ok: false; reason: "aboveCeiling"; version: string; ceiling: string };

export function installedProxyVersion(root: string = PROJECT_ROOT): string | null {
  const packagePath = join(root, "node_modules", ...PROXY_PACKAGE_NAME.split("/"), "package.json");
  try {
    const parsed = parseJsonRecord(fs.readText(packagePath));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function proxyVersionFloorStatus(
  version: string | null,
  config: Pick<ProjectConfig, "proxyMinVersion">,
): ProxyVersionFloorStatus {
  if (version === null) {
    return { ok: false, reason: "missing", version: null };
  }
  if (versionLessThan(version, config.proxyMinVersion)) {
    return {
      ok: false,
      reason: "belowFloor",
      version,
      floor: config.proxyMinVersion,
    };
  }
  return { ok: true, version };
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
      ok: false,
      reason: "aboveCeiling",
      version: floorStatus.version,
      ceiling: config.proxyMaxVersion,
    };
  }
  return floorStatus;
}
