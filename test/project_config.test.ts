import { parseProjectConfig } from "../src/utils/project_config.ts";
import { describe, expect, test } from "./helpers/testing.ts";

describe("project config", () => {
  test("parses the proxy version window: comments and unknown keys ignored, an empty or null ceiling absent, tolerant spellings canonical x.y.z", () => {
    const rows: { name: string; text: string; parsed: Record<string, string | null> }[] = [
      {
        name: "floor and ceiling",
        text:
          "\n# comments and blanks are ignored\nPROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=1.11.0\n",
        parsed: { "proxyMinVersion": "1.10.30", "proxyMaxVersion": "1.11.0" },
      },
      {
        name: "null ceiling",
        text: "\nPROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=null\n",
        parsed: { "proxyMinVersion": "1.10.30", "proxyMaxVersion": null },
      },
      {
        name: "empty ceiling",
        text: "PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=",
        parsed: { "proxyMinVersion": "1.10.30", "proxyMaxVersion": null },
      },
      {
        // e.g. a retired cooldown SHA
        name: "unknown key",
        text: "CooldownRepoMinSha=abc\nPROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=",
        parsed: { "proxyMinVersion": "1.10.30", "proxyMaxVersion": null },
      },
      {
        name: "tolerant spelling",
        text: "PROXY_MIN_VERSION=v1.10\nPROXY_MAX_VERSION=",
        parsed: { "proxyMinVersion": "1.10.0", "proxyMaxVersion": null },
      },
    ];
    for (const row of rows) {
      expect(parseProjectConfig(row.text, "fixture"), row.name).toEqual(row.parsed);
    }
  });

  test("rejects a missing floor, an unparseable bound (naming key and value), and an inverted window", () => {
    // The floor fails OPEN downstream (versionLessThan treats an unparseable side as
    // not-less-than), so garbage bounds must die here at the boundary. Anchored
    // regexes pin the FULL message (source prefix included) as the contract;
    // toThrow(string) would match any substring.
    const rows: { text: string; message: RegExp }[] = [
      { text: "PROXY_MAX_VERSION=", message: /^fixture: PROXY_MIN_VERSION is required$/ },
      {
        text: "PROXY_MIN_VERSION=latest\nPROXY_MAX_VERSION=oops",
        message: /^fixture: PROXY_MIN_VERSION is not a semver version: "latest"$/,
      },
      {
        text: "PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=oops",
        message: /^fixture: PROXY_MAX_VERSION is not a semver version: "oops"$/,
      },
      {
        // Anchored: this message carries no source prefix (built after per-key parsing).
        text: "PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=1.10.0",
        message: /^PROXY_MAX_VERSION \(1\.10\.0\) is below PROXY_MIN_VERSION \(1\.10\.30\)$/,
      },
    ];
    for (const row of rows) {
      expect(() => parseProjectConfig(row.text, "fixture"), row.text).toThrow(row.message);
    }
  });
});
