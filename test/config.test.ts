import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync as realRename,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotApiConfig, renameWithRetry } from "../src/copilot_api/config.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

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

test("save leaves no *.tmp.* sibling behind after a successful write", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);

  cfg.save({ alpha: 1 });
  // A second save exercises the rename-over-existing path too.
  cfg.save({ alpha: 2 });

  const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp."));
  expect(leftovers).toEqual([]);
  expect(readdirSync(dir)).toEqual(["config.json"]);
});

test("ensureAdminApiKey is stable across calls and differs from ensureApiKey", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const cfg = new CopilotApiConfig(join(dir, "config.json"));

  const admin = cfg.ensureAdminApiKey();
  const adminAgain = cfg.ensureAdminApiKey();
  const api = cfg.ensureApiKey();

  expect(admin).toMatch(/^[0-9a-f]{64}$/);
  expect(adminAgain).toBe(admin);
  expect(admin).not.toBe(api);

  // Persisted independently under auth, and re-reading keeps both.
  const loaded = cfg.load();
  const auth = loaded.auth as { adminApiKey: string; apiKeys: string[] };
  expect(auth.adminApiKey).toBe(admin);
  expect(auth.apiKeys[0]).toBe(api);
});

test("load returns {} for an empty/whitespace file", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);

  // Empty file.
  writeFileSync(path, "");
  expect(cfg.load()).toEqual({});

  // Whitespace-only file.
  writeFileSync(path, "  \n\t \n");
  expect(cfg.load()).toEqual({});
});

test("load returns {} for a garbage-JSON file", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);

  writeFileSync(path, "{ not: valid json ]");
  expect(cfg.load()).toEqual({});

  // A valid JSON scalar (not a record) also collapses to {}.
  writeFileSync(path, "42");
  expect(cfg.load()).toEqual({});
});

test("save sorts keys inside array elements while preserving array order", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);

  cfg.save({
    items: [
      { zulu: 1, alpha: 2 },
      { delta: 3, bravo: 4 },
    ],
  });

  const raw = readFileSync(path, "utf8");

  // Array order is preserved: the first element's value (1) precedes the second's (3).
  expect(raw.indexOf('"zulu": 1')).toBeLessThan(raw.indexOf('"delta": 3'));

  // Each element's own keys are sorted alphabetically.
  expect(raw.indexOf('"alpha"')).toBeLessThan(raw.indexOf('"zulu"'));
  expect(raw.indexOf('"bravo"')).toBeLessThan(raw.indexOf('"delta"'));

  // Values are unchanged on round-trip.
  expect(cfg.load()).toEqual({
    items: [
      { zulu: 1, alpha: 2 },
      { delta: 3, bravo: 4 },
    ],
  });
});

test("renameWithRetry retries transient EBUSY/EPERM then succeeds", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const from = join(dir, "src");
  const to = join(dir, "dst");

  let calls = 0;
  const flaky = (f: string, t: string): void => {
    calls += 1;
    if (calls === 1) {
      const err = new Error("busy") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    }
    if (calls === 2) {
      const err = new Error("perm") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }
    realRename(f, t);
  };

  writeFileSync(from, "payload");
  renameWithRetry(from, to, 5, flaky);

  expect(calls).toBe(3);
  expect(readFileSync(to, "utf8")).toBe("payload");
});

test("renameWithRetry surfaces a non-transient error immediately", () => {
  let calls = 0;
  const bad = (): void => {
    calls += 1;
    const err = new Error("nope") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };

  expect(() => renameWithRetry("a", "b", 5, bad)).toThrow("nope");
  // ENOENT is not transient, so it is not retried.
  expect(calls).toBe(1);
});

// An UNREADABLE store is not an empty one. update() is a read-modify-WRITE, so
// treating a failed read as `{}` would persist the emptiness and wipe every key the
// file holds -- the daemon's api key, admin key and providers. The file's retry loop
// exists for exactly that wipe (the proxy writes config.json non-atomically), and the
// read-error arm used to return BEFORE the retry could run.
//
// This is the row that REPRODUCES the wipe: an unreadable file (0000) inside a
// writable directory, so the read fails while the atomic rename would still succeed.
// A directory at the config path would NOT prove anything -- the rename fails there
// on its own, so the content survives with or without the fix.
// POSIX, non-root only: root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "update REFUSES an unreadable store instead of WIPING it",
  () => {
    dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
    const path = join(dir, "config.json");
    const cfg = new CopilotApiConfig(path);
    cfg.save({ auth: { apiKeys: ["secret-key"], adminApiKey: "admin-secret" } });
    const before = readFileSync(path, "utf8");
    chmodSync(path, 0o000); // readable no more; the parent dir stays writable

    try {
      let threw = "";
      try {
        cfg.update((d) => {
          d.smallModel = "gpt-6";
        });
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      // Positive assertion, so a call that did NOT throw fails this test rather
      // than passing on an empty string.
      expect(threw).toContain("refusing to overwrite it");
      // THE outcome: the secrets are still on disk, byte for byte.
      chmodSync(path, 0o600);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      chmodSync(path, 0o600);
    }
  },
);

test("update still writes normally when the store IS readable (the control)", () => {
  // The control for the row above: the refusal must not cost the ordinary path.
  // Same shape, same keys -- the only difference is that the store is readable.
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);
  cfg.save({ existing: "keep", smallModel: "gpt-5.5" });

  cfg.update((d) => {
    d.smallModel = "gpt-6";
  });

  expect(cfg.load()).toEqual({ existing: "keep", smallModel: "gpt-6" });
});

test("a genuinely absent store still reads as an empty document, not unreadable", () => {
  // The other control: absence is a PROVEN answer and must keep flowing through
  // update() as `{}` -- otherwise first-run key generation would refuse.
  dir = mkdtempSync(join(tmpdir(), "copilot-config-"));
  const cfg = new CopilotApiConfig(join(dir, "config.json"));
  cfg.update((d) => {
    d.created = true;
  });
  expect(cfg.load()).toEqual({ created: true });
});
