// release-please's `release-as` is a one-shot override for cutting a specific
// version. release-please does not remove it from the config after the release
// PR merges, and a pin left behind makes every later release PR propose the
// SAME version again (with force-tag-creation, merging one would move the
// published tag). It has already been cleaned up by hand twice (after v1.0.0
// and after v4.0.0), so pin the rule: absent, or strictly newer than the
// version the manifest says has shipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { greaterThan, parse } from "semver";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, test } from "./helpers/testing.ts";

test("release-please-config.json carries no stale release-as pin", () => {
  const config = JSON.parse(readFileSync(join(PROJECT_ROOT, "release-please-config.json"), "utf8"));
  const manifest = JSON.parse(
    readFileSync(join(PROJECT_ROOT, ".release-please-manifest.json"), "utf8"),
  );
  const shipped = parse(manifest["."]);
  for (const [path, pkg] of Object.entries(config.packages as Record<string, unknown>)) {
    const releaseAs = (pkg as { "release-as"?: unknown })["release-as"];
    if (releaseAs === undefined) continue;
    expect(typeof releaseAs, `${path}: release-as must be a version string`).toBe("string");
    expect(
      greaterThan(parse(releaseAs as string), shipped),
      `${path}: release-as ${releaseAs} is not newer than the shipped ${manifest["."]}; ` +
        "remove the pin (AGENTS.md: leave release-as absent)",
    ).toBe(true);
  }
});
