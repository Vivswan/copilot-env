import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureClaudeConfig,
  DIRECT_BASE_URL,
  inspectClaudeWiring,
  runClaudeConfig,
} from "../src/claude/config.ts";

let dir = "";

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpHome(): string {
  dir = mkdtempSync(join(tmpdir(), "copilot-claude-"));
  return join(dir, ".claude");
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
}

test("direct mode writes the managed apiKeyHelper + env and the token helper, preserving user keys", () => {
  const home = tmpHome();

  configureClaudeConfig(home, "direct");
  // pre-existing settings should survive a re-run.
  const seeded = readSettings(home);
  seeded.model = "sonnet";
  seeded.permissions = { allow: ["Bash"] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, "direct");

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(join(home, "copilot-token.sh"));
  const env = doc.env as Record<string, unknown>;
  expect(env.ANTHROPIC_BASE_URL).toBe(DIRECT_BASE_URL);
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
  // Unrelated user settings are untouched.
  expect(doc.model).toBe("sonnet");
  expect((doc.permissions as Record<string, unknown>).allow).toEqual(["Bash"]);

  const helper = join(home, "copilot-token.sh");
  expect(readFileSync(helper, "utf8")).toBe("#!/bin/sh\nexec gh auth token\n");
  if (process.platform !== "win32") {
    expect(statSync(helper).mode & 0o100).not.toBe(0); // owner-executable
  }
});

test("proxy mode removes only the managed direct markers, preserving everything else", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");
  // Add an unrelated env key + top-level setting alongside the managed ones.
  const seeded = readSettings(home);
  (seeded.env as Record<string, unknown>).FOO = "bar";
  seeded.model = "sonnet";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, "proxy");

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBeUndefined();
  const env = doc.env as Record<string, unknown>;
  expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
  expect(env.FOO).toBe("bar"); // unrelated env key survives
  expect(doc.model).toBe("sonnet");
});

test("proxy mode leaves a foreign apiKeyHelper untouched (even same basename)", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct"); // create the dir + a base file
  // Same basename as ours but a different path — must NOT be treated as managed.
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ apiKeyHelper: "/opt/company/copilot-token.sh" }, null, 2)}\n`,
  );

  configureClaudeConfig(home, "proxy");

  expect(readSettings(home).apiKeyHelper).toBe("/opt/company/copilot-token.sh");
});

test("inspectClaudeWiring classifies direct / proxy / other / absent / malformed", () => {
  const HELPER = "/home/x/.claude/copilot-token.sh";

  // Managed helper at the EXACT expected path => direct.
  expect(inspectClaudeWiring(JSON.stringify({ apiKeyHelper: HELPER }), HELPER).providerMode).toBe(
    "direct",
  );

  // A foreign helper that shares the basename but lives elsewhere is NOT ours.
  expect(
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper: "/opt/company/copilot-token.sh" }), HELPER)
      .providerMode,
  ).toBe("other");

  expect(inspectClaudeWiring("{}", HELPER).providerMode).toBe("proxy");
  expect(inspectClaudeWiring(JSON.stringify({ model: "sonnet" }), HELPER).providerMode).toBe(
    "proxy",
  );

  expect(
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper: "/usr/bin/other.sh" }), HELPER).providerMode,
  ).toBe("other");
  expect(
    inspectClaudeWiring(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
      HELPER,
    ).providerMode,
  ).toBe("other");

  const absent = inspectClaudeWiring(null, HELPER);
  expect(absent.providerMode).toBe("proxy");
  expect(absent.settingsExists).toBe(false);

  expect(inspectClaudeWiring("{not json", HELPER).providerMode).toBe("other");
});

test("runClaudeConfig --direct/--proxy round-trip; mutual exclusion throws", () => {
  const home = tmpHome();
  const helper = join(home, "copilot-token.sh");

  runClaudeConfig({ "claude-home": home, direct: true });
  expect(
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), helper).providerMode,
  ).toBe("direct");

  runClaudeConfig({ "claude-home": home, proxy: true });
  expect(
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), helper).providerMode,
  ).toBe("proxy");

  expect(() => runClaudeConfig({ "claude-home": home, proxy: true, direct: true })).toThrow(
    "--proxy and --direct are mutually exclusive",
  );
});

test("runClaudeConfig no-arg refresh re-asserts direct but leaves proxy alone", () => {
  const home = tmpHome();

  // Direct with a STALE base_url: the no-arg refresh should correct it.
  runClaudeConfig({ "claude-home": home, direct: true });
  const stale = readSettings(home);
  (stale.env as Record<string, unknown>).ANTHROPIC_BASE_URL = "https://old.example";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(stale, null, 2)}\n`);

  runClaudeConfig({ "claude-home": home });
  expect((readSettings(home).env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
    DIRECT_BASE_URL,
  );

  // A proxy (unmanaged) home is left exactly as-is by the no-arg refresh.
  runClaudeConfig({ "claude-home": home, proxy: true });
  const before = readFileSync(join(home, "settings.json"), "utf8");
  runClaudeConfig({ "claude-home": home });
  expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before);
});

test("configureClaudeConfig refuses to overwrite a malformed settings.json", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "proxy"); // creates the dir
  writeFileSync(join(home, "settings.json"), "{ this is : not json");
  expect(() => configureClaudeConfig(home, "direct")).toThrow("not valid JSON");
});
