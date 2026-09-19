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
import { directWiring } from "../src/agents/configure.ts";
import {
  AUTH_TOKEN_ENV,
  CLAUDE_HAIKU_ALIAS,
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
  syncDefaultWebSearch,
  WEBSEARCH_DENY_RULE,
} from "../src/claude/config.ts";
import { runClaude } from "../src/agents/configure_defaults.ts";
import { claudeJsonPath } from "../src/claude/mcp_registration.ts";
import { resolveClaudeHome } from "../src/claude/paths.ts";
import { runMcp } from "../src/commands/mcp.ts";
import { probeModelPin } from "../src/copilot_api/endpoint_smoke.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { copilotApiResolvePort } from "../src/copilot_api/port.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { captureChannels } from "./helpers/output.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, linesNaming, writeClaudeSettings } from "./helpers.ts";

/** A recorded Direct default whose slot holds its pair, so a single-agent write is a re-render
 *  (zero probes, no credential needed); with no pair it would land both agents and ask to log in. */
function directDefault(): void {
  const state = new CopilotEnvState();
  state.recordDefaultMode("direct");
  state.setProfileDirectPair(null, { integrationId: null, host: DEFAULT_COPILOT_API_BASE });
}

/** A scratch Direct wiring with no identity header on the generic host: today's default bytes. */
const DIRECT_NONE = directWiring(null, DEFAULT_COPILOT_API_BASE);

const WIN = process.platform === "win32";
const WORK = parseProfileName("work");
const COMMAND = { kind: "command" } as const;
const STATIC = { kind: "static", token: "ghu_baked_value" } as const;

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  setIntegrationProbeFetch(null);
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

  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  const seeded = readSettings(home);
  seeded.model = "sonnet";
  seeded.permissions = { allow: ["Bash"] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });

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
    direct: directWiring("copilot-developer-cli", DEFAULT_COPILOT_API_BASE),
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
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND }); // seed, then add a user key
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

test("a static write bakes ANTHROPIC_AUTH_TOKEN under the mode's base URL and drops apiKeyHelper; a command rewrite takes it back", () => {
  type Write = Parameters<typeof configureClaudeConfig>[1];
  // `env` is resolved per row AFTER its isolation: the proxy port reads the isolated store.
  const rows: {
    mode: "direct" | "proxy";
    write: Write;
    command: Write;
    helper: string;
    env: () => Record<string, unknown>;
    report: string;
  }[] = [
    {
      mode: "direct",
      write: { mode: "direct", direct: null, credential: STATIC },
      command: { mode: "direct", direct: null, credential: COMMAND },
      helper: directHelperCommand(),
      env: () => ({
        ANTHROPIC_BASE_URL: DEFAULT_COPILOT_API_BASE,
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
        [CUSTOM_HEADERS_ENV]: expect.stringMatching(/(^|\n)User-Agent: codex_exec/),
      }),
      report: "static key",
    },
    {
      // No resolver command runs on the agent's behalf now, so the daemon is the user's to start.
      mode: "proxy",
      write: { mode: "proxy", credential: STATIC },
      command: { mode: "proxy", credential: COMMAND },
      helper: proxyHelperCommand(),
      env: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${copilotApiResolvePort()}` }),
      report: "static key, start the proxy yourself",
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    const home = tmpHome();
    const settingsPath = join(home, "settings.json");
    // Over an existing command wiring: the static write must DELETE the helper, not just omit it,
    // or Claude would keep running it beside the baked token. Seeded by hand: the report seam
    // names a path once per process, and the static write's line is the one under test.
    writeClaudeSettings(home, { apiKeyHelper: row.helper });

    const reports = writeReportsOf(() => configureClaudeConfig(home, row.write));
    expect(readSettings(home).apiKeyHelper, row.mode).toBeUndefined();
    expect(envOf(home), row.mode).toMatchObject({ [AUTH_TOKEN_ENV]: STATIC.token, ...row.env() });
    expect(inspectHome(home), row.mode).toMatchObject({
      providerMode: row.mode,
      wired: true,
      credential: "static",
      helperPath: null,
    });
    // The report says HOW the credential rides, never what it is.
    const [line, ...rest] = linesNaming(reports.join("\n"), settingsPath);
    expect(rest, row.mode).toEqual([]);
    expect(line, row.mode).toContain(row.report);
    expect(line, row.mode).not.toContain(STATIC.token);

    // Claude prefers the variable over apiKeyHelper, so the command shape must delete it.
    configureClaudeConfig(home, row.command);
    expect(readSettings(home).apiKeyHelper, row.mode).toBe(row.helper);
    expect(envOf(home)[AUTH_TOKEN_ENV], row.mode).toBeUndefined();
    expect(inspectHome(home), row.mode).toMatchObject({
      providerMode: row.mode,
      credential: "command",
    });
  }
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

/** The writer emits and the inspector recognizes only the current platform's shape, so a sibling
 *  root's helper follows it. */
function siblingRootHelper(args: string): string {
  return WIN
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\other\\checkout\\bin\\agent.ps1" ${args}`
    : `/some/other/checkout/bin/agent ${args}`;
}

test("inspectClaudeWiring classifies by exact value: direct / proxy / other / none / malformed / unreadable, from any root, profile-addressed", () => {
  const home = "/home/user/.claude";
  const direct = JSON.stringify({ apiKeyHelper: directHelperCommand() });
  const rows: {
    name: string;
    input: Parameters<typeof inspectClaudeWiring>[0];
    profile?: typeof WORK | null;
    expect: Partial<ReturnType<typeof inspectClaudeWiring>>;
  }[] = [
    // The reason travels ONLY on the "other" arm; `wired` is minted by the owner, alongside the
    // mode -- never re-derived.
    {
      name: "the managed direct command",
      input: direct,
      expect: { providerMode: "direct", otherReason: null, wired: true },
    },
    {
      name: "the managed proxy command",
      input: JSON.stringify({ apiKeyHelper: proxyHelperCommand() }),
      expect: { providerMode: "proxy" },
    },
    // The helper-file PATHS 3.5.6 wrote are foreign now (the 4.0.0 migration rewrites them),
    // whatever the file holds; a foreign helper sharing our basename but elsewhere is NOT ours.
    ...["copilot-token.sh", "copilot-proxy-token.sh"].map((name) => ({
      name: `the stale helper path ${name}`,
      input: JSON.stringify({ apiKeyHelper: join(home, name) }),
      expect: { providerMode: "other" as const, otherReason: "custom" as const },
    })),
    {
      name: "a foreign helper sharing our basename",
      input: JSON.stringify({ apiKeyHelper: "/opt/company/copilot-token.sh" }),
      expect: { providerMode: "other", otherReason: "custom" },
    },
    {
      name: "a custom base URL",
      input: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example" } }),
      expect: { providerMode: "other", otherReason: "custom" },
    },
    // A bare token is a user's own Anthropic wiring: static-managed only beside OUR env keys.
    {
      name: "a bare token",
      input: JSON.stringify({ env: { [AUTH_TOKEN_ENV]: "sk-ant-users-own" } }),
      expect: { providerMode: "other", otherReason: "custom", wired: false, credential: null },
    },
    { name: "an empty document", input: "{}", expect: { providerMode: "none", otherReason: null } },
    {
      name: "user keys only",
      input: JSON.stringify({ model: "sonnet" }),
      expect: { providerMode: "none" },
    },
    {
      name: "no file",
      input: null,
      expect: { providerMode: "none", settingsExists: false, otherReason: null },
    },
    {
      name: "malformed JSON",
      input: "{not json",
      expect: { providerMode: "other", otherReason: "malformed" },
    },
    // Unreadable EXISTS -- it just cannot be read: other/read-error, never none.
    {
      name: "an unreadable file",
      input: { kind: "unreadable", error: "EACCES" },
      expect: {
        providerMode: "other",
        otherReason: "read-error",
        settingsExists: true,
        wired: false,
      },
    },
    {
      name: "an absent read result",
      input: { kind: "absent" },
      expect: { providerMode: "none", settingsExists: false, wired: false },
    },
    {
      name: "a text read result",
      input: { kind: "text", text: direct },
      expect: { providerMode: "direct", otherReason: null, wired: true },
    },
    // A dev checkout and ~/.copilot-env spell different roots into apiKeyHelper; both resolve the
    // same shared store, so a sibling root's wiring reads as its real mode, not other.
    {
      name: "a sibling root's direct wiring",
      input: JSON.stringify({
        apiKeyHelper: siblingRootHelper("auth --get"),
        env: { ANTHROPIC_BASE_URL: "https://api.githubcopilot.com" },
      }),
      expect: { providerMode: "direct" },
    },
    {
      name: "a sibling root's proxy wiring",
      input: JSON.stringify({
        apiKeyHelper: siblingRootHelper("profile proxy-token --yes"),
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4141" },
      }),
      expect: { providerMode: "proxy" },
    },
    // Profile-addressed: a default-addressed inline command is NOT a named profile's resolver
    // (and vice versa).
    {
      name: "the default command read for the default",
      input: direct,
      profile: null,
      expect: { providerMode: "direct" },
    },
    {
      name: "the default command read for a profile",
      input: direct,
      profile: WORK,
      expect: { providerMode: "other" },
    },
    {
      name: "the profile command read for the profile",
      input: JSON.stringify({ apiKeyHelper: directHelperCommand(WORK) }),
      profile: WORK,
      expect: { providerMode: "direct" },
    },
    {
      name: "the profile command read for the default",
      input: JSON.stringify({ apiKeyHelper: directHelperCommand(WORK) }),
      profile: null,
      expect: { providerMode: "other" },
    },
  ];
  for (const row of rows) {
    expect(inspectClaudeWiring(row.input, 4141, row.profile ?? null), row.name).toMatchObject(
      row.expect,
    );
  }
});

test("runClaude direct/proxy round-trip cleans the other mode", async () => {
  const home = tmpHome();
  const read = () => inspectClaudeWiring(readFileSync(join(home, "settings.json"), "utf8"), 4141);

  // A single-agent write re-renders the recorded mode; the record itself is `agent init`'s.
  directDefault();
  await runClaude({ kind: "configure", mode: "direct" });
  expect(read().providerMode).toBe("direct");
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBe("1");

  new CopilotEnvState().recordDefaultMode("proxy");
  await runClaude({ kind: "configure", mode: "proxy" });
  expect(read().providerMode).toBe("proxy");
  // Switching to proxy drops the direct-only disable-betas knob.
  expect(
    (readSettings(home).env as Record<string, unknown>).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
  ).toBeUndefined();

  directDefault();
  await runClaude({ kind: "configure", mode: "direct" });
  expect(read().providerMode).toBe("direct");
});

test("detectClaudeDirect: the CLI runs the catalog's claude model and its verdict decides; gh is optional", async () => {
  const home = tmpHome();
  // detectClaudeDirect writes a throwaway direct config; tmpHome() keeps it off any real state.
  void home;
  // With a CLI on the machine the endpoint is never pinged, and the first hop is the CLI's own
  // haiku alias (never a Copilot id the CLI would send an effort field for), so nothing is
  // fetched at all: a catalog that answers 503 cannot keep the alias from running.
  const urls: string[] = [];
  const fetchImpl = (input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(new Response("unavailable", { status: 503 }));
  };
  let seenArgs: string[] | null = null;
  const ok = {
    findCommand: (c: string) => ({ path: `/bin/${c}` }),
    runProbe: (_cli: string, args: string[]) => {
      seenArgs = args;
      return { ok: true };
    },
    fetchImpl,
  };
  const pinnedModel = () => {
    const args = seenArgs as unknown as string[];
    return args[args.indexOf("--model") + 1];
  };
  expect(await detectClaudeDirect(DIRECT_NONE, "ghu_tok", ok)).toBe(true);
  expect([urls, pinnedModel()]).toEqual([[], CLAUDE_HAIKU_ALIAS]);
  expect(
    await detectClaudeDirect(DIRECT_NONE, "ghu_tok", { ...ok, runProbe: () => ({ ok: false }) }),
  )
    .toBe(false);
  // A set probe.claude-model is the model the smoke runs, as-is: no alias, no catalog fetch. The
  // key is profile-default, so a profile's own value wins over the global one for a probe run
  // for that profile.
  new CopilotEnvConfig().set({ "probe.claude-model": "claude-sonnet-5" });
  urls.length = 0;
  expect(await detectClaudeDirect(DIRECT_NONE, "ghu_tok", ok)).toBe(true);
  expect([urls, pinnedModel()]).toEqual([[], "claude-sonnet-5"]);
  const work = parseProfileName("work");
  new CopilotEnvConfig().setProfile(work, { "probe.claude-model": "claude-opus-5" });
  expect([probeModelPin("probe.claude-model", work), probeModelPin("probe.claude-model", null)])
    .toEqual(["claude-opus-5", "claude-sonnet-5"]);
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
    directWiring("copilot-developer-cli", DEFAULT_COPILOT_API_BASE),
    "ghu_tok",
    {
      findCommand: (c: string) => ({ path: c === "claude" ? null : `/bin/${c}` }),
      runProbe: () => ({ ok: false }), // must never run: no CLI was found
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

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a malformed ~/.claude.json is warned about before settings.json is written: the warning prints even when that write fails",
  async () => {
    // The proxy write takes the MCP registration back after the settings save; its look at the
    // file (and the warning a malformed one earns) comes before the save, as every look does. An
    // unwritable settings.json (0444, POSIX non-root) fails the save, and the warning has printed.
    const home = tmpHome();
    mkdirSync(home, { recursive: true });
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, "{}\n");
    writeFileSync(claudeJsonPath(), "{ not json");
    chmodSync(settingsPath, 0o444);
    try {
      const { stderr } = await captureChannels(() => {
        expect(() => configureClaudeConfig(home, { mode: "proxy", credential: COMMAND })).toThrow(
          /EACCES/,
        );
      });
      expect(stderr).toContain("not valid JSON; leaving it alone");
      expect(readFileSync(settingsPath, "utf8")).toBe("{}\n");
      expect(readFileSync(claudeJsonPath(), "utf8")).toBe("{ not json");
    } finally {
      chmodSync(settingsPath, 0o644);
    }
  },
);

test("a Claude home that cannot be made leaves ~/.claude.json untouched: the Direct registration follows the mkdir", async () => {
  // A regular file where the Claude home should be fails the mkdir; the MCP registration the
  // Direct write lands is written only once the home exists, so ~/.claude.json keeps its bytes.
  // With no CLAUDE_CONFIG_DIR the registration file sits in $HOME itself, beside the bogus home.
  const home = tmpHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(home, "not a directory");
  writeFileSync(claudeJsonPath(), "{}\n");
  const { stderr } = await captureChannels(() => {
    expect(() =>
      configureClaudeConfig(resolveClaudeHome(), {
        mode: "direct",
        direct: null,
        credential: COMMAND,
      })
    ).toThrow("could not create Claude config directory");
  });
  expect(readFileSync(claudeJsonPath(), "utf8")).toBe("{}\n");
  expect(stderr).not.toContain("MCP registration failed");
});

test("configureClaudeConfig refuses to overwrite a malformed settings.json", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND }); // creates the dir + a valid file
  writeFileSync(join(home, "settings.json"), "{ this is : not json");
  expect(() => configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND }))
    .toThrow(
      "not valid JSON",
    );
});

test("runClaude --direct with static-key covering Claude fails closed without a credential, before any probe, and bakes a stored one", async () => {
  const home = tmpHome();
  new CopilotEnvConfig().setProfile(null, { "static-key": "claude" });
  directDefault(); // the mode this re-render bakes
  // Hermetic: the landing below probes Copilot for the identity and host. Nothing here may reach
  // the real service (a fake token would draw real 401s online and an accidental pass offline).
  let probes = 0;
  setIntegrationProbeFetch(() => {
    probes++;
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });

  // Nothing resolves: the write is refused outright (never a silent fall back to the command shape),
  // and refused BEFORE any probe: a selection made without a credential would bake the fallback pair.
  await expect(runClaude({ kind: "configure", mode: "direct" })).rejects.toThrow(
    /static-key is claude but no credential resolves[\s\S]*agent auth/,
  );
  expect(existsSync(join(home, "settings.json"))).toBe(false);
  expect(probes).toBe(0);

  // Control: the same preference with a stored credential writes the static shape. The credential
  // write took the stored pair with it, so this re-render is the landing that probes it again.
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_stored",
  });
  await runClaude({ kind: "configure", mode: "direct" });
  expect(probes).toBeGreaterThan(0);
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

  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
  const servers = readClaudeJson().mcpServers as Record<string, unknown>;
  expect(servers["copilot-env"]).toMatchObject({ "type": "stdio" });
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([
    join(home, "settings.json"),
  ]);

  const seeded = readSettings(home);
  seeded.permissions = { allow: ["Bash"], deny: ["Foreign", WEBSEARCH_DENY_RULE] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
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
    configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
    expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
    const ledgerFile = new CopilotApiPaths().stateStoreFile;
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
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);

  configureClaudeConfig(home, { mode: "proxy", credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]); // user policy survives
});

test("registration failure skips a fresh deny and strips a PRIOR managed one - never denied without a server", () => {
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  // A foreign .claude.json entry under our name: the registration fails, so no deny is written.
  writeFileSync(
    claudeJsonPath(),
    `${
      JSON.stringify({
        mcpServers: { "copilot-env": { "type": "stdio", "command": "npx", "args": ["other"] } },
      })
    }\n`,
  );
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);

  // The foreign entry gone, the same write registers and denies.
  rmSync(claudeJsonPath());
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  // ~/.claude.json turns malformed (Claude Code rewrites it constantly): the prior deny goes.
  writeFileSync(claudeJsonPath(), "{ not json");
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("wire-mcp false: a direct write wires nothing and clears prior managed artifacts", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  new CopilotEnvConfig().set({ "claude.wire-mcp": false });
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  const doc = readSettings(home);
  expect(doc.permissions).toBeUndefined();
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);
});

test("removeClaudeDefaultWiring strips every managed key (command or static) and our deny, keeps user keys, and deletes an emptied settings.json", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  // The managed keys + our deny are ALL the file holds -> uninstall removes the file.
  removeClaudeDefaultWiring(home);
  expect(existsSync(join(home, "settings.json"))).toBe(false);
  expect(new OwnershipLedger().ownedPaths("webSearchDeny")).toEqual([]);

  // A user key keeps the file: the managed keys go, and the emptied permissions object with them.
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  const seeded = readSettings(home);
  seeded.model = "opus";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);
  removeClaudeDefaultWiring(home);
  const doc = readSettings(home);
  expect(doc.model).toBe("opus");
  expect(doc.permissions).toBeUndefined();
  expect(doc.apiKeyHelper).toBeUndefined();

  // A static wiring's baked token leaves with the other managed env keys (the user key still
  // holds the file, so its env can be read back).
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: STATIC });
  removeClaudeDefaultWiring(home);
  const afterStatic = readSettings(home);
  expect(afterStatic.model).toBe("opus");
  expect(afterStatic.env).toBeUndefined();
  expect(JSON.stringify(afterStatic)).not.toContain(STATIC.token);
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
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: STATIC });
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

// Ownership, not the classification, proves a deny is ours to strip; a deny that may still stand
// keeps its claim.
test("removeClaudeDefaultWiring over a foreign-edited, foreign, unverifiable, or vanished config strips only an owned deny it can verify and reports one it cannot", () => {
  const FOREIGN_HELPER = "/usr/local/bin/my-helper";
  const FOREIGN_TEXT = `${
    JSON.stringify(
      { apiKeyHelper: FOREIGN_HELPER, permissions: { deny: [WEBSEARCH_DENY_RULE] } },
      null,
      2,
    )
  }\n`;
  const rows: {
    name: string;
    arrange: (home: string, settingsPath: string) => void;
    ownedDenyRemains: boolean;
    owned: boolean;
    after: (home: string, settingsPath: string, name: string) => void;
  }[] = [
    {
      name: "an OWNED deny in a foreign-edited config is stripped, the edit kept",
      arrange: (home, settingsPath) => {
        configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
        const doc = readSettings(home);
        doc.apiKeyHelper = FOREIGN_HELPER; // foreign edit: classifies "other"
        writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
      },
      ownedDenyRemains: false,
      owned: false,
      after: (home, _settingsPath, name) => {
        const after = readSettings(home);
        expect(denyOf(after), name).toBeUndefined();
        expect(after.apiKeyHelper, name).toBe(FOREIGN_HELPER);
      },
    },
    {
      // The user's own deny was never ours, so nothing OWNED remains and the caller may remove
      // the MCP registration.
      name: "a deny never ours in a foreign config stays byte for byte",
      arrange: (home, settingsPath) => {
        mkdirSync(home, { recursive: true });
        writeFileSync(settingsPath, FOREIGN_TEXT);
      },
      ownedDenyRemains: false,
      owned: false,
      after: (_home, settingsPath, name) =>
        expect(readFileSync(settingsPath, "utf8"), name).toBe(FOREIGN_TEXT),
    },
    {
      name: "an owned deny in an unverifiable file is reported and left untouched",
      arrange: (home, settingsPath) => {
        configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
        writeFileSync(settingsPath, "{ not json"); // the deny is now unverifiable
      },
      ownedDenyRemains: true,
      owned: true,
      after: (_home, settingsPath, name) =>
        expect(readFileSync(settingsPath, "utf8"), name).toBe("{ not json"),
    },
    {
      name: "a vanished file releases its stale marker, resurrecting nothing",
      arrange: (home, settingsPath) => {
        configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
        rmSync(settingsPath); // the user deleted the file; the marker lingers
      },
      ownedDenyRemains: false,
      owned: false,
      after: (_home, settingsPath, name) => expect(existsSync(settingsPath), name).toBe(false),
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    const home = tmpHome();
    const settingsPath = join(home, "settings.json");
    row.arrange(home, settingsPath);
    const { ownedDenyRemains } = removeClaudeDefaultWiring(home);
    expect(ownedDenyRemains, row.name).toBe(row.ownedDenyRemains);
    expect(new OwnershipLedger().ownedPaths("webSearchDeny"), row.name).toEqual(
      row.owned ? [settingsPath] : [],
    );
    row.after(home, settingsPath, row.name);
  }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an UNWRITABLE foreign config keeps its owned deny (reported), never aborts the removal",
  () => {
    // POSIX, non-root only: 0444 blocks the rewrite (root bypasses file modes).
    const home = tmpHome();
    configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND }); // deny written + ownership recorded
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

test("removeClaudeProfile removes a managed settings file, leaves an 'other' profile whole, and is hands-off on an unreadable one", () => {
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

  // A directory at the settings path is a non-ENOENT read error on every platform: settings that
  // exist but cannot be read must never read as unconfigured (removeClaudeDefaultWiring shares
  // the reader).
  rmSync(settingsPath);
  mkdirSync(settingsPath);
  removeClaudeProfile(home, WORK);
  expect(existsSync(settingsPath)).toBe(true);
});

test("--check: absent settings exit 2 (none); unreadable settings and the helper-file path 3.5.6 wrote exit 1 (other)", async () => {
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

    // The helper-file path 3.5.6 wrote, the file present: the `cl` launcher gates on this exit
    // code, and a path is never the managed command.
    process.exitCode = 0;
    rmSync(join(home, "settings.json"), { recursive: true });
    const helperFile = join(home, "copilot-token.sh");
    writeFileSync(helperFile, "#!/bin/sh\nexec '/r/bin/agent' 'auth' '--get'\n");
    writeFileSync(
      join(home, "settings.json"),
      `${JSON.stringify({ apiKeyHelper: helperFile }, null, 2)}\n`,
    );
    await runClaude({ kind: "check" });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = before ?? 0;
  }
});

test("syncDefaultWebSearch applies the pair to existing direct wiring (the migration path)", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  directDefault(); // what the `agent profile sync --claude` command records
  // Simulate a pre-3.5.2 install: wiring exists but the pair does not.
  const doc = readSettings(home);
  delete doc.permissions;
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(doc, null, 2)}\n`);
  rmSync(claudeJsonPath(), { force: true });
  new OwnershipLedger().release("webSearchDeny", join(home, "settings.json"));

  syncDefaultWebSearch(home);
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
  expect((readClaudeJson().mcpServers as Record<string, unknown>)["copilot-env"]).toBeDefined();

  // Byte-idempotent: a second run rewrites nothing.
  const before = statSync(join(home, "settings.json")).mtimeMs;
  syncDefaultWebSearch(home);
  expect(statSync(join(home, "settings.json")).mtimeMs).toBe(before);
});

// The ledger, not the record, decides whether we strip what we wrote: a deny claimed in the ledger
// with the default's mode gone (a record cleared after the wiring) is still ours to take back.
test("syncDefaultWebSearch strips a claimed deny with no recorded mode; a foreign deny stays", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
  expect(new CopilotEnvState().readProfileSlot(null).mode).toBeNull();
  syncDefaultWebSearch(home);
  expect(denyOf(readSettings(home))).toBeUndefined(); // the emptied permissions key goes too
  expect(new OwnershipLedger().owns("webSearchDeny", join(home, "settings.json"))).toBe(false);
  // Control: the same deny the user wrote (no claim) is left alone.
  const doc = readSettings(home);
  doc.permissions = { deny: [WEBSEARCH_DENY_RULE] };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(doc, null, 2)}\n`);
  syncDefaultWebSearch(home);
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);
});

test("runMcp --remove takes back the pair and stores a durable wire-mcp opt-out", async () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  directDefault();
  expect(denyOf(readSettings(home))).toEqual([WEBSEARCH_DENY_RULE]);

  await runMcp({ remove: true });
  expect(denyOf(readSettings(home))).toBeUndefined();
  expect(readClaudeJson().mcpServers).toBeUndefined();
  expect(new CopilotEnvConfig().read().global["claude.wire-mcp"]).toBe(false);

  // A later direct write respects the stored opt-out.
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(denyOf(readSettings(home))).toBeUndefined();
});

test("a malformed permissions value (non-object) is never replaced", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  const seeded = readSettings(home);
  seeded.permissions = "everything";
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`);

  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  expect(readSettings(home).permissions).toBe("everything");
});

test("ownership is keyed to the settings path: a stale marker never strips another home's deny", () => {
  const home = tmpHome();
  configureClaudeConfig(home, { mode: "direct", direct: null, credential: COMMAND }); // marker now points at THIS home's settings.json

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

test("mode inspection recognizes the managed helper from ANY copilot-env root", () => {
  // A dev checkout and ~/.copilot-env spell different roots into apiKeyHelper; both resolve the same
  // shared store, so inspection reads both as managed.
  const posixDirect = [
    "/opt/somewhere/bin/agent auth --get",
    "'/with space/bin/agent' auth --get",
  ];
  for (const value of posixDirect) {
    expect(managedHelperShape(value, ["auth", "--get"], false)).toBe(true);
  }
  expect(
    managedHelperShape(
      "/opt/x/bin/agent profile proxy-token --yes",
      ["profile", "proxy-token", "--yes"],
      false,
    ),
  )
    .toBe(true);
  expect(
    managedHelperShape(
      "/opt/x/bin/agent profile work auth --get",
      ["profile", "work", "auth", "--get"],
      false,
    ),
  ).toBe(true);
  // Negatives: wrong binary name, trailing junk, foreign command, wrong profile args.
  expect(
    managedHelperShape(
      "/opt/x/bin/agent-evil auth --get",
      ["auth", "--get"],
      false,
    ),
  ).toBe(
    false,
  );
  expect(
    managedHelperShape(
      "/opt/x/bin/agent auth --get --extra",
      ["auth", "--get"],
      false,
    ),
  ).toBe(
    false,
  );
  expect(managedHelperShape("gh auth token", ["auth", "--get"], false)).toBe(false);
  // Shell metacharacters can never classify as managed: only shToken's bare charset
  // (or a fully quoted path) is a spelling the writer can produce.
  expect(
    managedHelperShape("evil;/bin/agent auth --get", ["auth", "--get"], false),
  ).toBe(false);
  expect(
    managedHelperShape("$(evil)/bin/agent auth --get", ["auth", "--get"], false),
  ).toBe(false);
  expect(
    managedHelperShape("a b/bin/agent auth --get", ["auth", "--get"], false),
  ).toBe(false);
  expect(
    managedHelperShape(
      "/opt/x/bin/agent auth --get",
      ["profile", "w", "auth", "--get"],
      false,
    ),
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
