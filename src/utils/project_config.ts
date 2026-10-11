import { join } from "node:path";
import { parse } from "@std/dotenv/parse";
import * as fs from "./fs_facade.ts";
import { ASSET_ROOT } from "./root.ts";
import { type SemverString, toSemverString, versionLessThan } from "./semver.ts";

export const PROJECT_CONFIG_FILE = "copilot-env.config";

const CONFIG_KEYS = ["PROXY_MIN_VERSION", "PROXY_MAX_VERSION", "SIDECAR_DENO_VERSION"] as const;

type ProjectConfigKey = (typeof CONFIG_KEYS)[number];

export type ProjectConfig = {
  readonly proxyMinVersion: SemverString;
  readonly proxyMaxVersion: SemverString | null;
  /** The TESTED REFERENCE version of the deno sidecar the proxy daemon runs on
   *  (src/copilot_api/sidecar.ts): what CI runs the daemon tests on, and what health compares a
   *  found deno against. Nothing installs it from here. */
  readonly sidecarDenoVersion: SemverString;
};

function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function optionalValue(value: string | undefined): string | null {
  if (value === undefined || value === "" || value === "null") return null;
  return value;
}

function requiredValue(
  raw: Partial<Record<ProjectConfigKey, string>>,
  key: ProjectConfigKey,
  source: string,
): string {
  const value = raw[key];
  if (value === undefined || value === "") {
    throw new Error(`${source}: ${key} is required`);
  }
  return value;
}

// versionLessThan reads an unparseable side as "not less-than", so a garbage bound would silently
// disable every downstream range check: the floor would fail open. Parsing here makes that state
// unrepresentable.
function semverValue(key: ProjectConfigKey, value: string, source: string): SemverString {
  const parsed = toSemverString(value);
  if (parsed === null) {
    throw new Error(`${source}: ${key} is not a semver version: "${value}"`);
  }
  return parsed;
}

function knownKeys(content: string): Partial<Record<ProjectConfigKey, string>> {
  const raw: Partial<Record<ProjectConfigKey, string>> = {};
  for (const [key, value] of Object.entries(parse(content))) {
    if (isProjectConfigKey(key)) raw[key] = value;
  }
  return raw;
}

export function parseProjectConfig(content: string, source = PROJECT_CONFIG_FILE): ProjectConfig {
  const raw = knownKeys(content);

  const proxyMinVersion = semverValue(
    "PROXY_MIN_VERSION",
    requiredValue(raw, "PROXY_MIN_VERSION", source),
    source,
  );
  const rawMaxVersion = optionalValue(raw.PROXY_MAX_VERSION);
  const proxyMaxVersion = rawMaxVersion === null
    ? null
    : semverValue("PROXY_MAX_VERSION", rawMaxVersion, source);
  // This parser is the only production producer of a ProjectConfig, so consumers never see floor >
  // ceiling.
  if (proxyMaxVersion !== null && versionLessThan(proxyMaxVersion, proxyMinVersion)) {
    throw new Error(
      `PROXY_MAX_VERSION (${proxyMaxVersion}) is below PROXY_MIN_VERSION (${proxyMinVersion})`,
    );
  }

  const sidecarDenoVersion = semverValue(
    "SIDECAR_DENO_VERSION",
    requiredValue(raw, "SIDECAR_DENO_VERSION", source),
    source,
  );

  return { proxyMinVersion, proxyMaxVersion, sidecarDenoVersion };
}

/** ASSET_ROOT, not the install root: the file is embedded in the compiled binary and never
 *  materialized, so an installed root has no copy. `root` is for test fixtures. */
export function readProjectConfig(root: string = ASSET_ROOT): ProjectConfig {
  const path = join(root, PROJECT_CONFIG_FILE);
  return parseProjectConfig(fs.readText(path), path);
}

/** The sidecar pin alone, judged apart from the proxy bounds: health reports a malformed bound as
 *  the proxy check's failure, and the sidecar row must still name the version it compares a found
 *  deno against. */
export function readSidecarDenoVersion(root: string = ASSET_ROOT): SemverString {
  const path = join(root, PROJECT_CONFIG_FILE);
  const raw = knownKeys(fs.readText(path));
  return semverValue(
    "SIDECAR_DENO_VERSION",
    requiredValue(raw, "SIDECAR_DENO_VERSION", path),
    path,
  );
}
