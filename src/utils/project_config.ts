// Parser for copilot-env.config proxy floor/ceiling settings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_ROOT } from "./root.ts";
import { type SemverString, toSemverString, versionLessThan } from "./semver.ts";

export const PROJECT_CONFIG_FILE = "copilot-env.config";

const CONFIG_KEYS = ["PROXY_MIN_VERSION", "PROXY_MAX_VERSION"] as const;

type ProjectConfigKey = (typeof CONFIG_KEYS)[number];

export type ProjectConfig = {
  readonly proxyMinVersion: SemverString;
  readonly proxyMaxVersion: SemverString | null;
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

// versionLessThan treats an unparseable side as "not less-than", so a garbage bound
// would silently disable every downstream range check -- the floor fails OPEN.
// Parsing (and normalizing) here makes that state unrepresentable past this boundary.
function semverValue(key: ProjectConfigKey, value: string, source: string): SemverString {
  const parsed = toSemverString(value);
  if (parsed === null) {
    throw new Error(`${source}: ${key} is not a semver version: "${value}"`);
  }
  return parsed;
}

export function parseProjectConfig(content: string, source = PROJECT_CONFIG_FILE): ProjectConfig {
  const raw: Partial<Record<ProjectConfigKey, string>> = {};

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");
    if (equals < 0) {
      throw new Error(`${source}:${index + 1}: expected KEY=value`);
    }

    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    if (isProjectConfigKey(key)) {
      raw[key] = value;
    }
  }

  const proxyMinVersion = semverValue(
    "PROXY_MIN_VERSION",
    requiredValue(raw, "PROXY_MIN_VERSION", source),
    source,
  );
  const rawMaxVersion = optionalValue(raw.PROXY_MAX_VERSION);
  const proxyMaxVersion = rawMaxVersion === null
    ? null
    : semverValue("PROXY_MAX_VERSION", rawMaxVersion, source);
  // Reject an inverted window here at the parse boundary: this parser is the only
  // PRODUCTION producer of a ProjectConfig, so consumers never see floor > ceiling
  // (SemverString's literal shape keeps test-built configs assignable directly).
  if (proxyMaxVersion !== null && versionLessThan(proxyMaxVersion, proxyMinVersion)) {
    throw new Error(
      `PROXY_MAX_VERSION (${proxyMaxVersion}) is below PROXY_MIN_VERSION (${proxyMinVersion})`,
    );
  }

  return { proxyMinVersion, proxyMaxVersion };
}

/**
 * Read the copilot-env.config that ships with this build. Defaults to ASSET_ROOT,
 * NOT the install root: the file is embedded in the compiled binary and never
 * materialized onto disk, so an installed root has no copy of it. `root` is for
 * tests pointing at a fixture directory.
 */
export function readProjectConfig(root: string = ASSET_ROOT): ProjectConfig {
  const path = join(root, PROJECT_CONFIG_FILE);
  return parseProjectConfig(readFileSync(path, "utf8"), path);
}
