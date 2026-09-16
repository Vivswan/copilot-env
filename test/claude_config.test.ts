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
  AUTH_TOKEN_ENV,
  cmdHelperBody,
  configureClaudeConfig,
  CUSTOM_HEADERS_ENV,
  detectClaudeDirect,
  directHelperCommand,
  inspectClaudeWiring,
  managedHelperShape,
  proxyHelperCommand,
  removeClaudeDefaultWiring,
  removeClaudeProfile,
  runClaude,
  syncDefaultWebSearchWiring,
  WEBSEARCH_DENY_RULE,
} from "../src/claude/config.ts";
import { claudeJsonPath } from "../src/claude/mcp_registration.ts";
import { runMcp } from "../src/commands/mcp.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { DEFAULT_COPILOT_API_BASE } from "../src/copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { copilotApiResolvePort } from "../src/copilot_api/port.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, linesNaming, writeClaudeSettings } from "./helpers.ts";

/** A scratch Direct wiring with no identity header on the generic host: today's default bytes. */
const DIRECT_NONE = { directIntegrationId: null, directBaseUrl: DEFAULT_COPILOT_API_BASE };

const WIN = process.platform === "win32";
const WORK = parseProfileName("work");
const COMMAND = { kind: "command" } as const;
const STATIC = { kind: "static", token: "ghu_baked_value" } as const;

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

// Proxy writes resolve the proxy endpoint and token, so the proxy home is isolated along with Claude's.
function tmpHome(): string {
  const homes = isolateAgentHomes("copilot-claude-");
  dir = homes.dir;
  return homes.claudeHome;
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
}

function envOf(home: string): Record<string, unknown> {
  return readSettings(home).env as Record<string, unknown>;
}

function inspectHome(home: string) {
  return inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), 4141);
}

/** The write-report lines `fn` emits (they bypass process.stderr, so they are held back and read
 *  at the flush). */
function writeReportsOf(fn: () => void): string[] {
  deferWriteReports();
  try {
    fn();
  } catch (e) {
    flushWriteReports();
    throw e;
  }
  return flushWriteReports();
}

test("direct mode writes the inline apiKeyHelper command + env, preserving user keys", () => {
  const home = tmpHome();

  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  const seeded = readSettings(home);
  seeded.model = "sonnet";
  seeded.permissions = { allow: ["Bash"] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(directHelperCommand());
  const env = doc.env as Record<string, unknown>;
  expect(env.ANTHROPIC_BASE_URL).toBe(DEFAULT_COPILOT_API_BASE);
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
  // The codex_exec User-Agent derives from the installed codex binary; the suite's live-lookup
  // seam turns the npm-latest lookup off, so here it carries FALLBACK_CODEX_UA_VERSION.
  const headers = env[CUSTOM_HEADERS_ENV] as string;
  expect(headers).toContain("Openai-Intent: conversation-edits");
  expect(headers).toMatch(/(^|\n)User-Agent: codex_exec/);
  // No probed identity passed -> no Copilot-Integration-Id line (default identity).
  expect(headers).not.toContain("Copilot-Integration-Id");
  expect(doc.model).toBe("sonnet");
  expect((doc.permissions as Record<string, unknown>).allow).toEqual(["Bash"]);

  // apiKeyHelper is an inline command invoking the resolver: never `gh auth token`, never a baked token, no helper file.
  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain(WIN ? "agent.ps1" : "bin/agent");
  expect(helperCommand).toContain("auth");
  expect(helperCommand).toContain("--get");
  expect(helperCommand).not.toContain("gh auth token");
  for (const ext of ["sh", "cmd"]) {
    expect(existsSync(join(home, `copilot-token.${ext}`))).toBe(false);
  }
});

test("direct bakes a probed Copilot-Integration-Id into ANTHROPIC_CUSTOM_HEADERS when passed", () => {
  const home = tmpHome();
  configureClaudeConfig(home, {
    mode: "direct",
    directIntegrationId: "copilot-developer-cli",
    credential: COMMAND,
  });
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
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND }); // seed, then add a user key
  const seeded = readSettings(home);
  seeded.model = "sonnet";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, { mode: "proxy", credential: COMMAND });

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(proxyHelperCommand());
  const env = doc.env as Record<string, unknown>;
  expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${copilotApiResolvePort()}`);
  // Disable-betas is a direct-only knob; switching to proxy drops it.
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
  // The editor-client headers are likewise direct-only; proxy mode scrubs them.
  expect(env[CUSTOM_HEADERS_ENV]).toBeUndefined();
  expect(doc.model).toBe("sonnet"); // unrelated user key survives

  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain(WIN ? "agent.ps1" : "bin/agent");
  expect(helperCommand).toContain("proxy-token");
  expect(helperCommand).toContain("--yes");
  for (const ext of ["sh", "cmd"]) {
    expect(existsSync(join(home, `copilot-proxy-token.${ext}`))).toBe(false);
  }
});

// --- static-key: the value rides in env, no apiKeyHelper ----------------------

test("a static direct write bakes ANTHROPIC_AUTH_TOKEN beside the direct env and drops apiKeyHelper; a command rewrite takes it back", () => {
  const home = tmpHome();
  const settingsPath = join(home, "settings.json");
  // Over an existing command wiring: the static write must DELETE the helper, not just omit it,
  // or Claude would keep running it beside the baked token. Seeded by hand: the report seam
  // names a path once per process, and the static write's line is the one under test.
  writeClaudeSettings(home, { apiKeyHelper: directHelperCommand() });

  const reports = writeReportsOf(() =>
    configureClaudeConfig(home, { mode: "direct", credential: STATIC })
  );
  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBeUndefined();
  const env = envOf(home);
  expect(env[AUTH_TOKEN_ENV]).toBe(STATIC.token);
  expect(env.ANTHROPIC_BASE_URL).toBe(DEFAULT_COPILOT_API_BASE);
  expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
  expect(env[CUSTOM_HEADERS_ENV]).toMatch(/(^|\n)User-Agent: codex_exec/);
  expect(inspectHome(home)).toMatchObject({
    providerMode: "direct",
    wired: true,
    credential: "static",
    helperPath: null,
  });
  // The report says HOW the credential rides, never what it is.
  const [line, ...rest] = linesNaming(reports.join("\n"), settingsPath);
  expect(rest).toEqual([]);
  expect(line).toContain("static key");
  expect(line).not.toContain(STATIC.token);

  // Claude prefers the variable over apiKeyHelper, so the command shape must delete it.
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(readSettings(home).apiKeyHelper).toBe(directHelperCommand());
  expect(envOf(home)[AUTH_TOKEN_ENV]).toBeUndefined();
  expect(inspectHome(home)).toMatchObject({ providerMode: "direct", credential: "command" });
});

test("a static proxy write bakes ANTHROPIC_AUTH_TOKEN under the loopback base URL and tells the user to start the proxy", () => {
  const home = tmpHome();
  const settingsPath = join(home, "settings.json");
  writeClaudeSettings(home, { apiKeyHelper: proxyHelperCommand() });

  const reports = writeReportsOf(() =>
    configureClaudeConfig(home, { mode: "proxy", credential: STATIC })
  );
  expect(readSettings(home).apiKeyHelper).toBeUndefined();
  const env = envOf(home);
  expect(env[AUTH_TOKEN_ENV]).toBe(STATIC.token);
  expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${copilotApiResolvePort()}`);
  expect(inspectHome(home)).toMatchObject({
    providerMode: "proxy",
    wired: true,
    credential: "static",
    helperPath: null,
  });
  // No resolver command runs on the agent's behalf now, so the daemon is the user's to start.
  const [line, ...rest] = linesNaming(reports.join("\n"), settingsPath);
  expect(rest).toEqual([]);
  expect(line).toContain("static key, start the proxy yourself");
  expect(line).not.toContain(STATIC.token);

  configureClaudeConfig(home, { mode: "proxy", credential: COMMAND });
  expect(readSettings(home).apiKeyHelper).toBe(proxyHelperCommand());
  expect(envOf(home)[AUTH_TOKEN_ENV]).toBeUndefined();
  expect(inspectHome(home)).toMatchObject({ providerMode: "proxy", credential: "command" });
});

test("cmdHelperBody: @echo off + CRLF, quotes paths with spaces, escapes % as %%", () => {
  // Windows paths may carry spaces and `%`; cmdHelperBody doubles every `%` so batch variable-expansion
  // cannot mangle the path. Pure, so it runs on POSIX CI.
  const body = cmdHelperBody("powershell", [
    "-NoProfile",
    "-File",
    "C:\\Users\\a b\\50%done\\agent.ps1",
    "auth",
    "--get",
  ]);
  expect(body.startsWith("@echo off\r\n")).toBe(true);
  expect(body.endsWith("\r\n")).toBe(true);
  expect(body).toContain('"C:\\Users\\a b\\50%%done\\agent.ps1"');
  expect(body).toContain("powershell -NoProfile -File ");
  expect(body).toContain(" auth --get");
  expect(/[^%]%[^%]/.test(body)).toBe(false);
});

test("inspectClaudeWiring classifies direct / proxy / other / none / malformed (by exact value)", () => {
  const home = "/home/x/.claude";
  const inspect = (text: string | null) => inspectClaudeWiring(text, 4141);

  expect(inspect(JSON.stringify({ apiKeyHelper: directHelperCommand() })).providerMode)
    .toBe("direct");
  expect(inspect(JSON.stringify({ apiKeyHelper: proxyHelperCommand() })).providerMode)
    .toBe("proxy");

  // The helper-file PATHS 3.5.6 wrote are foreign now (the 4.0.0 migration rewrites them), whatever the file holds.
  for (const name of ["copilot-token.sh", "copilot-proxy-token.sh"]) {
    const stale = inspect(JSON.stringify({ apiKeyHelper: join(home, name) }));
    expect(stale.providerMode).toBe("other");
    expect(stale.otherReason).toBe("custom");
  }

  // A foreign helper sharing our basename but elsewhere is NOT ours: "custom".
  const foreign = inspect(JSON.stringify({ apiKeyHelper: "/opt/company/copilot-token.sh" }));
  expect(foreign.providerMode).toBe("other");
  expect(foreign.otherReason).toBe("custom");
  const customBase = inspect(
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
  );
  expect(customBase.providerMode).toBe("other");
  expect(customBase.otherReason).toBe("custom");
  // A bare token is a user's own Anthropic wiring: static-managed only beside OUR env keys.
  const bareToken = inspect(JSON.stringify({ env: { [AUTH_TOKEN_ENV]: "sk-ant-users-own" } }));
  expect(bareToken.providerMode).toBe("other");
  expect(bareToken.otherReason).toBe("custom");
  expect(bareToken.wired).toBe(false);
  expect(bareToken.credential).toBe(null);

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
  const unreadable = inspectClaudeWiring({ kind: "unreadable", error: "EACCES" }, 0);
  expect(unreadable.providerMode).toBe("other");
  expect(unreadable.otherReason).toBe("read-error");
  expect(unreadable.settingsExists).toBe(true); // it EXISTS -- it just cannot be read

  const absent = inspectClaudeWiring({ kind: "absent" }, 0);
  expect(absent.providerMode).toBe("none");
  expect(absent.settingsExists).toBe(false);

  const text = inspectClaudeWiring(
    { kind: "text", text: JSON.stringify({ apiKeyHelper: directHelperCommand() }) },
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
  const read = () => inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), 4141);

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

test("detectClaudeDirect: the CLI runs the catalog's claude model and its verdict decides; gh is optional", async () => {
  const home = tmpHome();
  // detectClaudeDirect writes a throwaway direct config; tmpHome() keeps it off any real state.
  void home;
  // The catalog GET is the only fetch: with a CLI on the machine the endpoint is never pinged.
  // The pin is the CHEAPEST claude family present, not the first or the most capable.
  const urls: string[] = [];
  const fetchImpl = (input: string | URL | Request) => {
    urls.push(String(input));
    const catalog = {
      data: [{ "id": "gpt-6" }, { "id": "claude-fable-5" }, { "id": "claude-haiku-4.5" }],
    };
    return Promise.resolve(new Response(JSON.stringify(catalog), { status: 200 }));
  };
  let seenArgs: string[] | null = null;
  const ok = {
    findCommand: (c: string) => ({ path: `/bin/${c}` }),
    runProbe: (_cli: string, args: string[]) => {
      seenArgs = args;
      return { ok: true };
    },
    retryDelayMs: 0,
    fetchImpl,
  };
  expect(await detectClaudeDirect(DIRECT_NONE, "ghu_tok", ok)).toBe(true);
  expect(urls).toEqual(["https://api.githubcopilot.com/models"]);
  const args = seenArgs as unknown as string[];
  expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4.5");
  expect(
    await detectClaudeDirect(DIRECT_NONE, "ghu_tok", { ...ok, runProbe: () => ({ ok: false }) }),
  )
    .toBe(false);
  // No credential leaves nothing to smoke with: the proxy, before any call, CLI or not.
  urls.length = 0;
  let probeCalls = 0;
  const spy = { ...ok, runProbe: () => ({ ok: ++probeCalls > 0 }) };
  expect(await detectClaudeDirect(DIRECT_NONE, null, spy)).toBe(false);
  expect(
    await detectClaudeDirect(DIRECT_NONE, null, {
      ...spy,
      findCommand: (c: string) => ({ path: c === "claude" ? null : `/bin/${c}` }),
    }),
  ).toBe(false);
  expect([probeCalls, urls]).toEqual([0, []]);
  // A pasted or device-flow token needs no gh on the machine.
  expect(
    await detectClaudeDirect(DIRECT_NONE, "ghu_tok", {
      ...ok,
      findCommand: (c: string) => ({ path: c === "gh" ? null : `/bin/${c}` }),
    }),
  ).toBe(true);
});

test("detectClaudeDirect: with no claude CLI the endpoint smoke judges the credential over the wiring's own headers", async () => {
  const home = tmpHome();
  void home;
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const catalog = { data: [{ "id": "gpt-6" }, { "id": "claude-fable-5" }] };
    return Promise.resolve(
      new Response(requests.length === 1 ? JSON.stringify(catalog) : "{}", { status: 200 }),
    );
  };
  const verdict = await detectClaudeDirect(
    { ...DIRECT_NONE, directIntegrationId: "copilot-developer-cli" },
    "ghu_tok",
    {
      findCommand: (c: string) => ({ path: c === "claude" ? null : `/bin/${c}` }),
      runProbe: () => ({ ok: false }), // must never run: no CLI was found
      retryDelayMs: 0,
      fetchImpl,
    },
  );
  expect(verdict).toBe(true);
  expect(requests.length).toBe(2);
  const [catalogReq, ping] = requests as [typeof requests[0], typeof requests[0]];
  // Both requests carry the wiring's exact identity: the same credential under other headers can
  // be rejected, so a bare fetch would mint a verdict for a request Claude never sends.
  for (const r of [catalogReq, ping]) {
    expect(r.headers["Authorization"]).toBe("Bearer ghu_tok");
    expect(r.headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
  }
  expect(catalogReq.url).toBe("https://api.githubcopilot.com/models");
  expect(ping.url).toBe("https://api.githubcopilot.com/v1/messages");
  expect(ping.headers["anthropic-version"]).toBe("2023-06-01");
  // The 1-token ping on the first claude model: gpt-6 is not on Claude's wire.
  expect(ping.body).toEqual({
    "model": "claude-fable-5",
    "max_tokens": 1,
    "messages": [{ "role": "user", "content": "x" }],
  });
});

test("configureClaudeConfig refuses to overwrite a malformed settings.json", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND }); // creates the dir + a valid file
  writeFileSync(join(home, "settings.json"), "{ this is : not json");
  expect(() => configureClaudeConfig(home, { mode: "direct", credential: COMMAND })).toThrow(
    "not valid JSON",
  );
});

test("direct helper invokes `agent auth --get` and never bakes a token, still classified direct", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });

  const doc = readSettings(home);
  expect(doc.apiKeyHelper).toBe(directHelperCommand());
  expect(
    inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), 4141).providerMode,
  ).toBe("direct");

  const helperCommand = String(doc.apiKeyHelper);
  expect(helperCommand).toContain("auth");
  expect(helperCommand).toContain("--get");
  expect(helperCommand).not.toContain("gh auth token");
});

test("runClaude --direct with static-key on fails closed without a credential, and bakes a stored one", async () => {
  const home = tmpHome();
  new CopilotEnvConfig().set({ staticKey: true });

  // Nothing resolves: the write is refused outright (never a silent fall back to the command shape).
  await expect(runClaude({ kind: "configure", mode: "direct" })).rejects.toThrow(
    /static-key is on but no credential resolves[\s\S]*agent auth/,
  );
  expect(existsSync(join(home, "settings.json"))).toBe(false);

  // Control: the same preference with a stored credential writes the static shape.
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_stored",
  });
  await runClaude({ kind: "configure", mode: "direct" });
  expect(inspectHome(home)).toMatchObject({ providerMode: "direct", credential: "static" });
  expect(envOf(home)[AUTH_TOKEN_ENV]).toBe("ghu_stored");
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

  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
  const servers = readClaudeJson().mcpServers as Record<string, unknown>;
  expect(servers["copilot-env"]).toMatchObject({ "type": "stdio" });
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([
    join(home, "settings.json"),
  ]);

  const seeded = readSettings(home);
  seeded.permissions = { allow: ["Bash"], deny: ["Foreign", WEBSEARCH_DENY_RULE] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual(["Foreign", WEBSEARCH_DENY_RULE]);
  expect((readSettings(home).permissions as Record<string, unknown>).allow).toEqual(["Bash"]);

  configureClaudeConfig(home, { mode: "proxy", credential: COMMAND });
  const after = readSettings(home);
  expect(denyOf(after)).toEqual(["Foreign"]);
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

// The register-then-deny pair forbids a denied builtin with no replacement, so an unreadable
// ledger must refuse the take-back rather than read as owns-nothing.
//   read as owns-nothing  -> MCP registration stripped, deny kept (not ours to strip): torn
//   Windows, root         -> skipped: chmod 000 does not deny the read there
test.skipIf(WIN || process.getuid?.() === 0)(
  "an unreadable ownership ledger refuses the take-back instead of leaving a deny with no replacement",
  () => {
    const home = tmpHome();
    configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
    expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
    const ledgerFile = new CopilotApiPaths().ownershipFile;
    chmodSync(ledgerFile, 0o000);
    try {
      expect(() => configureClaudeConfig(home, { mode: "proxy", credential: COMMAND })).toThrow(
        ledgerFile,
      );
      expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
      expect((readClaudeJson().mcpServers as Record<string, unknown>)["copilot-env"])
        .toMatchObject({ "type": "stdio" });
    } finally {
      chmodSync(ledgerFile, 0o600);
    }
    // Control: readable again, the same take-back strips both halves.
    configureClaudeConfig(home, { mode: "proxy", credential: COMMAND });
    expect(denyOf(readSettings(home))).toBeUndefined();
    expect(readClaudeJson().mcpServers).toBeUndefined();
  },
);

test("a pre-existing user WebSearch deny is never claimed nor removed", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ permissions: { deny: [WEBSEARCH_DENY_RULE] } }, null, 2)}\n`,
  );
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);

  configureClaudeConfig(home, { mode: "proxy", credential: COMMAND });
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
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("wire-mcp false: a direct write wires nothing and clears prior managed artifacts", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  new CopilotEnvConfig().set({ wireMcp: false });
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  const doc = readSettings(home);
  expect(doc.permissions).toBeUndefined();
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("removeClaudeDefaultWiring strips our deny and deletes settings.json when emptied", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  // The managed keys + our deny are ALL the file holds -> uninstall removes the file.
  removeClaudeDefaultWiring(home);
  expect(existsSync(join(home, "settings.json"))).toBe(false);
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("removeClaudeDefaultWiring keeps user keys and drops an emptied permissions object", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  const seeded = readSettings(home);
  seeded.model = "opus";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  removeClaudeDefaultWiring(home);
  const doc = readSettings(home);
  expect(doc.model).toBe("opus");
  expect(doc.permissions).toBeUndefined();
  expect(doc.apiKeyHelper).toBeUndefined();
});

test("a command-shape NAMED write blanks the baked token so a static default cannot bleed into the profile", () => {
  // `claude --settings settings-work.json` merges env per key over settings.json, and Claude
  // prefers ANTHROPIC_AUTH_TOKEN over apiKeyHelper: a static default left visible would hand its
  // token to the profile session in place of the profile's own helper.
  const home = tmpHome();
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "proxy",
  });
  configureClaudeConfig(home, { mode: "direct", credential: STATIC });
  configureClaudeConfig(home, { mode: "proxy", profile: WORK, credential: COMMAND });
  const named = JSON.parse(readFileSync(join(home, "settings-work.json"), "utf8"));
  expect(named.apiKeyHelper).toBe(proxyHelperCommand(WORK));
  expect((named.env as Record<string, unknown>)[AUTH_TOKEN_ENV]).toBe("");
  // The default keeps its own token; only the profile's view of it is blanked.
  expect(envOf(home)[AUTH_TOKEN_ENV]).toBe(STATIC.token);
  // A static named write carries its own token over the default's.
  configureClaudeConfig(home, {
    mode: "proxy",
    profile: WORK,
    credential: { kind: "static", token: "work_key" },
  });
  const namedStatic = JSON.parse(readFileSync(join(home, "settings-work.json"), "utf8"));
  expect((namedStatic.env as Record<string, unknown>)[AUTH_TOKEN_ENV]).toBe("work_key");
  expect(namedStatic.apiKeyHelper).toBeUndefined();
});

test("removeClaudeDefaultWiring strips a static wiring's baked token with the other managed env keys", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: STATIC });
  const seeded = readSettings(home);
  seeded.model = "opus"; // a user key, so the file survives and its env can be read back
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  removeClaudeDefaultWiring(home);
  const doc = readSettings(home);
  expect(doc.model).toBe("opus");
  expect(doc.env).toBeUndefined();
  expect(JSON.stringify(doc)).not.toContain(STATIC.token);
});

test("removeClaudeDefaultWiring leaves an 'other' wiring AND the helper file it names whole", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  // A helper FILE (the shape 3.5.6 wrote, foreign now) classifies "other"; the key stays, so the
  // file it points at must stay too.
  const helper = join(home, "copilot-token.sh");
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
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND }); // deny written + ownership recorded
  const doc = readSettings(home);
  doc.apiKeyHelper = "/usr/local/bin/my-helper"; // foreign edit: classifies "other"
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(doc, null, 2)}\n`);

  // Ownership, not the classification, proves the deny is ours.
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
  // The user's own deny was never ours, so nothing OWNED remains and the caller may remove the MCP registration.
  expect(ownedDenyRemains).toBe(false);
  expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(settingsText);
});

test("removeClaudeDefaultWiring reports an owned deny it cannot strip (unverifiable file)", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND }); // deny written + ownership recorded
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
    configureClaudeConfig(home, { mode: "direct", credential: COMMAND }); // deny written + ownership recorded
    const settingsPath = join(home, "settings.json");
    const doc = readSettings(home);
    doc.apiKeyHelper = "/usr/local/bin/my-helper"; // foreign edit: classifies "other"
    writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
    chmodSync(settingsPath, 0o444);
    try {
      // The throw is contained; ownership is NOT released while the deny may still stand.
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
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  const settingsPath = join(home, "settings.json");
  rmSync(settingsPath); // the user deleted the file; the marker lingers

  const { ownedDenyRemains } = removeClaudeDefaultWiring(home);
  expect(ownedDenyRemains).toBe(false);
  expect(existsSync(settingsPath)).toBe(false); // no file resurrected
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("removeClaudeDefaultWiring tolerates a Claude home that is a file (nothing there)", () => {
  // A settings path under a file parent reads "absent" (ENOTDIR), so an uninstall over a bogus
  // CLAUDE_CONFIG_DIR finishes instead of throwing.
  const home = tmpHome();
  mkdirSync(dir, { recursive: true });
  const bogusHome = join(dir, "claude-as-file");
  writeFileSync(bogusHome, "not a directory");
  void home;
  const { ownedDenyRemains } = removeClaudeDefaultWiring(bogusHome);
  expect(ownedDenyRemains).toBe(false);
  removeClaudeProfile(bogusHome, WORK); // same absence tolerance
});

test("removeClaudeProfile removes a managed settings file but leaves an 'other' profile whole", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  const settingsPath = join(home, "settings-work.json");

  writeFileSync(
    settingsPath,
    `${JSON.stringify({ apiKeyHelper: directHelperCommand(WORK) }, null, 2)}\n`,
  );
  removeClaudeProfile(home, WORK);
  expect(existsSync(settingsPath)).toBe(false);

  writeFileSync(
    settingsPath,
    `${JSON.stringify({ apiKeyHelper: "/usr/local/bin/my-own-resolver" }, null, 2)}\n`,
  );
  removeClaudeProfile(home, WORK);
  expect(existsSync(settingsPath)).toBe(true);
});

test("an unreadable settings file is hands-off for removal, never read as unconfigured", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  // A directory at the settings path is a non-ENOENT read error on every platform: settings that exist
  // but cannot be read must not classify as "none" (removeClaudeDefaultWiring shares the reader).
  const settingsPath = join(home, "settings-work.json");
  mkdirSync(settingsPath);
  removeClaudeProfile(home, WORK);
  expect(existsSync(settingsPath)).toBe(true);
});

test("--check: absent settings exit 2 (none), unreadable settings exit 1 (other)", async () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  const before = process.exitCode;
  try {
    // Absent means unconfigured: the launcher defaults to the proxy.
    await runClaude({ kind: "check" });
    expect(process.exitCode).toBe(2);

    // A directory at the settings path: ownership we cannot verify reads "other" so the launcher does
    // not take over; it must never collapse into the absent case above.
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
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
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
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  await runMcp({ remove: true });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new CopilotEnvConfig().read().wireMcp).toBe(false);

  // A later direct write respects the stored opt-out.
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(denyOf(readSettings(home))).toBeUndefined();
});

test("registration failure with a PRIOR managed deny strips it - never denied without a server", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  // ~/.claude.json turns malformed (Claude Code rewrites it constantly).
  writeFileSync(claudeJsonPath(), "{ not json");
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("a malformed permissions value (non-object) is never replaced", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  const seeded = readSettings(home);
  seeded.permissions = "everything";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, { mode: "direct", credential: COMMAND });
  expect(readSettings(home).permissions).toBe("everything");
});

test("ownership is keyed to the settings path: a stale marker never strips another home's deny", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", credential: COMMAND }); // marker now points at THIS home's settings.json

  // Same store, different Claude home holding the USER'S OWN deny.
  const otherHome = join(dir, ".claude-other");
  process.env.CLAUDE_CONFIG_DIR = otherHome;
  mkdirSync(otherHome, { recursive: true });
  writeFileSync(
    join(otherHome, "settings.json"),
    `${JSON.stringify({ permissions: { deny: [WEBSEARCH_DENY_RULE] } }, null, 2)}\n`,
  );
  configureClaudeConfig(otherHome, { mode: "proxy", credential: COMMAND });
  expect(denyOf(readSettings(otherHome))).toEqual([WEBSEARCH_DENY_RULE]); // user policy survives
});

test("the default write reclaims a helper-path apiKeyHelper, leaving the user's file", () => {
  const home = tmpHome();
  // The shape 3.5.6 wrote (foreign now): apiKeyHelper stores a helper-script PATH.
  const helperFile = join(home, "copilot-proxy-token.sh");
  mkdirSync(home, { recursive: true });
  writeFileSync(helperFile, "#!/bin/sh\nexec old-resolver --yes\n");
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ apiKeyHelper: helperFile }, null, 2)}\n`,
  );

  configureClaudeConfig(home, { mode: "proxy", credential: COMMAND });

  // An explicit mode write reclaims even a custom default settings.json; the helper file is the user's and stays.
  expect(readSettings(home).apiKeyHelper).toBe(proxyHelperCommand());
  expect(existsSync(helperFile)).toBe(true);
});

test("classification is profile-addressed: a default-addressed command is not a profile's", () => {
  const modeFor = (apiKeyHelper: string, profile: typeof WORK | null) =>
    inspectClaudeWiring(JSON.stringify({ apiKeyHelper }), 0, profile).providerMode;

  // A default-addressed inline command is NOT a named profile's resolver (and vice versa).
  expect(modeFor(directHelperCommand(), null)).toBe("direct");
  expect(modeFor(directHelperCommand(), WORK)).toBe("other");
  expect(modeFor(directHelperCommand(WORK), WORK)).toBe("direct");
  expect(modeFor(directHelperCommand(WORK), null)).toBe("other");
});

test("--check: the helper-file path 3.5.6 wrote exits 1 (other), even with the file present", async () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  const helperFile = join(home, "copilot-token.sh");
  writeFileSync(helperFile, "#!/bin/sh\nexec '/r/bin/agent' 'auth' '--get'\n");
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ apiKeyHelper: helperFile }, null, 2)}\n`,
  );
  const before = process.exitCode;
  try {
    // The `cl` launcher gates on this exit code: a path is never the managed command.
    await runClaude({ kind: "check" });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = before ?? 0;
  }
});

test("mode inspection recognizes the managed helper from ANY copilot-env root", () => {
  // A dev checkout and ~/.copilot-env spell different roots into apiKeyHelper; both resolve the same
  // shared store, so inspection reads both as managed.
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
  // A bare -File path is not a spelling the writer can produce: a real agent.ps1 path carries \ and :,
  // which winQuote always quotes.
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
  // A Windows path cannot carry a line break, so a value smuggling one inside the quotes is not managed.
  expect(
    managedHelperShape(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\x\r\nevil\\bin\\agent.ps1" auth --get',
      ["auth", "--get"],
      true,
    ),
  ).toBe(false);
  // Raw % IS a spelling the inline writer produces: helperCommandLine does no %%-doubling because
  // the inline command is not a batch file.
  expect(
    managedHelperShape(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\50%done\\bin\\agent.ps1" auth --get',
      ["auth", "--get"],
      true,
    ),
  ).toBe(true);
});

test("inspectClaudeWiring reads a sibling root's wiring as its real mode, not other", () => {
  // The writer emits and the inspector recognizes only the current platform's shape, so the fixture follows it.
  const helper = (args: string) =>
    process.platform === "win32"
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\other\\checkout\\bin\\agent.ps1" ${args}`
      : `/some/other/checkout/bin/agent ${args}`;
  const text = JSON.stringify({
    apiKeyHelper: helper("auth --get"),
    env: { ANTHROPIC_BASE_URL: "https://api.githubcopilot.com" },
  });
  expect(inspectClaudeWiring(text, 4141).providerMode).toBe("direct");
  const proxyText = JSON.stringify({
    apiKeyHelper: helper("proxy-token --yes"),
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4141" },
  });
  expect(inspectClaudeWiring(proxyText, 4141).providerMode).toBe("proxy");
});
