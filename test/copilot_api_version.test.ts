import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertGatewayConfigBounds,
  gatewayVersionBoundsStatus,
  gatewayVersionFloorStatus,
  installedGatewayVersion,
} from "../src/copilot_api/version.ts";
import type { ProjectConfig } from "../src/utils/project_config.ts";

let dir = "";

const CONFIG: ProjectConfig = {
  "gatewayMinVersion": "1.10.0",
  "gatewayMaxVersion": "1.10.30",
};

function writeGatewayPackage(versionJson: string): void {
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

describe("installedGatewayVersion", () => {
  test("reads the installed gateway package version", () => {
    writeGatewayPackage(JSON.stringify({ "version": "1.10.30" }));

    expect(installedGatewayVersion(dir)).toBe("1.10.30");
  });

  test("returns null for missing, malformed, or versionless package metadata", () => {
    expect(installedGatewayVersion(dir)).toBeNull();

    writeGatewayPackage("{ nope");
    expect(installedGatewayVersion(dir)).toBeNull();

    writeGatewayPackage(JSON.stringify({ "name": "@jeffreycao/copilot-api" }));
    expect(installedGatewayVersion(dir)).toBeNull();
  });
});

describe("gateway version status", () => {
  test("checks the startup floor separately from the release ceiling", () => {
    expect(gatewayVersionFloorStatus(null, CONFIG)).toEqual({
      "ok": false,
      "reason": "missing",
      "version": null,
    });
    expect(gatewayVersionFloorStatus("1.9.99", CONFIG)).toEqual({
      "floor": "1.10.0",
      "ok": false,
      "reason": "belowFloor",
      "version": "1.9.99",
    });
    expect(gatewayVersionFloorStatus("1.10.31", CONFIG)).toEqual({
      "ok": true,
      "version": "1.10.31",
    });
  });

  test("checks the install assertion floor and ceiling", () => {
    expect(gatewayVersionBoundsStatus("1.9.99", CONFIG)).toEqual({
      "floor": "1.10.0",
      "ok": false,
      "reason": "belowFloor",
      "version": "1.9.99",
    });
    expect(gatewayVersionBoundsStatus("1.10.31", CONFIG)).toEqual({
      "ceiling": "1.10.30",
      "ok": false,
      "reason": "aboveCeiling",
      "version": "1.10.31",
    });
    expect(gatewayVersionBoundsStatus("1.10.30", CONFIG)).toEqual({
      "ok": true,
      "version": "1.10.30",
    });
  });

  test("rejects an inverted configured version window", () => {
    expect(() =>
      assertGatewayConfigBounds({
        "gatewayMinVersion": "1.10.30",
        "gatewayMaxVersion": "1.10.0",
      }),
    ).toThrow("GATEWAY_MAX_VERSION (1.10.0) is below GATEWAY_MIN_VERSION (1.10.30)");
  });
});
