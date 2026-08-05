import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CUSTOM_HEADERS_ENV,
  cmdHelperBody,
  configureClaudeConfig,
  DIRECT_BASE_URL,
  detectClaudeDirect,
  inspectClaudeWiring,
  removeClaudeDefaultWiring,
  runClaude,
  syncDefaultWebSearchWiring,
  WEBSEARCH_DENY_RULE,
} from "../src/claude/config.ts";
import { claudeJsonPath } from "../src/claude/mcp_registration.ts";
import { DIRECT_HELPER_NAME, PROXY_HELPER_NAME } from "../src/claude/paths.ts";
import { runMcp } from "../src/commands/mcp.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { copilotApiResolvePort } from "../src/copilot_api/port.ts";
import { envSnapshot, isolateAgentHomes, removeDir } from "./helpers.ts";

const WIN = process.platform === "win32";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

// A temp Claude home, exported via CLAUDE_CONFIG_DIR (the only home knob now),
// with an isolated proxy home so proxy writes (which resolve the proxy
// endpoint/token) don't touch any real state.
function tmpHome(): string {
  const homes = isolateAgentHomes("copilot-claude-");
  dir = homes.dir;
  return homes.claudeHome;
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
  expect(doc.apiKeyHelper).toBe(join(home, DIRECT_HELPER_NAME));
  const env = doc.env as Record<string, unknown>;
  expect(env.ANTHROPIC_BASE_URL).toBe(DIRECT_BASE_URL);
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
  // Direct sends Copilot's editor-client headers (Openai-Intent + a codex_exec User-Agent
  // derived from the installed codex binary; versionless when codex is absent here --
  // the runtime npm-latest fallback is disabled under NODE_ENV=test).
  const headers = env[CUSTOM_HEADERS_ENV] as string;
  expect(headers).toContain("Openai-Intent: conversation-edits");
  expect(headers).toMatch(/(^|\n)User-Agent: codex_exec/);
  // No probed identity passed -> no Copilot-Integration-Id line (default identity).
  expect(headers).not.toContain("Copilot-Integration-Id");
  expect(doc.model).toBe("sonnet");
  expect((doc.permissions as Record<string, unknown>).allow).toEqual(["Bash"]);

  const helper = join(home, DIRECT_HELPER_NAME);
  const directScript = readFileSync(helper, "utf8");
  // The direct helper execs `agent auth --get` (the resolver) -- never `gh auth token`,
  // never a baked token. POSIX is a #!/bin/sh script; Windows a @echo off .cmd.
  expect(directScript.startsWith(WIN ? "@echo off\r\n" : "#!/bin/sh\nexec ")).toBe(true);
  expect(directScript).toContain("auth");
  expect(directScript).toContain("--get");
  expect(directScript).not.toContain("gh auth token");
  if (!WIN) {
    expect(statSync(helper).mode & 0o100).not.toBe(0);
  }
});

test("direct bakes a probed Copilot-Integration-Id into ANTHROPIC_CUSTOM_HEADERS when passed", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct", { directIntegrationId: "copilot-developer-cli" });
  const headers = (readSettings(home).env as Record<string, unknown>)[CUSTOM_HEADERS_ENV] as string;
  expect(headers).toContain("Copilot-Integration-Id: copilot-developer-cli");
  expect(headers).toContain("Openai-Intent: conversation-edits");
  // Pin the exact line order the serializer emits (the probe validates this same set).
  expect(headers.split("\n").map((line) => line.split(":")[0])).toEqual([
    "Openai-Intent",
    "User-Agent",
    "Copilot-Integration-Id",
  ]);
});

test("proxy mode writes proxy wiring (127.0.0.1 base URL + a token helper), preserving user keys", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct"); // seed, then add a user key
  const seeded = readSettings(home);
  seeded.model = "sonnet";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, "proxy");

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(join(home, PROXY_HELPER_NAME));
  const env = doc.env as Record<string, unknown>;
  expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${copilotApiResolvePort()}`);
  // Disable-betas is a direct-only knob; switching to proxy drops it.
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
  // The editor-client headers are likewise direct-only; proxy mode scrubs them.
  expect(env[CUSTOM_HEADERS_ENV]).toBeUndefined();
  expect(doc.model).toBe("sonnet"); // unrelated user key survives

  const helper = join(home, PROXY_HELPER_NAME);
  const script = readFileSync(helper, "utf8");
  // The proxy helper runs the shared proxy-token resolver (with --yes); no literal token is
  // baked in. POSIX execs proxy-token.sh; Windows is a .cmd that invokes the .ps1 twin.
  expect(script.startsWith(WIN ? "@echo off\r\n" : "#!/bin/sh\n")).toBe(true);
  expect(script).toContain(WIN ? "proxy-token.ps1" : "proxy-token.sh");
  if (!WIN) {
    expect(statSync(helper).mode & 0o100).not.toBe(0);
  }
});

test("cmdHelperBody: @echo off + CRLF, quotes paths with spaces, escapes % as %%", () => {
  // The Windows .cmd helper shells into PowerShell; paths carry spaces/`%` (a legal Windows
  // path char). winQuote double-quotes the path; cmdHelperBody doubles every `%` so batch
  // variable-expansion can't mangle it. Pure + platform-independent, so it runs on POSIX CI.
  const body = cmdHelperBody("powershell", [
    "-NoProfile",
    "-File",
    "C:\\Users\\a b\\50%done\\agent.ps1",
    "auth",
    "--get",
  ]);
  expect(body.startsWith("@echo off\r\n")).toBe(true);
  expect(body.endsWith("\r\n")).toBe(true);
  // path quoted AND every % doubled; bare flags/words stay unquoted.
  expect(body).toContain('"C:\\Users\\a b\\50%%done\\agent.ps1"');
  expect(body).toContain("powershell -NoProfile -File ");
  expect(body).toContain(" auth --get");
  // no single (unescaped) % survives.
  expect(/[^%]%[^%]/.test(body)).toBe(false);
});

test("inspectClaudeWiring classifies direct / proxy / other / none / malformed (by exact path)", () => {
  const home = "/home/x/.claude";
  // Build the managed helper paths with join() + the platform basename so they match
  // inspectClaudeWiring's own path.join()/extension on every OS.
  const directHelper = join(home, DIRECT_HELPER_NAME);
  const proxyHelper = join(home, PROXY_HELPER_NAME);

  expect(
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper: directHelper }), home, 4141).providerMode,
  ).toBe("direct");
  expect(
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper: proxyHelper }), home, 4141).providerMode,
  ).toBe("proxy");

  // A foreign helper sharing our basename but elsewhere is NOT ours.
  expect(
    inspectClaudeWiring(
      JSON.stringify({ apiKeyHelper: "/opt/company/copilot-token.sh" }),
      home,
      4141,
    ).providerMode,
  ).toBe("other");
  // A custom base URL with no managed helper is also "other".
  expect(
    inspectClaudeWiring(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
      home,
      4141,
    ).providerMode,
  ).toBe("other");

  expect(inspectClaudeWiring("{}", home, 4141).providerMode).toBe("none");
  expect(inspectClaudeWiring(JSON.stringify({ model: "sonnet" }), home, 4141).providerMode).toBe(
    "none",
  );

  const absent = inspectClaudeWiring(null, home, 4141);
  expect(absent.providerMode).toBe("none");
  expect(absent.settingsExists).toBe(false);

  expect(inspectClaudeWiring("{not json", home, 4141).providerMode).toBe("other");
});

test("runClaude direct/proxy round-trip cleans the other mode", async () => {
  const home = tmpHome();
  const read = () =>
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home, 4141);

  await runClaude({ mode: "direct" });
  expect(read().providerMode).toBe("direct");
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBe("1");

  await runClaude({ mode: "proxy" });
  expect(read().providerMode).toBe("proxy");
  // Switching to proxy drops the direct-only disable-betas knob.
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBeUndefined();

  await runClaude({ mode: "direct" });
  expect(read().providerMode).toBe("direct");
});

test("detectClaudeDirect: true only when CLI+gh present, gh authed, and the probe succeeds", () => {
  const home = tmpHome();
  // detectClaudeDirect writes a throwaway direct config under a temp home; the
  // tmpHome()/COPILOT_API_HOME isolation keeps it off any real state.
  void home;
  const ok = {
    resolveCommand: (c: string) => `/bin/${c}`,
    ghAuthOk: () => true,
    runProbe: () => ({ ok: true }),
    retryDelayMs: 0,
  };
  expect(detectClaudeDirect(ok)).toBe(true);
  expect(detectClaudeDirect({ ...ok, runProbe: () => ({ ok: false }) })).toBe(false);
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

test("direct helper execs `agent auth --get` and never bakes a token, still classified direct", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(join(home, DIRECT_HELPER_NAME));
  expect(
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home, 4141).providerMode,
  ).toBe("direct");

  const script = readFileSync(join(home, DIRECT_HELPER_NAME), "utf8");
  expect(script).toContain("auth");
  expect(script).toContain("--get");
  expect(script).not.toContain("gh auth token");
});

test("runClaude with a stored token selects Direct WITHOUT baking it; --proxy still wins", async () => {
  const home = tmpHome(); // also points COPILOT_API_HOME at an isolated dir
  const read = () =>
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home, 4141);

  // A configured credential selects Direct with NO probe -- but the helper resolves
  // it at fetch time (`agent auth --get`), so it's never written to disk.
  new CopilotEnvState().set({ githubToken: "ghu_stored", authProvider: "gh-token" });
  await runClaude({ mode: "auto" });
  expect(read().providerMode).toBe("direct");
  const helper = readFileSync(join(home, DIRECT_HELPER_NAME), "utf8");
  expect(helper).not.toContain("ghu_stored");
  expect(helper).toContain("--get");

  // --proxy still wins: proxy mode (the stored token is only used by the proxy).
  await runClaude({ mode: "proxy" });
  expect(read().providerMode).toBe("proxy");
});

// --- the MCP + WebSearch-deny pair (default profile, direct wiring) -----------

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeJsonPath(), "utf8"));
}

function denyOf(doc: Record<string, unknown>): unknown {
  const permissions = doc.permissions as Record<string, unknown> | undefined;
  return permissions?.deny;
}

test("a direct default write registers the MCP server and denies the builtin WebSearch; proxy takes both back", () => {
  const home = tmpHome();

  configureClaudeConfig(home, "direct");
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
  const servers = readClaudeJson().mcpServers as Record<string, unknown>;
  expect(servers["copilot-env"]).toMatchObject({ "type": "stdio" });
  expect(new CopilotEnvState().read().webSearchDenyOwnedPaths).toEqual([
    join(home, "settings.json"),
  ]);

  // Foreign permissions entries survive; ours joins them.
  const seeded = readSettings(home);
  seeded.permissions = { allow: ["Bash"], deny: ["Foreign", WEBSEARCH_DENY_RULE] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);
  configureClaudeConfig(home, "direct");
  expect(denyOf(readSettings(home))).toEqual(["Foreign", WEBSEARCH_DENY_RULE]);
  expect((readSettings(home).permissions as Record<string, unknown>).allow).toEqual(["Bash"]);

  // The proxy write removes only OUR deny entry and the registration.
  configureClaudeConfig(home, "proxy");
  const after = readSettings(home);
  expect(denyOf(after)).toEqual(["Foreign"]);
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new CopilotEnvState().read().webSearchDenyOwnedPaths).toEqual([]);
});

test("a pre-existing user WebSearch deny is never claimed nor removed", () => {
  const home = tmpHome();
  // Seed the user's own deny BEFORE any managed write.
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ permissions: { deny: [WEBSEARCH_DENY_RULE] } }, null, 2)}\n`,
  );
  configureClaudeConfig(home, "direct");
  expect(new CopilotEnvState().read().webSearchDenyOwnedPaths).toEqual([]);

  configureClaudeConfig(home, "proxy");
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]); // user policy survives
});

test("registration failure (foreign .claude.json entry) skips the deny - never deny without a server", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    claudeJsonPath(),
    `${JSON.stringify({
      mcpServers: { "copilot-env": { "type": "stdio", "command": "npx", "args": ["other"] } },
    })}\n`,
  );
  configureClaudeConfig(home, "direct");
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new CopilotEnvState().read().webSearchDenyOwnedPaths).toEqual([]);
});

test("wire-mcp false: a direct write wires nothing and clears prior managed artifacts", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  new CopilotEnvConfig().set({ wireMcp: false });
  configureClaudeConfig(home, "direct");
  const doc = readSettings(home);
  expect(doc.permissions).toBeUndefined();
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new CopilotEnvState().read().webSearchDenyOwnedPaths).toEqual([]);
});

test("removeClaudeDefaultWiring strips our deny and deletes settings.json when emptied", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");
  // The managed keys + our deny are ALL the file holds -> uninstall removes the file.
  removeClaudeDefaultWiring(home);
  expect(existsSync(join(home, "settings.json"))).toBe(false);
  expect(new CopilotEnvState().read().webSearchDenyOwnedPaths).toEqual([]);
});

test("removeClaudeDefaultWiring keeps user keys and drops an emptied permissions object", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");
  const seeded = readSettings(home);
  seeded.model = "opus";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  removeClaudeDefaultWiring(home);
  const doc = readSettings(home);
  expect(doc.model).toBe("opus");
  expect(doc.permissions).toBeUndefined();
  expect(doc.apiKeyHelper).toBeUndefined();
});

test("syncDefaultWebSearchWiring applies the pair to existing direct wiring (the migration path)", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");
  // Simulate a pre-3.5.2 install: wiring exists but the pair does not.
  const doc = readSettings(home);
  delete doc.permissions;
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(doc, null, 2)}\n`);
  rmSync(claudeJsonPath(), { force: true });
  new CopilotEnvState().set({ webSearchDenyOwnedPaths: null });

  syncDefaultWebSearchWiring(home);
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
  expect((readClaudeJson().mcpServers as Record<string, unknown>)["copilot-env"]).toBeDefined();

  // Byte-idempotent: a second run rewrites nothing.
  const before = statSync(join(home, "settings.json")).mtimeMs;
  syncDefaultWebSearchWiring(home);
  expect(statSync(join(home, "settings.json")).mtimeMs).toBe(before);
});

test("runMcp --remove takes back the pair and stores a durable wire-mcp opt-out", async () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  await runMcp({ remove: true });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new CopilotEnvConfig().read().wireMcp).toBe(false);

  // A later direct write respects the stored opt-out.
  configureClaudeConfig(home, "direct");
  expect(denyOf(readSettings(home))).toBeUndefined();
});

test("registration failure with a PRIOR managed deny strips it - never denied without a server", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  // ~/.claude.json turns malformed (Claude Code rewrites it constantly).
  writeFileSync(claudeJsonPath(), "{ not json");
  configureClaudeConfig(home, "direct");
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new CopilotEnvState().read().webSearchDenyOwnedPaths).toEqual([]);
});

test("a malformed permissions value (non-object) is never replaced", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct");
  const seeded = readSettings(home);
  seeded.permissions = "everything";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, "direct");
  expect(readSettings(home).permissions).toBe("everything");
});

test("ownership is keyed to the settings path: a stale marker never strips another home's deny", () => {
  const home = tmpHome();
  configureClaudeConfig(home, "direct"); // marker now points at THIS home's settings.json

  // Same store, different Claude home holding the USER'S OWN deny.
  const otherHome = join(dir, ".claude-other");
  process.env.CLAUDE_CONFIG_DIR = otherHome;
  mkdirSync(otherHome, { recursive: true });
  writeFileSync(
    join(otherHome, "settings.json"),
    `${JSON.stringify({ permissions: { deny: [WEBSEARCH_DENY_RULE] } }, null, 2)}\n`,
  );
  configureClaudeConfig(otherHome, "proxy");
  expect(denyOf(readSettings(otherHome))).toEqual([WEBSEARCH_DENY_RULE]); // user policy survives
});
