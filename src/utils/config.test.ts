import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CopilotApiConfig } from "./config.ts";

let dir = "";

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

test("save sorts keys recursively, writes a trailing newline, and round-trips", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);
  cfg.save({ zebra: 1, alpha: { y: 2, x: 1 } });

  const raw = readFileSync(path, "utf8");
  expect(raw.indexOf('"alpha"')).toBeLessThan(raw.indexOf('"zebra"'));
  expect(raw.indexOf('"x"')).toBeLessThan(raw.indexOf('"y"'));
  expect(raw.endsWith("\n")).toBe(true);

  // chmod 0600 is best-effort and a no-op on Windows.
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }

  expect(cfg.load()).toEqual({ zebra: 1, alpha: { y: 2, x: 1 } });
});

test("load returns {} for a missing or empty file", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const cfg = new CopilotApiConfig(join(dir, "does-not-exist.json"));
  expect(cfg.load()).toEqual({});
});

test("update preserves unknown keys while mutating the targeted one", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const cfg = new CopilotApiConfig(join(dir, "config.json"));
  cfg.save({ existing: "keep", smallModel: "gpt-5.5" });

  cfg.update((d) => {
    d.smallModel = "gpt-6";
  });

  const loaded = cfg.load();
  expect(loaded.existing).toBe("keep");
  expect(loaded.smallModel).toBe("gpt-6");
});

test("ensureApiKey generates a 64-hex key once and is stable across calls", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const cfg = new CopilotApiConfig(join(dir, "config.json"));

  const first = cfg.ensureApiKey();
  const second = cfg.ensureApiKey();

  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(second).toBe(first);
});
