import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  floatGateway,
  gatewayFloatUpToDate,
  gatewayFloatVerifyStatus,
  gatewayInstallAssertStatus,
  nodeModulesFresh,
  readBunMinimumReleaseAgeSeconds,
  type SpawnSyncRunner,
} from "../src/gateway_float.ts";
import type { ProjectConfig } from "../src/utils/project_config.ts";

// gatewayFloatUpToDate / nodeModulesFresh back the bin shims' `--verify` fast path:
// they decide whether a full `bun install` can be skipped.

const GATEWAY_PKG = "@jeffreycao/copilot-api";
const NOW_MS = Date.parse("2026-06-10T00:00:00.000Z");
const DAY_MS = 86_400_000;

const CONFIG: ProjectConfig = {
  "gatewayMinVersion": "1.10.0",
  "gatewayMaxVersion": null,
};

const NO_FLOAT_ENV = "COPILOT_API_NO_FLOAT";
const VERSION_ENV = "COPILOT_API_VERSION";

let dir = "";
const savedNoFloat = process.env[NO_FLOAT_ENV];
const savedVersion = process.env[VERSION_ENV];
const SPAWN_OK: ReturnType<typeof spawnSync> = {
  "error": undefined,
  "output": [],
  "pid": 0,
  "signal": null,
  "status": 0,
  "stderr": Buffer.alloc(0),
  "stdout": Buffer.alloc(0),
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Write a fake installed gateway at the given version. */
function installGateway(root: string, version: string): void {
  const pkgDir = join(root, "node_modules", "@jeffreycao", "copilot-api");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ "version": version }));
}

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

function npmTime(daysByVersion: Record<string, number>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(daysByVersion).map(([version, days]) => [version, isoDaysAgo(days)]),
  );
}

function spawnWithTime(timeMap: Record<string, string>): {
  calls: string[][];
  spawn: SpawnSyncRunner;
} {
  const calls: string[][] = [];
  return {
    calls,
    "spawn": (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pm") {
        return { ...SPAWN_OK, "stdout": Buffer.from(JSON.stringify(timeMap)) };
      }
      if (args[0] === "add") {
        const spec = args[1] ?? "";
        installGateway(dir, spec.slice(`${GATEWAY_PKG}@`.length));
      }
      return SPAWN_OK;
    },
  };
}

function spawnWithMetadataFailure(): { calls: string[][]; spawn: SpawnSyncRunner } {
  const calls: string[][] = [];
  return {
    calls,
    "spawn": (_command, args) => {
      calls.push([...args]);
      if (args[0] === "pm") {
        return { ...SPAWN_OK, "status": 1, "stderr": Buffer.from("offline") };
      }
      if (args[0] === "add") {
        const spec = args[1] ?? "";
        installGateway(dir, spec.slice(`${GATEWAY_PKG}@`.length));
      }
      return SPAWN_OK;
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "copilot-float-"));
  // The verify helpers read these env vars; isolate every test from the ambient env.
  delete process.env[NO_FLOAT_ENV];
  delete process.env[VERSION_ENV];
});

afterEach(() => {
  restoreEnv(NO_FLOAT_ENV, savedNoFloat);
  restoreEnv(VERSION_ENV, savedVersion);
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("gatewayFloatUpToDate", () => {
  test("true for normal no-env float when the computed cooldown-aged target is installed", () => {
    installGateway(dir, "1.10.30");
    const { calls, spawn } = spawnWithTime(npmTime({ "1.10.30": 8, "1.10.31": 1 }));

    expect(gatewayFloatUpToDate(dir, "bun", CONFIG, 604800, spawn, NOW_MS)).toBe(true);
    expect(calls[0]).toEqual(["pm", "view", GATEWAY_PKG, "time", "--json"]);
  });

  test("false for normal no-env float when the computed cooldown-aged target differs", () => {
    installGateway(dir, "1.10.29");
    const { spawn } = spawnWithTime(npmTime({ "1.10.30": 8, "1.10.31": 1 }));

    const status = gatewayFloatVerifyStatus(dir, "bun", CONFIG, 604800, spawn, NOW_MS);

    expect(status.upToDate).toBe(false);
    expect(status.message).toContain("update needed: @jeffreycao/copilot-api 1.10.29 -> 1.10.30");
  });

  test("false when the gateway is not installed", () => {
    expect(gatewayFloatUpToDate(dir)).toBe(false);
  });

  test("NO_FLOAT: true iff a readable gateway is present (float disabled)", () => {
    process.env[NO_FLOAT_ENV] = "1";
    expect(gatewayFloatUpToDate(dir)).toBe(false);
    installGateway(dir, "1.10.22");
    expect(gatewayFloatUpToDate(dir)).toBe(true);
    // An unreadable gateway package.json still falls through to a repair install.
    writeFileSync(
      join(dir, "node_modules", "@jeffreycao", "copilot-api", "package.json"),
      "{ not json",
    );
    expect(gatewayFloatUpToDate(dir)).toBe(false);
  });

  test("COPILOT_API_VERSION: true only when the exact pin is installed", () => {
    installGateway(dir, "1.10.30");
    process.env[VERSION_ENV] = "1.10.30";
    expect(gatewayFloatUpToDate(dir)).toBe(true);
    process.env[VERSION_ENV] = "1.10.31";
    expect(gatewayFloatUpToDate(dir)).toBe(false);
    // A dist-tag override always re-resolves -> never "up to date".
    process.env[VERSION_ENV] = "latest";
    expect(gatewayFloatUpToDate(dir)).toBe(false);
  });
});

describe("floatGateway", () => {
  test("default no-env float installs the exact newest cooldown-aged target", () => {
    const { calls, spawn } = spawnWithTime(npmTime({ "1.10.30": 8, "1.10.31": 1 }));

    floatGateway(dir, "bun", CONFIG, 604800, spawn, NOW_MS);

    const addCalls = calls.filter((args) => args[0] === "add");
    expect(addCalls).toEqual([
      [
        "add",
        "@jeffreycao/copilot-api@1.10.30",
        "--no-save",
        "--ignore-scripts",
        "--minimum-release-age=0",
      ],
    ]);
  });

  test("default no-env float skips install when the exact target is already installed", () => {
    installGateway(dir, "1.10.30");
    const { calls, spawn } = spawnWithTime(npmTime({ "1.10.30": 8, "1.10.31": 1 }));

    floatGateway(dir, "bun", CONFIG, 604800, spawn, NOW_MS);

    expect(calls.filter((args) => args[0] === "add")).toEqual([]);
  });

  test("target clamps up to the configured floor", () => {
    const { calls, spawn } = spawnWithTime(npmTime({ "1.10.29": 8 }));

    floatGateway(
      dir,
      "bun",
      { "gatewayMinVersion": "1.10.30", "gatewayMaxVersion": null },
      604800,
      spawn,
      NOW_MS,
    );

    expect(calls.filter((args) => args[0] === "add")[0]).toEqual([
      "add",
      "@jeffreycao/copilot-api@1.10.30",
      "--no-save",
      "--ignore-scripts",
      "--minimum-release-age=0",
    ]);
  });

  test("target clamps down to the configured ceiling", () => {
    const { calls, spawn } = spawnWithTime(npmTime({ "1.10.29": 8, "1.10.30": 8 }));

    floatGateway(
      dir,
      "bun",
      { "gatewayMinVersion": "1.10.0", "gatewayMaxVersion": "1.10.29" },
      604800,
      spawn,
      NOW_MS,
    );

    expect(calls.filter((args) => args[0] === "add")[0]).toEqual([
      "add",
      "@jeffreycao/copilot-api@1.10.29",
      "--no-save",
      "--ignore-scripts",
      "--minimum-release-age=0",
    ]);
  });

  test("metadata failure keeps an installed gateway that satisfies the floor", () => {
    installGateway(dir, "1.10.30");
    const { calls, spawn } = spawnWithMetadataFailure();

    floatGateway(dir, "bun", CONFIG, 604800, spawn, NOW_MS);

    expect(calls.filter((args) => args[0] === "add")).toEqual([]);
  });

  test("metadata failure pins the floor when no installed gateway satisfies it", () => {
    const { calls, spawn } = spawnWithMetadataFailure();

    floatGateway(
      dir,
      "bun",
      { "gatewayMinVersion": "1.10.30", "gatewayMaxVersion": null },
      604800,
      spawn,
      NOW_MS,
    );

    expect(calls.filter((args) => args[0] === "add")[0]).toEqual([
      "add",
      "@jeffreycao/copilot-api@1.10.30",
      "--no-save",
      "--ignore-scripts",
      "--minimum-release-age=0",
    ]);
  });
});

describe("gatewayInstallAssertStatus", () => {
  test("fails when the gateway is missing", () => {
    const status = gatewayInstallAssertStatus(dir, CONFIG);

    expect(status.ok).toBe(false);
    expect(status.message).toContain("gateway float did not install @jeffreycao/copilot-api");
  });

  test("fails below the configured floor", () => {
    installGateway(dir, "1.9.99");

    const status = gatewayInstallAssertStatus(dir, CONFIG);

    expect(status.ok).toBe(false);
    expect(status.message).toContain("is below the 1.10.0 floor");
  });

  test("fails above the configured ceiling", () => {
    installGateway(dir, "1.10.31");

    const status = gatewayInstallAssertStatus(dir, {
      "gatewayMinVersion": "1.10.0",
      "gatewayMaxVersion": "1.10.30",
    });

    expect(status.ok).toBe(false);
    expect(status.message).toContain("is above the 1.10.30 ceiling");
  });

  test("passes within the configured floor and ceiling", () => {
    installGateway(dir, "1.10.30");

    const status = gatewayInstallAssertStatus(dir, {
      "gatewayMinVersion": "1.10.0",
      "gatewayMaxVersion": "1.10.30",
    });

    expect(status.ok).toBe(true);
    expect(status.message).toBe(
      "gateway float OK: @jeffreycao/copilot-api 1.10.30 (within [1.10.0, 1.10.30])",
    );
  });
});

describe("readBunMinimumReleaseAgeSeconds", () => {
  test("reads install.minimumReleaseAge from bunfig.toml", () => {
    writeFileSync(
      join(dir, "bunfig.toml"),
      `
[install]
minimumReleaseAge = 604800  # 7 days
`,
    );

    expect(readBunMinimumReleaseAgeSeconds(dir)).toBe(604800);
  });

  test("defaults to 0 when bunfig.toml has no minimumReleaseAge", () => {
    writeFileSync(
      join(dir, "bunfig.toml"),
      `
[install]
registry = "https://registry.npmjs.org"
`,
    );

    expect(readBunMinimumReleaseAgeSeconds(dir)).toBe(0);
  });

  test("throws on non-integer minimumReleaseAge", () => {
    writeFileSync(
      join(dir, "bunfig.toml"),
      `
[install]
minimumReleaseAge = "seven days"
`,
    );

    expect(() => readBunMinimumReleaseAgeSeconds(dir)).toThrow(
      "bunfig.toml install.minimumReleaseAge must be a whole number of seconds",
    );
  });
});

describe("nodeModulesFresh", () => {
  function touch(path: string, ageMs: number): void {
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }

  test("true when node_modules is at least as new as bun.lock", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "bun.lock"), "");
    touch(join(dir, "bun.lock"), 10_000);
    touch(join(dir, "node_modules"), 0);
    expect(nodeModulesFresh(dir)).toBe(true);
  });

  test("ignores a newer package.json (only bun.lock signals dependency drift)", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(join(dir, "package.json"), "{}");
    touch(join(dir, "bun.lock"), 10_000);
    touch(join(dir, "node_modules"), 5_000);
    touch(join(dir, "package.json"), 0); // newest, but must not force a reinstall
    expect(nodeModulesFresh(dir)).toBe(true);
  });

  test("false when bun.lock is newer than node_modules (dependency drift)", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "bun.lock"), "");
    touch(join(dir, "node_modules"), 10_000);
    touch(join(dir, "bun.lock"), 0); // newest
    expect(nodeModulesFresh(dir)).toBe(false);
  });

  test("false when node_modules is absent", () => {
    expect(nodeModulesFresh(dir)).toBe(false);
  });

  test("true when bun.lock is absent (nothing to compare against)", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    expect(nodeModulesFresh(dir)).toBe(true);
  });
});
