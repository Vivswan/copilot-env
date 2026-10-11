import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  installedProxyVersion,
  proxyVersionBoundsStatus,
  proxyVersionFloorStatus,
  type ProxyVersionStatus,
} from "../../src/copilot_api/version.ts";
import type { ProjectConfig } from "../../src/utils/project_config.ts";
import { afterEach, beforeEach, describe, expect, tempDir, test } from "../helpers/testing.ts";

let dir = "";

const CONFIG: ProjectConfig = {
  "proxyMinVersion": "1.10.0",
  "proxyMaxVersion": "1.10.30", "sidecarDenoVersion": "2.9.7" };

function writeProxyPackage(root: string, versionJson: string): void {
  const pkgDir = join(root, "node_modules", "@jeffreycao", "copilot-api");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), versionJson);
}

beforeEach(() => {
  dir = tempDir("copilot-version-");
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("installedProxyVersion", () => {
  // Only a parseable package.json carrying a version answers; a missing package, unparseable
  // metadata, or metadata without a version all read as "not installed", never a throw.
  test("reads the installed version, or null for missing, malformed, or versionless metadata", () => {
    const rows: { pkg: string | null; version: string | null }[] = [
      { pkg: JSON.stringify({ "version": "1.10.30" }), version: "1.10.30" },
      { pkg: null, version: null },
      { pkg: "{ nope", version: null },
      { pkg: JSON.stringify({ "name": "@jeffreycao/copilot-api" }), version: null },
    ];
    for (const [i, { pkg, version }] of rows.entries()) {
      const root = join(dir, String(i));
      mkdirSync(root);
      if (pkg !== null) writeProxyPackage(root, pkg);
      expect({ pkg, version: installedProxyVersion(root) }).toEqual({ pkg, version });
    }
  });
});

describe("proxy version status", () => {
  // The startup check holds the floor only, so a newer proxy still serves; the install assertion
  // holds the release ceiling as well.
  test("the startup floor lets a newer proxy through; the install bounds refuse above the ceiling", () => {
    const checks = { floor: proxyVersionFloorStatus, bounds: proxyVersionBoundsStatus };
    const rows: {
      check: keyof typeof checks;
      version: string | null;
      status: ProxyVersionStatus;
    }[] = [
      { check: "floor", version: null, status: { ok: false, reason: "missing", version: null } },
      {
        check: "floor",
        version: "1.9.99",
        status: { ok: false, reason: "belowFloor", version: "1.9.99", floor: "1.10.0" },
      },
      { check: "floor", version: "1.10.31", status: { ok: true, version: "1.10.31" } },
      {
        check: "bounds",
        version: "1.9.99",
        status: { ok: false, reason: "belowFloor", version: "1.9.99", floor: "1.10.0" },
      },
      {
        check: "bounds",
        version: "1.10.31",
        status: { ok: false, reason: "aboveCeiling", version: "1.10.31", ceiling: "1.10.30" },
      },
      { check: "bounds", version: "1.10.30", status: { ok: true, version: "1.10.30" } },
    ];
    for (const row of rows) {
      expect({ ...row, status: checks[row.check](row.version, CONFIG) }).toEqual(row);
    }
  });
});
