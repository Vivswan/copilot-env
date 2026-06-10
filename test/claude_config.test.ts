import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureClaudeConfig,
  DIRECT_BASE_URL,
  detectClaudeDirect,
  inspectClaudeWiring,
  runClaude,
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
  // Build the managed helper paths with join() so they match inspectClaudeWiring's
  // own path.join() on every OS (forward-slash literals fail the exact match on Windows).
  const directHelper = join(home, "copilot-token.sh");
  const proxyHelper = join(home, "copilot-gateway-token.sh");

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

test("runClaude --direct/--proxy round-trip cleans the other mode; mutual exclusion throws", () => {
  const home = tmpHome();
  const read = () => inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home);

  runClaude({ "claude-home": home, direct: true });
  expect(read().providerMode).toBe("direct");
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBe("1");

  runClaude({ "claude-home": home, proxy: true });
  expect(read().providerMode).toBe("proxy");
  // Switching to proxy drops the direct-only disable-betas knob.
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBeUndefined();

  runClaude({ "claude-home": home, direct: true });
  expect(read().providerMode).toBe("direct");

  expect(() => runClaude({ "claude-home": home, proxy: true, direct: true })).toThrow(
    "--direct, --proxy, and --auto are mutually exclusive",
  );
});

test("detectClaudeDirect: true only when CLI+gh present, gh authed, and the probe succeeds", () => {
  const home = tmpHome();
  // detectClaudeDirect writes a throwaway direct config under a temp home; the
  // tmpHome()/COPILOT_API_HOME isolation keeps it off any real state.
  void home;
  const ok = {
    resolveCommand: (c: string) => `/bin/${c}`,
    ghAuthOk: () => true,
    runProbe: () => true,
    retryDelayMs: 0,
  };
  expect(detectClaudeDirect(ok)).toBe(true);
  expect(detectClaudeDirect({ ...ok, runProbe: () => false })).toBe(false);
  expect(detectClaudeDirect({ ...ok, ghAuthOk: () => false })).toBe(false);
  expect(
    detectClaudeDirect({ ...ok, resolveCommand: (c) => (c === "claude" ? null : `/bin/${c}`) }),
  ).toBe(false);
  expect(
    detectClaudeDirect({ ...ok, resolveCommand: (c) => (c === "gh" ? null : `/bin/${c}`) }),
  ).toBe(false);
});

test("configureClaudeConfig refuses to overwrite a malformed settings.json", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct"); // creates the dir + a valid file
  writeFileSync(join(home, "settings.json"), "{ this is : not json");
  expect(() => configureClaudeConfig(home, "direct")).toThrow("not valid JSON");
});
