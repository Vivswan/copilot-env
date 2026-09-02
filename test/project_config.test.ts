import { parseProjectConfig } from "../src/utils/project_config.ts";
import { describe, expect, test } from "./helpers/testing.ts";

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

  test("rejects an unparseable floor or ceiling, naming the key and value", () => {
    // The floor fails OPEN downstream (versionLessThan treats an unparseable side as
    // not-less-than), so garbage bounds must die here at the boundary.
    expect(() => parseProjectConfig("PROXY_MIN_VERSION=latest\nPROXY_MAX_VERSION=oops", "fixture"))
      .toThrow('PROXY_MIN_VERSION is not a semver version: "latest"');
    expect(() => parseProjectConfig("PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=oops", "fixture"))
      .toThrow('PROXY_MAX_VERSION is not a semver version: "oops"');
  });

  test("normalizes tolerant spellings to canonical x.y.z", () => {
    expect(parseProjectConfig("PROXY_MIN_VERSION=v1.10\nPROXY_MAX_VERSION=", "fixture")).toEqual({
      "proxyMinVersion": "1.10.0",
      "proxyMaxVersion": null,
    });
  });

  test("rejects an inverted configured version window", () => {
    expect(() =>
      parseProjectConfig("PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=1.10.0", "fixture")
    ).toThrow("PROXY_MAX_VERSION (1.10.0) is below PROXY_MIN_VERSION (1.10.30)");
  });
});
