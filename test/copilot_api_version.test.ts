import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertProxyConfigBounds,
  installedProxyVersion,
  proxyVersionBoundsStatus,
  proxyVersionFloorStatus,
} from "../src/copilot_api/version.ts";
import type { ProjectConfig } from "../src/utils/project_config.ts";

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

  test("rejects an inverted configured version window", () => {
    expect(() =>
      assertProxyConfigBounds({
        "proxyMinVersion": "1.10.30",
        "proxyMaxVersion": "1.10.0",
      }),
    ).toThrow("PROXY_MAX_VERSION (1.10.0) is below PROXY_MIN_VERSION (1.10.30)");
  });
});
