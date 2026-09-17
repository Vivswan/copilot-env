import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  installedProxyVersion,
  PROXY_PACKAGE_NAME,
  proxyVersionBoundsStatus,
  proxyVersionFloorStatus,
} from "../src/copilot_api/version.ts";
import { isRecord } from "../src/utils/json.ts";
import type { ProjectConfig } from "../src/utils/project_config.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { afterEach, beforeEach, describe, expect, tempDir, test } from "./helpers/testing.ts";

let dir = "";

const CONFIG: ProjectConfig = {
  "proxyMinVersion": "1.10.0",
  "proxyMaxVersion": "1.10.30",
};

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
  test("checks the startup floor separately from the release ceiling", () => {
    expect(proxyVersionFloorStatus(null, CONFIG)).toEqual({
      "ok": false,
      "reason": "missing",
      "version": null,
    });
    expect(proxyVersionFloorStatus("1.9.99", CONFIG)).toEqual({
      "floor": "1.10.0",
      "ok": false,
      "reason": "belowFloor",
      "version": "1.9.99",
    });
    expect(proxyVersionFloorStatus("1.10.31", CONFIG)).toEqual({
      "ok": true,
      "version": "1.10.31",
    });
  });

  test("checks the install assertion floor and ceiling", () => {
    expect(proxyVersionBoundsStatus("1.9.99", CONFIG)).toEqual({
      "floor": "1.10.0",
      "ok": false,
      "reason": "belowFloor",
      "version": "1.9.99",
    });
    expect(proxyVersionBoundsStatus("1.10.31", CONFIG)).toEqual({
      "ceiling": "1.10.30",
      "ok": false,
      "reason": "aboveCeiling",
      "version": "1.10.31",
    });
    expect(proxyVersionBoundsStatus("1.10.30", CONFIG)).toEqual({
      "ok": true,
      "version": "1.10.30",
    });
  });
});

// deno.json's import entry is an external contract (deno resolves the proxy by
// that literal key), so it cannot derive from PROXY_PACKAGE_NAME -- pin the two
// together instead, so renaming either side fails here rather than at install time.
test("deno.json tracks the proxy dependency under PROXY_PACKAGE_NAME", () => {
  const config: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, "deno.json"), "utf8"));
  if (!isRecord(config) || !isRecord(config.imports)) {
    throw new Error("deno.json has no imports table");
  }
  expect(Object.keys(config.imports)).toContain(PROXY_PACKAGE_NAME);
  expect(config.imports[PROXY_PACKAGE_NAME]).toMatch(new RegExp(`^npm:${PROXY_PACKAGE_NAME}@`));
});
