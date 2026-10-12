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

/** An installed copy of the proxy under `<root>/node_modules`, as its own manifest describes it. */
export interface InstalledProxyPackage {
  version: string;
  /** The absolute path of the package's `bin` entry: what the daemon runs. */
  entry: string;
}

/** The package's `bin`, as npm admits it: one string (the bin is named after the package), or a
 *  map, read at the unscoped package name. A copy declaring neither reads as not installed: the
 *  daemon would have nothing to run. */
function binEntry(manifest: Record<string, unknown>): string | null {
  const bin = manifest.bin;
  if (typeof bin === "string") return bin;
  if (typeof bin !== "object" || bin === null) return null;
  const unscoped = PROXY_PACKAGE_NAME.split("/").at(-1) as string;
  const named = (bin as Record<string, unknown>)[unscoped];
  return typeof named === "string" ? named : null;
}

/** `root` is a tree holding the proxy under node_modules: the checkout (bun install put it
 *  there), or the proxy home the float installs into (src/proxy_float.ts). Null is "no usable
 *  copy": absent, unreadable, or a manifest with no version or bin. */
export function installedProxyPackage(root: string = PROJECT_ROOT): InstalledProxyPackage | null {
  const packageDir = join(root, "node_modules", ...PROXY_PACKAGE_NAME.split("/"));
  let manifest: Record<string, unknown> | null;
  try {
    manifest = parseJsonRecord(fs.readText(join(packageDir, "package.json")));
  } catch {
    return null;
  }
  if (manifest === null || typeof manifest.version !== "string") return null;
  const bin = binEntry(manifest);
  if (bin === null) return null;
  return { version: manifest.version, entry: join(packageDir, bin) };
}

export function installedProxyVersion(root: string = PROJECT_ROOT): string | null {
  return installedProxyPackage(root)?.version ?? null;
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
