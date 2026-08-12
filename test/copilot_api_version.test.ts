import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";

let dir = "";

const CONFIG: ProjectConfig = {
  "proxyMinVersion": "1.10.0",
  "proxyMaxVersion": "1.10.30",
};

function writeProxyPackage(versionJson: string): void {
  const pkgDir = join(dir, "node_modules", "@jeffreycao", "copilot-api");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), versionJson);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "copilot-version-"));
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("installedProxyVersion", () => {
  test("reads the installed proxy package version", () => {
    writeProxyPackage(JSON.stringify({ "version": "1.10.30" }));

    expect(installedProxyVersion(dir)).toBe("1.10.30");
  });

  test("returns null for missing, malformed, or versionless package metadata", () => {
    expect(installedProxyVersion(dir)).toBeNull();

    writeProxyPackage("{ nope");
    expect(installedProxyVersion(dir)).toBeNull();

    writeProxyPackage(JSON.stringify({ "name": "@jeffreycao/copilot-api" }));
    expect(installedProxyVersion(dir)).toBeNull();
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
