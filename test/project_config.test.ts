import { describe, expect, test } from "bun:test";

import { parseProjectConfig } from "../src/project_config.ts";

describe("project config", () => {
  test("parses shared floor and ceiling values", () => {
    expect(
      parseProjectConfig(
        `
# comments and blanks are ignored
CooldownRepoMinSha=e59d7ed288f6efa9e645e01a1900368458a8fb69
CooldownRepoMaxSha=abc123
GATEWAY_MIN_VERSION=1.10.30
GATEWAY_MAX_VERSION=1.11.0
`,
        "fixture",
      ),
    ).toEqual({
      "cooldownRepoMinSha": "e59d7ed288f6efa9e645e01a1900368458a8fb69",
      "cooldownRepoMaxSha": "abc123",
      "gatewayMinVersion": "1.10.30",
      "gatewayMaxVersion": "1.11.0",
    });
  });

  test("treats empty and null ceilings as absent", () => {
    expect(
      parseProjectConfig(
        `
CooldownRepoMinSha=e59d7ed288f6efa9e645e01a1900368458a8fb69
CooldownRepoMaxSha=
GATEWAY_MIN_VERSION=1.10.30
GATEWAY_MAX_VERSION=null
`,
        "fixture",
      ),
    ).toEqual({
      "cooldownRepoMinSha": "e59d7ed288f6efa9e645e01a1900368458a8fb69",
      "cooldownRepoMaxSha": null,
      "gatewayMinVersion": "1.10.30",
      "gatewayMaxVersion": null,
    });
  });

  test("rejects missing required values", () => {
    expect(() =>
      parseProjectConfig(
        `
CooldownRepoMaxSha=
GATEWAY_MAX_VERSION=
`,
        "fixture",
      ),
    ).toThrow("CooldownRepoMinSha is required");
  });
});
