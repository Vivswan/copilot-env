import { describe, expect, test } from "bun:test";

import { parseProjectConfig } from "../src/utils/project_config.ts";

describe("project config", () => {
  test("parses the gateway floor and ceiling", () => {
    expect(
      parseProjectConfig(
        `
# comments and blanks are ignored
GATEWAY_MIN_VERSION=1.10.30
GATEWAY_MAX_VERSION=1.11.0
`,
        "fixture",
      ),
    ).toEqual({
      "gatewayMinVersion": "1.10.30",
      "gatewayMaxVersion": "1.11.0",
    });
  });

  test("treats empty and null ceilings as absent", () => {
    expect(
      parseProjectConfig(
        `
GATEWAY_MIN_VERSION=1.10.30
GATEWAY_MAX_VERSION=null
`,
        "fixture",
      ),
    ).toEqual({
      "gatewayMinVersion": "1.10.30",
      "gatewayMaxVersion": null,
    });
    expect(
      parseProjectConfig("GATEWAY_MIN_VERSION=1.10.30\nGATEWAY_MAX_VERSION=").gatewayMaxVersion,
    ).toBeNull();
  });

  test("ignores unknown keys (e.g. retired cooldown SHAs)", () => {
    expect(
      parseProjectConfig(
        "CooldownRepoMinSha=abc\nGATEWAY_MIN_VERSION=1.10.30\nGATEWAY_MAX_VERSION=",
      ),
    ).toEqual({ "gatewayMinVersion": "1.10.30", "gatewayMaxVersion": null });
  });

  test("rejects a missing required value", () => {
    expect(() => parseProjectConfig("GATEWAY_MAX_VERSION=", "fixture")).toThrow(
      "GATEWAY_MIN_VERSION is required",
    );
  });
});
