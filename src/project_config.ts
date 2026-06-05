import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_CONFIG_FILE = "copilot-env.config";

const CONFIG_KEYS = [
  "CooldownRepoMinSha",
  "CooldownRepoMaxSha",
  "GATEWAY_MIN_VERSION",
  "GATEWAY_MAX_VERSION",
] as const;

type ProjectConfigKey = (typeof CONFIG_KEYS)[number];

export type ProjectConfig = {
  readonly cooldownRepoMinSha: string;
  readonly cooldownRepoMaxSha: string | null;
  readonly gatewayMinVersion: string;
  readonly gatewayMaxVersion: string | null;
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

  return {
    "cooldownRepoMinSha": requiredValue(raw, "CooldownRepoMinSha", source),
    "cooldownRepoMaxSha": optionalValue(raw.CooldownRepoMaxSha),
    "gatewayMinVersion": requiredValue(raw, "GATEWAY_MIN_VERSION", source),
    "gatewayMaxVersion": optionalValue(raw.GATEWAY_MAX_VERSION),
  };
}

export function readProjectConfig(root: string): ProjectConfig {
  const path = join(root, PROJECT_CONFIG_FILE);
  return parseProjectConfig(readFileSync(path, "utf8"), path);
}
