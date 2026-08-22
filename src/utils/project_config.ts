// Parser for copilot-env.config proxy floor/ceiling settings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_ROOT } from "./root.ts";
import { versionLessThan } from "./semver.ts";

export const PROJECT_CONFIG_FILE = "copilot-env.config";

const CONFIG_KEYS = ["PROXY_MIN_VERSION", "PROXY_MAX_VERSION"] as const;

type ProjectConfigKey = (typeof CONFIG_KEYS)[number];

export type ProjectConfig = {
  readonly proxyMinVersion: string;
  readonly proxyMaxVersion: string | null;
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

  const proxyMinVersion = requiredValue(raw, "PROXY_MIN_VERSION", source);
  const proxyMaxVersion = optionalValue(raw.PROXY_MAX_VERSION);
  // Reject an inverted window here at the parse boundary: this parser is the only
  // PRODUCTION producer of a ProjectConfig, so consumers never see floor > ceiling
  // (the type itself stays structural; tests build literals directly).
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
