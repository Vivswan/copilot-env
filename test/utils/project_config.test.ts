import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_CONFIG_FILE,
  parseProjectConfig,
  readSidecarDenoVersion,
} from "../../src/utils/project_config.ts";
import { describe, expect, tempDir, test } from "../helpers/testing.ts";

/** Every window row carries the sidecar pin too: the parser requires it, and it is not what the
 *  row is about. */
const PIN = "SIDECAR_DENO_VERSION=2.9.7\n";

describe("project config", () => {
  test("parses the proxy version window: comments and unknown keys ignored, an empty or null ceiling absent, tolerant spellings canonical x.y.z", () => {
    const rows: { name: string; text: string; parsed: Record<string, string | null> }[] = [
      {
        name: "floor and ceiling",
        text: `${PIN}\n# comments and blanks are ignored\nPROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=1.11.0\n`,
        parsed: {
          proxyMinVersion: "1.10.30",
          proxyMaxVersion: "1.11.0",
          sidecarDenoVersion: "2.9.7",
        },
      },
      {
        name: "null ceiling",
        text: `${PIN}\nPROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=null\n`,
        parsed: { proxyMinVersion: "1.10.30", proxyMaxVersion: null, sidecarDenoVersion: "2.9.7" },
      },
      {
        name: "empty ceiling",
        text: `${PIN}PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=`,
        parsed: { proxyMinVersion: "1.10.30", proxyMaxVersion: null, sidecarDenoVersion: "2.9.7" },
      },
      {
        // e.g. a retired cooldown SHA
        name: "unknown key",
        text: `${PIN}CooldownRepoMinSha=abc\nPROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=`,
        parsed: { proxyMinVersion: "1.10.30", proxyMaxVersion: null, sidecarDenoVersion: "2.9.7" },
      },
      {
        name: "tolerant spelling",
        text: `${PIN}PROXY_MIN_VERSION=v1.10\nPROXY_MAX_VERSION=`,
        parsed: { proxyMinVersion: "1.10.0", proxyMaxVersion: null, sidecarDenoVersion: "2.9.7" },
      },
    ];
    for (const row of rows) {
      expect(parseProjectConfig(row.text, "fixture"), row.name).toEqual(row.parsed);
    }
  });

  test("the sidecar pin is read on its own, so a malformed proxy bound still names the deno to compare against", () => {
    // Health reports the bad bound as the proxy check's failure; the sidecar row must not vanish
    // with it. The whole parse refuses the same file.
    const root = tempDir("copilot-project-config-");
    const path = join(root, PROJECT_CONFIG_FILE);
    writeFileSync(
      path,
      "PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=oops\nSIDECAR_DENO_VERSION=2.9.7\n",
    );
    expect(readSidecarDenoVersion(root)).toBe("2.9.7");
    expect(() => parseProjectConfig(readFileSync(path, "utf8"), path)).toThrow("PROXY_MAX_VERSION");
    writeFileSync(path, "PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=\n");
    expect(() => readSidecarDenoVersion(root)).toThrow(/SIDECAR_DENO_VERSION is required$/);
  });

  test("rejects a missing floor, an unparseable bound (naming key and value), and an inverted window", () => {
    // The floor fails OPEN downstream (versionLessThan treats an unparseable side as
    // not-less-than), so garbage bounds must die here at the boundary. Anchored
    // regexes pin the FULL message (source prefix included) as the contract;
    // toThrow(string) would match any substring.
    const rows: { text: string; message: RegExp }[] = [
      { text: `${PIN}PROXY_MAX_VERSION=`, message: /^fixture: PROXY_MIN_VERSION is required$/ },
      {
        text: "PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=",
        message: /^fixture: SIDECAR_DENO_VERSION is required$/,
      },
      {
        text: `${PIN}PROXY_MIN_VERSION=latest\nPROXY_MAX_VERSION=oops`,
        message: /^fixture: PROXY_MIN_VERSION is not a semver version: "latest"$/,
      },
      {
        text: `${PIN}PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=oops`,
        message: /^fixture: PROXY_MAX_VERSION is not a semver version: "oops"$/,
      },
      {
        // Anchored: this message carries no source prefix (built after per-key parsing).
        text: `${PIN}PROXY_MIN_VERSION=1.10.30\nPROXY_MAX_VERSION=1.10.0`,
        message: /^PROXY_MAX_VERSION \(1\.10\.0\) is below PROXY_MIN_VERSION \(1\.10\.30\)$/,
      },
    ];
    for (const row of rows) {
      expect(() => parseProjectConfig(row.text, "fixture"), row.text).toThrow(row.message);
    }
  });
});
