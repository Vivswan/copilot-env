import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gatewayFloatUpToDate, nodeModulesFresh } from "../src/gateway_float.ts";
import type { ProjectConfig } from "../src/project_config.ts";

// gatewayFloatUpToDate / nodeModulesFresh back the bin shims' `--verify` fast path:
// they decide, with pure fs reads, whether a full `bun install` can be skipped.

const CONFIG: ProjectConfig = {
  "cooldownRepoMinSha": "0000000000000000000000000000000000000000",
  "cooldownRepoMaxSha": null,
  "gatewayMinVersion": "1.10.0",
  "gatewayMaxVersion": null,
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NO_FLOAT_ENV = "COPILOT_API_NO_FLOAT";
const VERSION_ENV = "COPILOT_API_VERSION";

let dir = "";
const savedNoFloat = process.env[NO_FLOAT_ENV];
const savedVersion = process.env[VERSION_ENV];

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

/** Write the float stamp recording `version`, with mtime `ageMs` in the past. */
function writeStamp(root: string, version: string, ageMs = 0): void {
  const stamp = join(root, ".gateway-checked");
  writeFileSync(stamp, `${version}\n`);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(stamp, when, when);
  }
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
  test("up to date when installed == recorded, in-window, fresh stamp", () => {
    installGateway(dir, "1.10.30");
    writeStamp(dir, "1.10.30");
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(true);
  });

  test("false when the gateway is not installed", () => {
    writeStamp(dir, "1.10.30");
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(false);
  });

  test("false when no version is recorded yet", () => {
    installGateway(dir, "1.10.30");
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(false);
  });

  test("false when the installed gateway drifted from the recorded target", () => {
    installGateway(dir, "1.10.22");
    writeStamp(dir, "1.10.30");
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(false);
  });

  test("false when the weekly stamp has aged out", () => {
    installGateway(dir, "1.10.30");
    writeStamp(dir, "1.10.30", 8 * 24 * 60 * 60 * 1000);
    expect(gatewayFloatUpToDate(dir, CONFIG, WEEK_MS)).toBe(false);
  });

  test("false when the recorded target falls outside the [floor, max] window", () => {
    installGateway(dir, "1.9.0");
    writeStamp(dir, "1.9.0"); // below gatewayMinVersion 1.10.0
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(false);
  });

  test("NO_FLOAT: true iff a readable gateway is present (float disabled)", () => {
    process.env[NO_FLOAT_ENV] = "1";
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(false);
    installGateway(dir, "1.10.22");
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(true);
    // An unreadable gateway package.json still falls through to a repair install.
    writeFileSync(
      join(dir, "node_modules", "@jeffreycao", "copilot-api", "package.json"),
      "{ not json",
    );
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(false);
  });

  test("COPILOT_API_VERSION: true only when the exact pin is installed", () => {
    installGateway(dir, "1.10.30");
    process.env[VERSION_ENV] = "1.10.30";
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(true);
    process.env[VERSION_ENV] = "1.10.31";
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(false);
    // A dist-tag override always re-resolves -> never "up to date".
    process.env[VERSION_ENV] = "latest";
    expect(gatewayFloatUpToDate(dir, CONFIG)).toBe(false);
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
