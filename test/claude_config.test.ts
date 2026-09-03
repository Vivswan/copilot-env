import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cmdHelperBody,
  configureClaudeConfig,
  CUSTOM_HEADERS_ENV,
  detectClaudeDirect,
  DIRECT_BASE_URL,
  directHelperCommand,
  inspectClaudeWiring,
  legacyDirectHelperBodyMatches,
  legacyDirectHelperScript,
  legacyProxyHelperBodyMatches,
  legacyProxyHelperScript,
  managedHelperShape,
  proxyHelperCommand,
  removeClaudeDefaultWiring,
  removeClaudeProfile,
  runClaude,
  syncDefaultWebSearchWiring,
  WEBSEARCH_DENY_RULE,
} from "../src/claude/config.ts";
import { claudeJsonPath } from "../src/claude/mcp_registration.ts";
import { DIRECT_HELPER_NAME, directHelperPath, PROXY_HELPER_NAME } from "../src/claude/paths.ts";
import { runMcp } from "../src/commands/mcp.ts";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { copilotApiResolvePort } from "../src/copilot_api/port.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, removeDir } from "./helpers.ts";

const WIN = process.platform === "win32";
const WORK = parseProfileName("work");

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

test("direct mode writes the inline apiKeyHelper command + env, preserving user keys", () => {
  const home = tmpHome();

  configureClaudeConfig(home, { mode: "direct" });
  const seeded = readSettings(home);
  seeded.model = "sonnet";
  seeded.permissions = { allow: ["Bash"] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, { mode: "direct" });

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(directHelperCommand());
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

  // apiKeyHelper is an inline COMMAND invoking `agent auth --get` (the resolver) --
  // never `gh auth token`, never a baked token, and NO helper file is written.
  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain(WIN ? "agent.ps1" : "bin/agent");
  expect(helperCommand).toContain("auth");
  expect(helperCommand).toContain("--get");
  expect(helperCommand).not.toContain("gh auth token");
  expect(existsSync(join(home, DIRECT_HELPER_NAME))).toBe(false);
});

test("direct bakes a probed Copilot-Integration-Id into ANTHROPIC_CUSTOM_HEADERS when passed", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", directIntegrationId: "copilot-developer-cli" });
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
  configureClaudeConfig(home, { mode: "direct" }); // seed, then add a user key
  const seeded = readSettings(home);
  seeded.model = "sonnet";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, { mode: "proxy" });

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(proxyHelperCommand());
  const env = doc.env as Record<string, unknown>;
  expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${copilotApiResolvePort()}`);
  // Disable-betas is a direct-only knob; switching to proxy drops it.
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
  // The editor-client headers are likewise direct-only; proxy mode scrubs them.
  expect(env[CUSTOM_HEADERS_ENV]).toBeUndefined();
  expect(doc.model).toBe("sonnet"); // unrelated user key survives

  // The inline command runs the resolver subcommand (`agent proxy-token --yes`); no
  // literal token is baked in, and NO helper file is written.
  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain(WIN ? "agent.ps1" : "bin/agent");
  expect(helperCommand).toContain("proxy-token");
  expect(helperCommand).toContain("--yes");
  expect(existsSync(join(home, PROXY_HELPER_NAME))).toBe(false);
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

test("inspectClaudeWiring classifies direct / proxy / other / none / malformed (by exact value)", () => {
  const home = "/home/x/.claude";
  const files = new Map<string, string>();
  let reads = 0;
  const readFile = (path: string): string | null => {
    reads++;
    return files.get(path) ?? null;
  };
  const inspect = (text: string | null) => inspectClaudeWiring(text, home, 4141, null, readFile);

  // The managed contract: the exact inline command strings -- classified without
  // ever touching a file (the reader is for the legacy path arms alone).
  expect(inspect(JSON.stringify({ apiKeyHelper: directHelperCommand() })).providerMode)
    .toBe("direct");
  expect(inspect(JSON.stringify({ apiKeyHelper: proxyHelperCommand() })).providerMode)
    .toBe("proxy");
  expect(reads).toBe(0);

  // Reader tolerance: the retired helper-script PATHS (what pre-inline releases
  // stored) classify as managed ONLY while the file body is one a RELEASE actually
  // wrote -- from ANY install root. Fixtures are byte literals lifted from tag
  // history, with only the install root substituted (a DIFFERENT root than this
  // checkout, so root-agnostic matching is what passes):
  //   git show v3.5.6:src/claude/config.ts  -> directHelperScript / proxyHelperScript
  //   git show v3.3.17:src/claude/config.ts -> proxyHelperScript (bare `--yes` era)
  // NOT rebuilt from today's primitives, so a primitive drift cannot silently move
  // fixture and classifier together (that drift is exactly how a never-released
  // `agent proxy-token` body once passed here as the released one). Paths are built
  // with join() + the platform basename so they match inspectClaudeWiring's own
  // path.join()/extension on every OS.
  const directHelper = join(home, DIRECT_HELPER_NAME);
  const proxyHelper = join(home, PROXY_HELPER_NAME);
  const direct356 = WIN
    ? '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\other root\\bin\\agent.ps1" auth --get\r\n'
    : "#!/bin/sh\nexec '/other root/bin/agent' 'auth' '--get'\n";
  const proxy356 = WIN
    ? '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\other root\\src\\scripts\\proxy-token.ps1" --yes\r\n'
    : "#!/bin/sh\nexec '/other root/src/scripts/proxy-token.sh' '--yes'\n";
  // v3.3.x POSIX spelled `--yes` bare; its WIN rendering equals the v3.5.x one.
  const proxy3317 = WIN
    ? proxy356
    : "#!/bin/sh\nexec '/other root/src/scripts/proxy-token.sh' --yes\n";
  // Unreleased mains briefly wrote the proxy body through the launcher.
  const proxyMain = WIN
    ? '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\other root\\bin\\agent.ps1" proxy-token --yes\r\n'
    : "#!/bin/sh\nexec '/other root/bin/agent' 'proxy-token' '--yes'\n";

  files.set(directHelper, direct356);
  for (const proxyBody of [proxy356, proxy3317, proxyMain]) {
    files.set(proxyHelper, proxyBody);
    expect(inspect(JSON.stringify({ apiKeyHelper: directHelper })).providerMode).toBe("direct");
    expect(inspect(JSON.stringify({ apiKeyHelper: proxyHelper })).providerMode).toBe("proxy");
  }
  // The exported fixture renderers (the v3.5.6 spellings at the CURRENT root)
  // classify through the same arms.
  files.set(directHelper, legacyDirectHelperScript());
  files.set(proxyHelper, legacyProxyHelperScript());
  expect(inspect(JSON.stringify({ apiKeyHelper: directHelper })).providerMode).toBe("direct");
  expect(inspect(JSON.stringify({ apiKeyHelper: proxyHelper })).providerMode).toBe("proxy");

  // A legacy path whose file is MISSING cannot produce the managed credential: not
  // ours -- and the reason names the legacy arm, so consumers (the health warn)
  // never re-derive the path comparison.
  files.clear();
  const missingDirect = inspect(JSON.stringify({ apiKeyHelper: directHelper }));
  expect(missingDirect.providerMode).toBe("other");
  expect(missingDirect.otherReason).toBe("legacy-unrecognized");
  const missingProxy = inspect(JSON.stringify({ apiKeyHelper: proxyHelper }));
  expect(missingProxy.providerMode).toBe("other");
  expect(missingProxy.otherReason).toBe("legacy-unrecognized");
  // ...nor is a foreign/hand-edited body at the right path (a bare gh helper, say)...
  files.set(directHelper, "#!/bin/sh\nexec gh auth token\n");
  expect(inspect(JSON.stringify({ apiKeyHelper: directHelper })).providerMode).toBe("other");
  // ...and each path accepts only ITS bodies: the proxy body at the direct path is foreign.
  files.set(directHelper, proxy356);
  expect(inspect(JSON.stringify({ apiKeyHelper: directHelper })).providerMode).toBe("other");

  // A foreign helper sharing our basename but elsewhere is NOT ours: "custom".
  const foreign = inspect(JSON.stringify({ apiKeyHelper: "/opt/company/copilot-token.sh" }));
  expect(foreign.providerMode).toBe("other");
  expect(foreign.otherReason).toBe("custom");
  // A custom base URL with no managed helper is also "other"/"custom".
  const customBase = inspect(
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
  );
  expect(customBase.providerMode).toBe("other");
  expect(customBase.otherReason).toBe("custom");

  expect(inspect("{}").providerMode).toBe("none");
  expect(inspect(JSON.stringify({ model: "sonnet" })).providerMode).toBe("none");
  // The reason travels ONLY on the "other" arm.
  expect(inspect(JSON.stringify({ apiKeyHelper: directHelperCommand() })).otherReason).toBe(null);
  expect(inspect("{}").otherReason).toBe(null);

  const absent = inspect(null);
  expect(absent.providerMode).toBe("none");
  expect(absent.settingsExists).toBe(false);
  expect(absent.otherReason).toBe(null);

  const malformed = inspect("{not json");
  expect(malformed.providerMode).toBe("other");
  expect(malformed.otherReason).toBe("malformed");
});

test("inspectClaudeWiring takes a TextReadResult: unreadable is other/read-error, never none", () => {
  const home = "/home/x/.claude";
  const unreadable = inspectClaudeWiring({ kind: "unreadable", error: "EACCES" }, home, 0);
  expect(unreadable.providerMode).toBe("other");
  expect(unreadable.otherReason).toBe("read-error");
  expect(unreadable.settingsExists).toBe(true); // it EXISTS -- it just cannot be read

  const absent = inspectClaudeWiring({ kind: "absent" }, home, 0);
  expect(absent.providerMode).toBe("none");
  expect(absent.settingsExists).toBe(false);

  const text = inspectClaudeWiring(
    { kind: "text", text: JSON.stringify({ apiKeyHelper: directHelperCommand() }) },
    home,
    0,
  );
  expect(text.providerMode).toBe("direct");
  expect(text.otherReason).toBe(null);
  // `wired` is minted by the owner, alongside the mode -- never re-derived.
  expect(text.wired).toBe(true);
  expect(unreadable.wired).toBe(false);
  expect(absent.wired).toBe(false);
});

test("runClaude direct/proxy round-trip cleans the other mode", async () => {
  const home = tmpHome();
  const read = () =>
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home, 4141);

  await runClaude({ kind: "configure", mode: "direct" });
  expect(read().providerMode).toBe("direct");
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBe("1");

  await runClaude({ kind: "configure", mode: "proxy" });
  expect(read().providerMode).toBe("proxy");
  // Switching to proxy drops the direct-only disable-betas knob.
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBeUndefined();

  await runClaude({ kind: "configure", mode: "direct" });
  expect(read().providerMode).toBe("direct");
});

test("detectClaudeDirect: true only when CLI+gh present, gh authed, and the probe succeeds", () => {
  const home = tmpHome();
  // detectClaudeDirect writes a throwaway direct config under a temp home; the
  // tmpHome()/COPILOT_API_HOME isolation keeps it off any real state.
  void home;
  const ok = {
    findCommand: (c: string) => ({ path: `/bin/${c}` }),
    ghAuthOk: () => true as const,
    runProbe: () => ({ ok: true }),
    retryDelayMs: 0,
  };
  expect(detectClaudeDirect(ok)).toBe(true);
  expect(detectClaudeDirect({ ...ok, runProbe: () => ({ ok: false }) })).toBe(false);
  expect(detectClaudeDirect({ ...ok, ghAuthOk: () => false })).toBe(false);
  expect(
    detectClaudeDirect({
      ...ok,
      findCommand: (c: string) => ({ path: c === "claude" ? null : `/bin/${c}` }),
    }),
  ).toBe(false);
  expect(
    detectClaudeDirect({
      ...ok,
      findCommand: (c: string) => ({ path: c === "gh" ? null : `/bin/${c}` }),
    }),
  ).toBe(false);
});

test("configureClaudeConfig refuses to overwrite a malformed settings.json", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" }); // creates the dir + a valid file
  writeFileSync(join(home, "settings.json"), "{ this is : not json");
  expect(() => configureClaudeConfig(home, { mode: "direct" })).toThrow("not valid JSON");
});

test("direct helper invokes `agent auth --get` and never bakes a token, still classified direct", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(directHelperCommand());
  expect(
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home, 4141).providerMode,
  ).toBe("direct");

  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain("auth");
  expect(helperCommand).toContain("--get");
  expect(helperCommand).not.toContain("gh auth token");
});

test("runClaude with a stored token selects Direct WITHOUT baking it; --proxy still wins", async () => {
  const home = tmpHome(); // also points COPILOT_API_HOME at an isolated dir
  const read = () =>
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), home, 4141);

  // A configured credential selects Direct with NO probe -- but the inline helper
  // resolves it at fetch time (`agent auth --get`), so it's never written anywhere.
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_stored",
  });
  await runClaude({ kind: "configure", mode: "auto" });
  expect(read().providerMode).toBe("direct");
  const helperCommand = String(readSettings(home).apiKeyHelper);
  expect(helperCommand).not.toContain("ghu_stored");
  expect(helperCommand).toContain("--get");

  // --proxy still wins: proxy mode (the stored token is only used by the proxy).
  await runClaude({ kind: "configure", mode: "proxy" });
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

  configureClaudeConfig(home, { mode: "direct" });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
  const servers = readClaudeJson().mcpServers as Record<string, unknown>;
  expect(servers["copilot-env"]).toMatchObject({ "type": "stdio" });
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([
    join(home, "settings.json"),
  ]);

  // Foreign permissions entries survive; ours joins them.
  const seeded = readSettings(home);
  seeded.permissions = { allow: ["Bash"], deny: ["Foreign", WEBSEARCH_DENY_RULE] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);
  configureClaudeConfig(home, { mode: "direct" });
  expect(denyOf(readSettings(home))).toEqual(["Foreign", WEBSEARCH_DENY_RULE]);
  expect((readSettings(home).permissions as Record<string, unknown>).allow).toEqual(["Bash"]);

  // The proxy write removes only OUR deny entry and the registration.
  configureClaudeConfig(home, { mode: "proxy" });
  const after = readSettings(home);
  expect(denyOf(after)).toEqual(["Foreign"]);
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("a pre-existing user WebSearch deny is never claimed nor removed", () => {
  const home = tmpHome();
  // Seed the user's own deny BEFORE any managed write.
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ permissions: { deny: [WEBSEARCH_DENY_RULE] } }, null, 2)}\n`,
  );
  configureClaudeConfig(home, { mode: "direct" });
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);

  configureClaudeConfig(home, { mode: "proxy" });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]); // user policy survives
});

test("registration failure (foreign .claude.json entry) skips the deny - never deny without a server", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    claudeJsonPath(),
    `${
      JSON.stringify({
        mcpServers: { "copilot-env": { "type": "stdio", "command": "npx", "args": ["other"] } },
      })
    }\n`,
  );
  configureClaudeConfig(home, { mode: "direct" });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("wire-mcp false: a direct write wires nothing and clears prior managed artifacts", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  new CopilotEnvConfig().set({ wireMcp: false });
  configureClaudeConfig(home, { mode: "direct" });
  const doc = readSettings(home);
  expect(doc.permissions).toBeUndefined();
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("removeClaudeDefaultWiring strips our deny and deletes settings.json when emptied", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });
  // The managed keys + our deny are ALL the file holds -> uninstall removes the file.
  removeClaudeDefaultWiring(home);
  expect(existsSync(join(home, "settings.json"))).toBe(false);
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("removeClaudeDefaultWiring keeps user keys and drops an emptied permissions object", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });
  const seeded = readSettings(home);
  seeded.model = "opus";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  removeClaudeDefaultWiring(home);
  const doc = readSettings(home);
  expect(doc.model).toBe("opus");
  expect(doc.permissions).toBeUndefined();
  expect(doc.apiKeyHelper).toBeUndefined();
});

test("removeClaudeDefaultWiring leaves an 'other' wiring AND its legacy-named helper whole", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  // A user-owned helper AT our legacy name classifies "other" (foreign body): the
  // settings key stays, so the file it points at must stay too -- deleting only
  // the file would leave the wiring dangling.
  const helper = join(home, DIRECT_HELPER_NAME);
  writeFileSync(helper, "#!/bin/sh\nexec my-own-resolver\n");
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ apiKeyHelper: helper }, null, 2)}\n`,
  );

  removeClaudeDefaultWiring(home);
  expect(existsSync(helper)).toBe(true);
  expect(readSettings(home).apiKeyHelper).toBe(helper);
});

test("removeClaudeDefaultWiring strips an OWNED deny from a foreign-edited config", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" }); // deny written + ownership recorded
  const doc = readSettings(home);
  doc.apiKeyHelper = "/usr/local/bin/my-helper"; // foreign edit: classifies "other"
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(doc, null, 2)}\n`);

  // Ownership is the proof the deny is ours, independent of the classification:
  // exactly it goes, the foreign wiring stays, and nothing owned remains.
  const { ownedDenyRemains } = removeClaudeDefaultWiring(home);
  expect(ownedDenyRemains).toBe(false);
  const after = readSettings(home);
  expect(denyOf(after)).toBeUndefined();
  expect(after.apiKeyHelper).toBe("/usr/local/bin/my-helper");
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("removeClaudeDefaultWiring never strips a deny it does not own from a foreign config", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  const settingsText = `${
    JSON.stringify(
      {
        apiKeyHelper: "/usr/local/bin/my-helper",
        permissions: { deny: [WEBSEARCH_DENY_RULE] },
      },
      null,
      2,
    )
  }\n`;
  writeFileSync(join(home, "settings.json"), settingsText);

  const { ownedDenyRemains } = removeClaudeDefaultWiring(home);
  // The user's own deny stands (it was never ours), but nothing OWNED remains
  // either, so the caller is free to remove the MCP registration.
  expect(ownedDenyRemains).toBe(false);
  expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(settingsText);
});

test("removeClaudeDefaultWiring reports an owned deny it cannot strip (unverifiable file)", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" }); // deny written + ownership recorded
  const settingsPath = join(home, "settings.json");
  writeFileSync(settingsPath, "{ not json"); // the deny is now unverifiable

  const { ownedDenyRemains } = removeClaudeDefaultWiring(home);
  expect(ownedDenyRemains).toBe(true);
  expect(readFileSync(settingsPath, "utf8")).toBe("{ not json"); // untouched
  expect(new OwnershipLedger().owns("webSearchDeny", settingsPath)).toBe(true);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an UNWRITABLE foreign config keeps its owned deny (reported), never aborts the removal",
  () => {
    // POSIX, non-root only: 0444 blocks the rewrite (root bypasses file modes).
    const home = tmpHome();
    configureClaudeConfig(home, { mode: "direct" }); // deny written + ownership recorded
    const settingsPath = join(home, "settings.json");
    const doc = readSettings(home);
    doc.apiKeyHelper = "/usr/local/bin/my-helper"; // foreign edit: classifies "other"
    writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
    chmodSync(settingsPath, 0o444);
    try {
      // The deny-only write fails; the throw is contained (best-effort), the deny
      // stays in the file, and ownership is NOT released while it may still stand.
      const { ownedDenyRemains } = removeClaudeDefaultWiring(home);
      expect(ownedDenyRemains).toBe(true);
      expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
      expect(new OwnershipLedger().owns("webSearchDeny", settingsPath)).toBe(true);
    } finally {
      chmodSync(settingsPath, 0o644);
    }
  },
);

test("removeClaudeDefaultWiring releases a stale ownership marker for a vanished file", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });
  const settingsPath = join(home, "settings.json");
  rmSync(settingsPath); // the user deleted the file; the marker lingers

  const { ownedDenyRemains } = removeClaudeDefaultWiring(home);
  expect(ownedDenyRemains).toBe(false);
  expect(existsSync(settingsPath)).toBe(false); // no file resurrected
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("removeClaudeDefaultWiring tolerates a Claude home that is a file (nothing there)", () => {
  // A settings path under a non-directory parent reads "absent" (ENOTDIR), and
  // the loader and the legacy-helper removal must agree -- an uninstall or
  // profile delete over a bogus CLAUDE_CONFIG_DIR must finish, not throw.
  const home = tmpHome();
  mkdirSync(dir, { recursive: true });
  const bogusHome = join(dir, "claude-as-file");
  writeFileSync(bogusHome, "not a directory");
  void home;
  const { ownedDenyRemains } = removeClaudeDefaultWiring(bogusHome);
  expect(ownedDenyRemains).toBe(false);
  removeClaudeProfile(bogusHome, WORK); // same absence tolerance
});

test("removeClaudeProfile removes managed artifacts but leaves an 'other' profile whole", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  const helper = directHelperPath(home, WORK);
  const settingsPath = join(home, "settings-work.json");

  // Managed legacy wiring (a released body at WORK's path): both artifacts go.
  writeFileSync(helper, legacyDirectHelperScript(WORK));
  writeFileSync(settingsPath, `${JSON.stringify({ apiKeyHelper: helper }, null, 2)}\n`);
  removeClaudeProfile(home, WORK);
  expect(existsSync(settingsPath)).toBe(false);
  expect(existsSync(helper)).toBe(false);

  // A foreign body at the same name classifies "other": both artifacts stay.
  writeFileSync(helper, "#!/bin/sh\nexec my-own-resolver\n");
  writeFileSync(settingsPath, `${JSON.stringify({ apiKeyHelper: helper }, null, 2)}\n`);
  removeClaudeProfile(home, WORK);
  expect(existsSync(settingsPath)).toBe(true);
  expect(existsSync(helper)).toBe(true);

  // Unconfigured ("none"): no wiring points at the legacy names, so files there
  // are removed by name (orphan cleanup, the historical contract).
  rmSync(settingsPath);
  removeClaudeProfile(home, WORK);
  expect(existsSync(helper)).toBe(false);
});

test("an unreadable settings file is hands-off for removal, never read as unconfigured", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  const helper = directHelperPath(home, WORK);
  writeFileSync(helper, "#!/bin/sh\nexec my-own-resolver\n");
  // A directory at the settings path forces a non-ENOENT read error on every
  // platform: the settings EXIST but cannot be read, so they may still point at
  // the helper -- that must not classify as "none" and authorize file removal
  // (removeClaudeDefaultWiring shares the same reader).
  mkdirSync(join(home, "settings-work.json"));
  removeClaudeProfile(home, WORK);
  expect(existsSync(helper)).toBe(true);
});

test("--check: absent settings exit 2 (none), unreadable settings exit 1 (other)", async () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  const before = process.exitCode;
  try {
    // Absent: unconfigured -- the launcher defaults to the proxy (exit 2).
    await runClaude({ kind: "check" });
    expect(process.exitCode).toBe(2);

    // A directory at the settings path (a non-ENOENT read error on every
    // platform): the settings EXIST but cannot be read -- ownership we cannot
    // verify must read "other" (exit 1: the launcher must not take over), never
    // collapse into the absent case above.
    process.exitCode = 0;
    mkdirSync(join(home, "settings.json"));
    await runClaude({ kind: "check" });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = before ?? 0;
  }
});

test("syncDefaultWebSearchWiring applies the pair to existing direct wiring (the migration path)", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });
  // Simulate a pre-3.5.2 install: wiring exists but the pair does not.
  const doc = readSettings(home);
  delete doc.permissions;
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(doc, null, 2)}\n`);
  rmSync(claudeJsonPath(), { force: true });
  new OwnershipLedger().release("webSearchDeny", join(home, "settings.json"));

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
  configureClaudeConfig(home, { mode: "direct" });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  await runMcp({ remove: true });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new CopilotEnvConfig().read().wireMcp).toBe(false);

  // A later direct write respects the stored opt-out.
  configureClaudeConfig(home, { mode: "direct" });
  expect(denyOf(readSettings(home))).toBeUndefined();
});

test("registration failure with a PRIOR managed deny strips it - never denied without a server", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  // ~/.claude.json turns malformed (Claude Code rewrites it constantly).
  writeFileSync(claudeJsonPath(), "{ not json");
  configureClaudeConfig(home, { mode: "direct" });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("a malformed permissions value (non-object) is never replaced", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });
  const seeded = readSettings(home);
  seeded.permissions = "everything";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, { mode: "direct" });
  expect(readSettings(home).permissions).toBe("everything");
});

test("a pre-ledger install's legacy deny record still authorizes the take-back", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" });
  const settingsPath = join(home, "settings.json");

  // Rewind the record to the pre-ledger layout: ownership under the LEGACY
  // state-store key, no ledger file (an install that never ran the migration).
  const paths = new CopilotApiPaths();
  rmSync(paths.ownershipFile, { force: true });
  new CopilotApiConfig(paths.sharedStateFile).update((d) => {
    d.webSearchDenyOwnedPaths = [settingsPath];
  });

  // The proxy write still recognizes the deny as ours, strips it, and clears
  // the legacy record so it can never claim a future user-added deny.
  configureClaudeConfig(home, { mode: "proxy" });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new OwnershipLedger().owns("webSearchDeny", settingsPath)).toBe(false);
  const raw = JSON.parse(readFileSync(paths.sharedStateFile, "utf8")) as Record<string, unknown>;
  expect(raw.webSearchDenyOwnedPaths).toBeUndefined();
});

test("ownership is keyed to the settings path: a stale marker never strips another home's deny", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct" }); // marker now points at THIS home's settings.json

  // Same store, different Claude home holding the USER'S OWN deny.
  const otherHome = join(dir, ".claude-other");
  process.env.CLAUDE_CONFIG_DIR = otherHome;
  mkdirSync(otherHome, { recursive: true });
  writeFileSync(
    join(otherHome, "settings.json"),
    `${JSON.stringify({ permissions: { deny: [WEBSEARCH_DENY_RULE] } }, null, 2)}\n`,
  );
  configureClaudeConfig(otherHome, { mode: "proxy" });
  expect(denyOf(readSettings(otherHome))).toEqual([WEBSEARCH_DENY_RULE]); // user policy survives
});

// --- reader tolerance: the retired helper-file wiring ---------------------------

test("a rewrite upgrades legacy helper-path wiring to the inline command, leaving the file", () => {
  const home = tmpHome();
  // A pre-inline install: apiKeyHelper stores the helper-script PATH and the file exists.
  const legacyHelper = join(home, PROXY_HELPER_NAME);
  mkdirSync(home, { recursive: true });
  writeFileSync(legacyHelper, "#!/bin/sh\nexec old-resolver --yes\n");
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ apiKeyHelper: legacyHelper }, null, 2)}\n`,
  );

  configureClaudeConfig(home, { mode: "proxy" });

  // Upgraded in place; the orphaned legacy file is left alone (uninstall removes it).
  expect(readSettings(home).apiKeyHelper).toBe(proxyHelperCommand());
  expect(existsSync(legacyHelper)).toBe(true);
});

test("classification is profile-addressed: inline commands, legacy bodies, and every impostor", () => {
  const home = "/home/x/.claude";
  const files = new Map<string, string>();
  const readFile = (path: string): string | null => files.get(path) ?? null;
  const modeFor = (apiKeyHelper: string, profile: typeof WORK | null) =>
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper }), home, 0, profile, readFile).providerMode;

  // A default-addressed inline command is NOT a named profile's resolver (and vice versa).
  expect(modeFor(directHelperCommand(), null)).toBe("direct");
  expect(modeFor(directHelperCommand(), WORK)).toBe("other");
  expect(modeFor(directHelperCommand(WORK), WORK)).toBe("direct");
  expect(modeFor(directHelperCommand(WORK), null)).toBe("other");

  // The legacy arm derives the profile's OWN path and body: WORK's body at WORK's
  // path classifies for WORK...
  const defaultPath = join(home, DIRECT_HELPER_NAME);
  const workPath = directHelperPath(home, WORK);
  files.set(defaultPath, legacyDirectHelperScript());
  files.set(workPath, legacyDirectHelperScript(WORK));
  expect(modeFor(workPath, WORK)).toBe("direct");
  expect(modeFor(defaultPath, null)).toBe("direct");
  // ...but the default helper never satisfies the WORK inspection (nor the reverse),
  // and a mis-addressed body at the right path is an impostor.
  expect(modeFor(defaultPath, WORK)).toBe("other");
  expect(modeFor(workPath, null)).toBe("other");
  files.set(workPath, legacyDirectHelperScript());
  expect(modeFor(workPath, WORK)).toBe("other");
});

test("legacy body matchers pin every released rendering, root-agnostic, both platforms", () => {
  // `win` is explicit here so both platform shapes run on every CI runner (the
  // classifier test above exercises the ambient platform through the path arms).
  const direct = (body: string | null, win: boolean) =>
    legacyDirectHelperBodyMatches(body, null, win);
  const proxy = (body: string | null, win: boolean) =>
    legacyProxyHelperBodyMatches(body, null, win);

  // Direct: the one released rendering (v3.5.6 == v3.3.17), any root -- spaces stay
  // inside the shQuote'd token / the -File double quotes.
  expect(direct("#!/bin/sh\nexec '/some root/bin/agent' 'auth' '--get'\n", false)).toBe(true);
  expect(direct(
    '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\some root\\bin\\agent.ps1" auth --get\r\n',
    true,
  )).toBe(true);
  // Profile addressing is part of the rendering.
  const workDirect = "#!/bin/sh\nexec '/r/bin/agent' 'auth' '--get' '--profile' 'work'\n";
  expect(legacyDirectHelperBodyMatches(workDirect, WORK, false)).toBe(true);
  expect(legacyDirectHelperBodyMatches(workDirect, null, false)).toBe(false);

  // Proxy: v3.5.x quoted forwarder, v3.3.x bare `--yes` (default profile only --
  // that era predates named profiles), and unreleased mains' launcher spelling.
  expect(proxy("#!/bin/sh\nexec '/r/src/scripts/proxy-token.sh' '--yes'\n", false)).toBe(true);
  expect(proxy("#!/bin/sh\nexec '/r/src/scripts/proxy-token.sh' --yes\n", false)).toBe(true);
  expect(proxy("#!/bin/sh\nexec '/r/bin/agent' 'proxy-token' '--yes'\n", false)).toBe(true);
  expect(proxy(
    '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\r\\src\\scripts\\proxy-token.ps1" --yes\r\n',
    true,
  )).toBe(true);
  expect(
    legacyProxyHelperBodyMatches(
      "#!/bin/sh\nexec '/r/src/scripts/proxy-token.sh' '--yes' '--profile' 'work'\n",
      WORK,
      false,
    ),
  ).toBe(true);
  expect(
    legacyProxyHelperBodyMatches(
      "#!/bin/sh\nexec '/r/src/scripts/proxy-token.sh' --yes\n",
      WORK,
      false,
    ),
  ).toBe(false);

  // Impostors: trailing shell, a missing exec frame, a foreign resolver, no body.
  expect(proxy("#!/bin/sh\nexec '/r/src/scripts/proxy-token.sh' '--yes' ; evil\n", false))
    .toBe(false);
  expect(proxy("exec '/r/src/scripts/proxy-token.sh' '--yes'\n", false)).toBe(false);
  expect(direct("#!/bin/sh\nexec gh auth token\n", false)).toBe(false);
  expect(direct(null, false)).toBe(false);
  expect(proxy(null, true)).toBe(false);
  // cmd.exe parses per line -- a CRLF inside the apparent quoted -File path IS a
  // second command -- and the released .cmd writers %%-doubled every literal `%`,
  // so raw `%` is equally foreign; the doubling the writers emitted stays accepted.
  expect(direct(
    '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\r\r\nevil.exe\r\nrem \\bin\\agent.ps1" auth --get\r\n',
    true,
  )).toBe(false);
  expect(direct(
    '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\%TEMP%\\bin\\agent.ps1" auth --get\r\n',
    true,
  )).toBe(false);
  expect(proxy(
    '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\r\r\nevil\\src\\scripts\\proxy-token.ps1" --yes\r\n',
    true,
  )).toBe(false);
  expect(direct(
    '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\50%%done\\bin\\agent.ps1" auth --get\r\n',
    true,
  )).toBe(true);

  // The exported fixture renderers satisfy their matchers on the ambient platform.
  expect(legacyDirectHelperBodyMatches(legacyDirectHelperScript())).toBe(true);
  expect(legacyProxyHelperBodyMatches(legacyProxyHelperScript())).toBe(true);
  expect(legacyDirectHelperBodyMatches(legacyDirectHelperScript(WORK), WORK)).toBe(true);
  expect(legacyProxyHelperBodyMatches(legacyProxyHelperScript(WORK), WORK)).toBe(true);
});

test("--check reads the legacy helper body: missing/foreign exits 1, the exact body exits 0", async () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  const legacyPath = join(home, DIRECT_HELPER_NAME);
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ apiKeyHelper: legacyPath }, null, 2)}\n`,
  );
  const before = process.exitCode;
  try {
    // The helper file is missing: the path alone must not read as ours -- the `cl`
    // launcher gates on this exit code, and a helper that cannot produce a
    // credential must fail it.
    await runClaude({ kind: "check" });
    expect(process.exitCode).toBe(1);

    // A foreign body at the right path is equally not ours.
    process.exitCode = 0;
    writeFileSync(legacyPath, "#!/bin/sh\nexec gh auth token\n");
    await runClaude({ kind: "check" });
    expect(process.exitCode).toBe(1);

    // The exact pre-inline body: a genuine legacy install still checks green.
    writeFileSync(legacyPath, legacyDirectHelperScript());
    process.exitCode = 0;
    await runClaude({ kind: "check" });
    expect(process.exitCode).toBe(0);
  } finally {
    process.exitCode = before ?? 0;
  }
});

test("mode inspection recognizes the managed helper from ANY copilot-env root", () => {
  // A dev checkout and ~/.copilot-env spell different roots into apiKeyHelper; both
  // resolve the same shared store, so inspection must read both as managed. Shapes
  // are platform-parameterized so both run on every CI runner.
  const posixDirect = ["/opt/somewhere/bin/agent auth --get", "'/with space/bin/agent' auth --get"];
  for (const value of posixDirect) {
    expect(managedHelperShape(value, ["auth", "--get"], false)).toBe(true);
  }
  expect(managedHelperShape("/opt/x/bin/agent proxy-token --yes", ["proxy-token", "--yes"], false))
    .toBe(true);
  expect(
    managedHelperShape(
      "/opt/x/bin/agent auth --get --profile work",
      ["auth", "--get", "--profile", "work"],
      false,
    ),
  ).toBe(true);
  // Negatives: wrong binary name, trailing junk, foreign command, wrong profile args.
  expect(managedHelperShape("/opt/x/bin/agent-evil auth --get", ["auth", "--get"], false)).toBe(
    false,
  );
  expect(managedHelperShape("/opt/x/bin/agent auth --get --extra", ["auth", "--get"], false)).toBe(
    false,
  );
  expect(managedHelperShape("gh auth token", ["auth", "--get"], false)).toBe(false);
  // Shell metacharacters can never classify as managed: only shToken's bare charset
  // (or a fully quoted path) is a spelling the writer can produce.
  expect(managedHelperShape("evil;/bin/agent auth --get", ["auth", "--get"], false)).toBe(false);
  expect(managedHelperShape("$(evil)/bin/agent auth --get", ["auth", "--get"], false)).toBe(false);
  expect(managedHelperShape("a b/bin/agent auth --get", ["auth", "--get"], false)).toBe(false);
  expect(
    managedHelperShape("/opt/x/bin/agent auth --get", ["auth", "--get", "--profile", "w"], false),
  ).toBe(false);
  // Windows shape: only the QUOTED -File path spelling is managed.
  expect(
    managedHelperShape(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Some Dir\\bin\\agent.ps1" auth --get',
      ["auth", "--get"],
      true,
    ),
  ).toBe(true);
  // A bare (unquoted) -File path is NOT a spelling the writer can produce (a real
  // agent.ps1 path carries \ and :, which winQuote always quotes): never managed.
  expect(
    managedHelperShape(
      "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\x\\bin\\agent.ps1 auth --get",
      ["auth", "--get"],
      true,
    ),
  ).toBe(false);
  expect(
    managedHelperShape(
      "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\x\\bin\\evil.ps1 auth --get",
      ["auth", "--get"],
      true,
    ),
  ).toBe(false);
  // The quoted -File path never spans a line break (a Windows path cannot carry
  // one; a value smuggling a second line inside the quotes is not managed)...
  expect(
    managedHelperShape(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\x\r\nevil\\bin\\agent.ps1" auth --get',
      ["auth", "--get"],
      true,
    ),
  ).toBe(false);
  // ...but raw % IS a spelling the inline writer produces (helperCommandLine does
  // no %%-doubling -- the inline command is not a batch file, unlike the legacy
  // .cmd bodies): a root containing % keeps classifying.
  expect(
    managedHelperShape(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\50%done\\bin\\agent.ps1" auth --get',
      ["auth", "--get"],
      true,
    ),
  ).toBe(true);
});

test("inspectClaudeWiring reads a sibling root's wiring as its real mode, not other", () => {
  // Platform-native helper spelling: the writer only ever emits (and the inspector
  // only ever recognizes) the current platform's shape, so the fixture follows it.
  const helper = (args: string) =>
    process.platform === "win32"
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\other\\checkout\\bin\\agent.ps1" ${args}`
      : `/some/other/checkout/bin/agent ${args}`;
  const text = JSON.stringify({
    apiKeyHelper: helper("auth --get"),
    env: { ANTHROPIC_BASE_URL: "https://api.githubcopilot.com" },
  });
  expect(inspectClaudeWiring(text, "/tmp/claude-home", 4141).providerMode).toBe("direct");
  const proxyText = JSON.stringify({
    apiKeyHelper: helper("proxy-token --yes"),
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4141" },
  });
  expect(inspectClaudeWiring(proxyText, "/tmp/claude-home", 4141).providerMode).toBe("proxy");
});
