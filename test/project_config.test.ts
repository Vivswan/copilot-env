import { describe, expect, test } from "bun:test";

import { parseProjectConfig } from "../src/utils/project_config.ts";

describe("project config", () => {
  test("parses the proxy floor and ceiling", () => {
    expect(
      parseProjectConfig(
        `
# comments and blanks are ignored
PROXY_MIN_VERSION=1.10.30
PROXY_MAX_VERSION=1.11.0
`,
        "fixture",
      ),
    ).toEqual({
      "proxyMinVersion": "1.10.30",
      "proxyMaxVersion": "1.11.0",
    });
  });

  test("treats empty and null ceilings as absent", () => {
    expect(
      parseProjectConfig(
        `
PROXY_MIN_VERSION=1.10.30
PROXY_MAX_VERSION=null
`,
        "fixture",
      ),
    ).toEqual({
      "proxyMinVersion": "1.10.30",
      "proxyMaxVersion": null,
    });
    expect(
      parseProjectConfig("PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=").proxyMaxVersion,
    ).toBeNull();
  });

  test("ignores unknown keys (e.g. retired cooldown SHAs)", () => {
    expect(
      parseProjectConfig("CooldownRepoMinSha=abc\nPROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION="),
    ).toEqual({ "proxyMinVersion": "1.10.30", "proxyMaxVersion": null });
  });

  test("rejects a missing required value", () => {
    expect(() => parseProjectConfig("PROXY_MAX_VERSION=", "fixture")).toThrow(
      "PROXY_MIN_VERSION is required",
    );
  });
});
