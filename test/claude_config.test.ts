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
import { copilotApiResolvePort } from "../src/copilot_api/port.ts";

const SAVED = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  COPILOT_API_HOME: process.env.COPILOT_API_HOME,
};
let dir = "";

function restore(key: keyof typeof SAVED): void {
  if (SAVED[key] === undefined) delete process.env[key];
  else process.env[key] = SAVED[key];
}

afterEach(() => {
  for (const k of Object.keys(SAVED) as (keyof typeof SAVED)[]) restore(k);
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

// A temp Claude home, with an isolated gateway home so proxy writes (which
// resolve the gateway endpoint/token) don't touch any real state.
function tmpHome(): string {
  dir = mkdtempSync(join(tmpdir(), "copilot-claude-"));
  process.env.COPILOT_API_HOME = join(dir, "gateway-home");
  return join(dir, ".claude");
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
}

test("direct mode writes the managed apiKeyHelper + env and the token helper, preserving user keys", () => {
  const home = tmpHome();

  configureClaudeConfig(home, "direct");
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
  expect(doc.model).toBe("sonnet");
  expect((doc.permissions as Record<string, unknown>).allow).toEqual(["Bash"]);

  const helper = join(home, "copilot-token.sh");
  expect(readFileSync(helper, "utf8")).toBe("#!/bin/sh\nexec gh auth token\n");
  if (process.platform !== "win32") {
    expect(statSync(helper).mode & 0o100).not.toBe(0);
  }
});

test("proxy mode writes gateway wiring (localhost base URL + a token helper), preserving user keys", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct"); // seed, then add a user key
  const seeded = readSettings(home);
  seeded.model = "sonnet";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, "proxy");

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(join(home, "copilot-gateway-token.sh"));
  const env = doc.env as Record<string, unknown>;
  expect(env.ANTHROPIC_BASE_URL).toBe(`http://localhost:${copilotApiResolvePort()}`);
  // Disable-betas is a direct-only knob; switching to proxy drops it.
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
  expect(doc.model).toBe("sonnet"); // unrelated user key survives

  const helper = join(home, "copilot-gateway-token.sh");
  const script = readFileSync(helper, "utf8");
  expect(script.startsWith("#!/bin/sh\nprintf '%s' '")).toBe(true);
  if (process.platform !== "win32") {
    expect(statSync(helper).mode & 0o100).not.toBe(0);
  }
});

test("inspectClaudeWiring classifies direct / proxy / other / none / malformed (by exact path)", () => {
  const home = "/home/x/.claude";
  const directHelper = `${home}/copilot-token.sh`;
  const proxyHelper = `${home}/copilot-gateway-token.sh`;

  expect(
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper: directHelper }), home).providerMode,
  ).toBe("direct");
  expect(
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper: proxyHelper }), home).providerMode,
  ).toBe("proxy");

  // A foreign helper sharing our basename but elsewhere is NOT ours.
  expect(
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper: "/opt/company/copilot-token.sh" }), home)
      .providerMode,
  ).toBe("other");
  // A custom base URL with no managed helper is also "other".
  expect(
    inspectClaudeWiring(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
      home,
    ).providerMode,
  ).toBe("other");

  expect(inspectClaudeWiring("{}", home).providerMode).toBe("none");
  expect(inspectClaudeWiring(JSON.stringify({ model: "sonnet" }), home).providerMode).toBe("none");

  const absent = inspectClaudeWiring(null, home);
  expect(absent.providerMode).toBe("none");
  expect(absent.settingsExists).toBe(false);

  expect(inspectClaudeWiring("{not json", home).providerMode).toBe("other");
});

test("runClaudeConfig --direct/--proxy round-trip cleans the other mode; mutual exclusion throws", () => {
  const home = tmpHome();
  const read = () => inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home);

  runClaudeConfig({ "claude-home": home, direct: true });
  expect(read().providerMode).toBe("direct");
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBe("1");

  runClaudeConfig({ "claude-home": home, proxy: true });
  expect(read().providerMode).toBe("proxy");
  // Switching to proxy drops the direct-only disable-betas knob.
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBeUndefined();

  runClaudeConfig({ "claude-home": home, direct: true });
  expect(read().providerMode).toBe("direct");

  expect(() => runClaudeConfig({ "claude-home": home, proxy: true, direct: true })).toThrow(
    "--proxy and --direct are mutually exclusive",
  );
});

test("runClaudeConfig no-arg refresh: none -> proxy, direct re-asserts, custom left alone", () => {
  const home = tmpHome();

  // Never configured -> the no-arg refresh writes proxy (gateway is the default).
  runClaudeConfig({ "claude-home": home });
  expect(
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home).providerMode,
  ).toBe("proxy");

  // Already direct (with a stale base URL) -> re-asserted, not flipped to proxy.
  runClaudeConfig({ "claude-home": home, direct: true });
  const stale = readSettings(home);
  (stale.env as Record<string, unknown>).ANTHROPIC_BASE_URL = "https://old.example";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(stale, null, 2)}\n`);
  runClaudeConfig({ "claude-home": home });
  expect((readSettings(home).env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
    DIRECT_BASE_URL,
  );

  // A custom (foreign) config is left exactly as-is by the no-arg refresh.
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ apiKeyHelper: "/opt/company/copilot-token.sh" }, null, 2)}\n`,
  );
  const before = readFileSync(join(home, "settings.json"), "utf8");
  runClaudeConfig({ "claude-home": home });
  expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before);
});

test("configureClaudeConfig refuses to overwrite a malformed settings.json", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct"); // creates the dir + a valid file
  writeFileSync(join(home, "settings.json"), "{ this is : not json");
  expect(() => configureClaudeConfig(home, "direct")).toThrow("not valid JSON");
});
