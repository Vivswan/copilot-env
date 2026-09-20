import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { directWiring } from "../src/agents/configure.ts";
import { parse, stringify } from "smol-toml";
import { CATALOG_PATCH_VERSION } from "../src/codex/catalog.ts";
import {
  refreshCodexCatalogAndSync,
  syncCodexCatalogReference,
} from "../src/codex/catalog_reference.ts";
import { configureCodexConfig, detectCodexDirect } from "../src/codex/config.ts";
import { inspectCodexWiring } from "../src/codex/inspect.ts";
import { runCodex } from "../src/agents/configure_defaults.ts";
import { CI_NO_LIVE_LOOKUPS_ENV, FALLBACK_CODEX_UA_VERSION } from "../src/codex/user_agent.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { DEFAULT_COPILOT_API_BASE } from "../src/copilot_api/integration_identity.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { runDryRun } from "../src/commands/dry_run.ts";
import { type FakeCodex, fakeCodexOnPath, type FakeCodexProbe } from "./helpers/fake_codex.ts";
import { captureChannels, captureChannelsSync } from "./helpers/output.ts";
import { agentLauncherCommand, proxyTokenCommand } from "../src/utils/root.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes } from "./helpers/env.ts";
import { linesNaming } from "./helpers/dry_run.ts";
import { codexConfigToml } from "./helpers/fixtures.ts";

/** A recorded Direct default whose slot holds its pair, so a single-agent write is a re-render
 *  (zero probes, no credential needed); with no pair it would land both agents and ask to log in. */
function directDefault(): void {
  const state = new CopilotEnvState();
  state.recordDefaultMode("direct");
  state.setProfileDirectPair(null, { integrationId: null, host: DEFAULT_COPILOT_API_BASE });
}

/** A scratch Direct wiring with no identity header on the generic host: today's default bytes. */
const DIRECT_NONE = directWiring(null, DEFAULT_COPILOT_API_BASE);

const restoreEnv = envSnapshot(["PATH", CI_NO_LIVE_LOOKUPS_ENV]);
let dir = "";
// The default credential shape: the config names a copilot-env command that prints the credential.
const COMMAND = { kind: "command" } as const;

afterEach(() => {
  restoreEnv();
});

// The proxy home exists: catalog tests write the generated JSON straight into it.
function isolate(): void {
  dir = isolateAgentHomes("copilot-codex-", { mkdirs: true }).dir;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

// The catalog key defaults to false, so the enabled paths need this first.
function enableCatalog(): void {
  new CopilotEnvConfig().set({ "codex.model-catalog": true });
}

/** The installed codex's verdict on the generated file, as a fake codex on PATH: true accepts,
 *  false rejects, null proves nothing (unverifiable). */
function installedCodex(accepts: boolean | null): FakeCodex {
  return fakeCodexOnPath(dir, { probe: probeFor(accepts) });
}

function probeFor(accepts: boolean | null): FakeCodexProbe {
  return accepts === null ? "dump-other" : accepts ? "accept" : "reject";
}

test("the direct write: every managed field enforced, user keys and tables preserved, the probed id baked when passed, nothing at rest", () => {
  // The provider table Codex reads; `auth.timeout_ms` 30000 is an external contract (Codex reads
  // it). Direct fetches the bearer via `auth.command` -> the agent launcher `auth --get`: no
  // env_key, no token at rest, the user's .env never touched. Direct talks to a public host, not
  // the loopback proxy, so it does NOT open the sandbox. [features] and the user's own tables are
  // content the writer never touches.
  const USER_CONFIG = [
    'model_provider = "openai"',
    "",
    "[my_custom]",
    'keep = "me"',
    "",
    "[features]",
    "image_generation = false",
    "",
    "[model_providers.copilot-env]",
    'base_url = "https://stale.example"',
    'user_extra = "kept"',
    "",
    "[model_providers.other]",
    'base_url = "http://other/v1"',
    'env_key = "OTHER_KEY"',
    "",
  ].join("\n");
  const cases: {
    name: string;
    existing: string | null;
    direct: ReturnType<typeof directWiring> | null;
    integrationId: string | undefined;
  }[] = [
    {
      name: "over a user config, no probed id",
      existing: USER_CONFIG,
      direct: null,
      integrationId: undefined,
    },
    {
      name: "no config at all, no probed id",
      existing: null,
      direct: null,
      integrationId: undefined,
    },
    {
      name: "no config at all, a probed id",
      existing: null,
      direct: directWiring("copilot-developer-cli", DEFAULT_COPILOT_API_BASE),
      integrationId: "copilot-developer-cli",
    },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    isolate();
    const codexHome = join(dir, ".codex");
    const configPath = join(codexHome, "config.toml");
    const envPath = join(codexHome, ".env");
    if (c.existing !== null) {
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(configPath, c.existing);
      writeFileSync(envPath, "OPENAI_API_KEY=user\n");
    }

    configureCodexConfig(codexHome, { mode: "direct", direct: c.direct, credential: COMMAND });

    const doc = asRecord(parse(readFileSync(configPath, "utf8")));
    expect(doc.model_provider, c.name).toBe("copilot-env");
    expect(doc.web_search, c.name).toBe("live");
    expect(doc.sandbox_workspace_write, c.name).toBeUndefined();
    const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
    expect(provider.name, c.name).toBe("copilot-env");
    expect(provider.base_url, c.name).toBe("https://api.githubcopilot.com");
    expect(provider.wire_api, c.name).toBe("responses");
    expect(provider.supports_websockets, c.name).toBe(false);
    expect(provider.requires_openai_auth, c.name).toBe(false);
    const headers = asRecord(provider.http_headers);
    expect(headers["Openai-Intent"], c.name).toBe("conversation-edits");
    expect(headers["User-Agent"], c.name).toBe(`codex_exec/${FALLBACK_CODEX_UA_VERSION}`);
    // No probed identity passed -> no Copilot-Integration-Id header (the codex identity).
    expect(headers["Copilot-Integration-Id"], c.name).toBe(c.integrationId);
    const auth = asRecord(provider.auth);
    const expected = agentLauncherCommand(["auth", "--get"]);
    expect(auth.command, c.name).toBe(expected.command);
    expect(auth.args, c.name).toEqual(expected.args);
    expect(auth.timeout_ms, c.name).toBe(30000);
    expect(auth.refresh_interval_ms, c.name).toBe(300000);
    expect(provider.env_key, c.name).toBeUndefined();
    const wiring = inspectCodexWiring(readFileSync(configPath, "utf8"), null, 4141, false);
    expect(wiring.providerMode, c.name).toBe("direct");
    expect(wiring.directUsesToken, c.name).toBe(true);
    if (c.existing === null) {
      expect(doc.features, c.name).toBeUndefined();
      expect(existsSync(envPath), c.name).toBe(false);
    } else {
      expect(asRecord(doc.my_custom).keep, c.name).toBe("me");
      expect(asRecord(doc.features).image_generation, c.name).toBe(false);
      expect(provider.user_extra, c.name).toBe("kept");
      const other = asRecord(asRecord(doc.model_providers).other);
      expect(other.base_url, c.name).toBe("http://other/v1");
      expect(other.env_key, c.name).toBe("OTHER_KEY");
      expect(readFileSync(envPath, "utf8"), c.name).toBe("OPENAI_API_KEY=user\n");
    }
  }
});

test("proxy mode enforces every managed field while preserving unknown user keys", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "openai"',
      "",
      "[my_custom]",
      'keep = "me"',
      "",
      "[features]",
      "image_generation = false",
      "user_feature = true",
      "",
      "[model_providers.copilot-env]",
      'base_url = "http://stale:1/v1"',
      'env_key = "COPILOT_API_KEY"',
      'user_extra = "kept"',
      "",
      "[model_providers.other]",
      'base_url = "http://other/v1"',
      'env_key = "OTHER_KEY"',
      "",
    ].join("\n"),
  );

  configureCodexConfig(codexHome, {
    mode: "proxy",
    credential: COMMAND,
    baseUrl: "http://localhost:4141/v1",
  });

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(asRecord(doc.my_custom).keep).toBe("me");
  expect(doc.model_provider).toBe("copilot-env");
  expect(doc.web_search).toBe("live");
  // [features] is user content the writer never touches, in proxy mode too.
  expect(asRecord(doc.features).image_generation).toBe(false);
  expect(asRecord(doc.features).user_feature).toBe(true);

  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
  expect(provider.name).toBe("copilot-env");
  // Proxy resolves its key via auth.command (`agent profile proxy-token --yes`: ensure + print);
  // the stale env_key is scrubbed (Codex forbids auth + env_key together).
  expect(provider.env_key).toBeUndefined();
  const proxyAuthCmd = proxyTokenCommand();
  expect(asRecord(provider.auth).command).toBe(proxyAuthCmd.command);
  expect(asRecord(provider.auth).args).toEqual(proxyAuthCmd.args);
  expect(String(asRecord(provider.auth).args)).toContain("proxy-token");
  // A generous timeout so the first auth attempt outlasts a proxy cold start.
  expect(asRecord(provider.auth).timeout_ms).toBe(180000);
  expect(provider.wire_api).toBe("responses"); // missing managed field filled
  expect(provider.requires_openai_auth).toBe(false);
  expect(provider.supports_websockets).toBe(false);
  expect(provider.user_extra).toBe("kept"); // user-added key in the table survives

  // The proxy is on loopback; codex's sandbox blocks loopback unless workspace-write network
  // access is granted, so proxy mode enables it (the auth.command's liveness probe needs it).
  expect(asRecord(doc.sandbox_workspace_write).network_access).toBe(true);

  const other = asRecord(asRecord(doc.model_providers).other);
  expect(other.base_url).toBe("http://other/v1");
  expect(other.env_key).toBe("OTHER_KEY");

  // No key is baked into .env (resolved at runtime by auth.command).
  expect(existsSync(join(codexHome, ".env"))).toBe(false);
});

test("toggling direct <-> proxy swaps the mode-specific keys on the shared table, written directly or through runCodex --proxy/--direct (no probe)", async () => {
  isolate();
  const codexHome = join(dir, ".codex");

  configureCodexConfig(codexHome, {
    mode: "direct",
    direct: null,
    credential: COMMAND,
  });
  let provider = asRecord(
    asRecord(asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8"))).model_providers)[
      "copilot-env"
    ],
  );
  expect(asRecord(provider.auth).args).toEqual(
    agentLauncherCommand(["auth", "--get"]).args,
  );
  expect(provider.http_headers).toBeDefined();

  // Proxy on the SAME table: the proxy auth replaces the direct auth, env_key stays absent,
  // and the direct-only http_headers is scrubbed.
  configureCodexConfig(codexHome, {
    mode: "proxy",
    credential: COMMAND,
    baseUrl: "http://localhost:4141/v1",
  });
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
  expect(provider.env_key).toBeUndefined();
  expect(asRecord(provider.auth).command).toBe(proxyTokenCommand().command);
  expect(asRecord(provider.auth).args).toEqual(proxyTokenCommand().args);
  expect(provider.http_headers).toBeUndefined();

  // The same toggles through runCodex: --proxy forces the proxy provider at the daemon's
  // loopback address over whatever base_url the table held (a foreign one here), --direct the
  // Copilot host.
  const tomlPath = join(codexHome, "config.toml");
  writeFileSync(
    tomlPath,
    readFileSync(tomlPath, "utf8").replace("http://localhost:4141/v1", "https://old.example"),
  );
  new CopilotEnvState().recordDefaultMode("proxy"); // a single-agent write re-renders the record
  await runCodex({ kind: "configure", mode: "proxy" });
  let viaRun = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(viaRun.model_provider).toBe("copilot-env");
  expect(asRecord(asRecord(viaRun.model_providers)["copilot-env"]).base_url).toBe(
    "http://127.0.0.1:4141/v1",
  );

  directDefault();
  await runCodex({ kind: "configure", mode: "direct" });
  viaRun = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(viaRun.model_provider).toBe("copilot-env");
  const directProvider = asRecord(asRecord(viaRun.model_providers)["copilot-env"]);
  expect(directProvider.base_url).toBe("https://api.githubcopilot.com");
  // Toggling proxy -> direct must leave NO stale proxy-only key on the shared table.
  expect(directProvider.env_key).toBeUndefined();
});

test("a static-key write previews its bearer leaf redacted and every other leaf in the clear", async () => {
  isolate();
  const home = join(dir, ".codex");
  const { stdout } = await captureChannels(() =>
    runDryRun(() =>
      Promise.resolve(
        configureCodexConfig(home, {
          mode: "direct",
          direct: null,
          credential: { kind: "static", token: "ghu_baked_token" },
        }),
      )
    )
  );
  // The print wraps to the terminal width (mid-key or at a space), so the rows are compared with
  // their whitespace removed, and only the rows under config.toml's own verdict line count.
  const unspaced = (text: string): string => text.replace(/\s+/g, "");
  const flat = unspaced(stdout);
  const block = flat.slice(flat.indexOf(unspaced(`create ${join(home, "config.toml")}`)));
  expect(block.length).toBeGreaterThan(0);
  expect(block).toContain(
    unspaced("model_providers.copilot-env.http_headers.Authorization  (absent) -> <redacted>"),
  );
  expect(block).toContain(
    unspaced('model_providers.copilot-env.base_url  (absent) -> "https://api.githubcopilot.com"'),
  );
  expect(flat).not.toContain("ghu_baked_token");
});

test("static-key bakes the bearer as http_headers.Authorization with no auth table, in both modes", () => {
  isolate();
  const STATIC = { kind: "static", token: "ghu_baked_token" } as const;
  const provider = (home: string): Record<string, unknown> =>
    asRecord(
      asRecord(asRecord(parse(readFileSync(join(home, "config.toml"), "utf8"))).model_providers)[
        "copilot-env"
      ],
    );
  const wiring = (home: string) =>
    inspectCodexWiring(readFileSync(join(home, "config.toml"), "utf8"), null, 4141, false);

  // Direct: the bearer rides beside the client headers; the write's line names the shape, never the value.
  const directHome = join(dir, ".codex");
  const said = stderrOfSync(() =>
    configureCodexConfig(directHome, {
      mode: "direct",
      direct: null,
      credential: STATIC,
    })
  );
  expect(linesNaming(said, directHome)).toEqual([
    `created -> ${join(directHome, "config.toml")} (Codex config; static key)`,
  ]);
  expect(said).not.toContain(STATIC.token);
  let table = provider(directHome);
  expect(table.auth).toBeUndefined();
  expect(table.env_key).toBeUndefined();
  expect(table.requires_openai_auth).toBe(false);
  expect(asRecord(table.http_headers)).toEqual({
    "Openai-Intent": "conversation-edits",
    "User-Agent": `codex_exec/${FALLBACK_CODEX_UA_VERSION}`,
    "Authorization": `Bearer ${STATIC.token}`,
  });
  let seen = wiring(directHome);
  expect(seen.providerMode).toBe("direct");
  expect(seen.credential).toBe("static");
  expect(seen.providerWired).toBe(true);
  expect(seen.directUsesToken).toBe(false);

  // Back to the command shape: the bearer goes, the client headers stay, the managed auth returns.
  configureCodexConfig(directHome, {
    mode: "direct",
    direct: null,
    credential: COMMAND,
  });
  table = provider(directHome);
  expect(asRecord(table.http_headers)["Authorization"]).toBeUndefined();
  expect(asRecord(table.http_headers)["User-Agent"]).toBe(
    `codex_exec/${FALLBACK_CODEX_UA_VERSION}`,
  );
  expect(asRecord(table.auth).args).toEqual(
    agentLauncherCommand(["auth", "--get"]).args,
  );
  expect(wiring(directHome).credential).toBe("command");

  // Proxy (a second home, since the seam names a path once per process): the bearer is the
  // table's only header, and the line says the daemon is the user's to start.
  const proxyHome = join(dir, "second-codex");
  const proxySaid = stderrOfSync(() =>
    configureCodexConfig(proxyHome, {
      mode: "proxy",
      credential: STATIC,
      baseUrl: "http://localhost:4141/v1",
    })
  );
  expect(linesNaming(proxySaid, join(proxyHome, "config.toml"))).toEqual([
    `created -> ${join(proxyHome, "config.toml")} (Codex config; static key, start the proxy ` +
    "yourself (agent start, or the cx launcher))",
  ]);
  expect(proxySaid).not.toContain(STATIC.token);
  table = provider(proxyHome);
  expect(table.auth).toBeUndefined();
  expect(table.env_key).toBeUndefined();
  expect(table.requires_openai_auth).toBe(false);
  expect(table.http_headers).toEqual({ "Authorization": `Bearer ${STATIC.token}` });
  seen = wiring(proxyHome);
  expect(seen.providerMode).toBe("proxy");
  expect(seen.credential).toBe("static");
  expect(seen.providerWired).toBe(true);

  // The proxy command shape writes no headers at all, so the rewrite drops the whole key.
  configureCodexConfig(proxyHome, {
    mode: "proxy",
    credential: COMMAND,
    baseUrl: "http://localhost:4141/v1",
  });
  table = provider(proxyHome);
  expect(table.http_headers).toBeUndefined();
  expect(asRecord(table.auth).args).toEqual(proxyTokenCommand().args);
  expect(wiring(proxyHome).credential).toBe("command");
});

test("detectCodexDirect: the CLI runs the catalog's codex-servable model and its verdict decides; gh is optional", async () => {
  isolate();
  // A runProbe spy lets us prove the CLI gate short-circuits BEFORE the (here
  // simulated) model call, and that the call is pinned to the catalog pick.
  let probeCalls = 0;
  let seenArgs: string[] | null = null;
  // Two servable models: the reduced tier is pinned over the full one.
  const servable = (id: string) => ({
    "id": id,
    "capabilities": {
      "type": "chat",
      "limits": { "max_context_window_tokens": 272000, "max_prompt_tokens": 260000 },
    },
    "model_picker_enabled": true,
    "supported_endpoints": ["/responses"],
  });
  let fetches = 0;
  const fetchImpl = () => {
    fetches++;
    return Promise.resolve(
      new Response(JSON.stringify({ data: [servable("gpt-6"), servable("gpt-6-nano")] }), {
        status: 200,
      }),
    );
  };
  const ok = {
    findCommand: (c: string) => ({ path: `/bin/${c}` }),
    runProbe: (_cli: string, args: string[]) => {
      probeCalls++;
      seenArgs = args;
      return { ok: true };
    },
    fetchImpl,
  };
  const pinnedModel = () => {
    const args = seenArgs as unknown as string[];
    return args[args.indexOf("--model") + 1];
  };
  expect(await detectCodexDirect(DIRECT_NONE, "ghu_tok", COMMAND, ok)).toBe(true);
  expect([probeCalls, fetches, pinnedModel()]).toEqual([1, 1, "gpt-6-nano"]);
  // A set probe.codex-model is the model the smoke runs, as-is, with no catalog fetch.
  new CopilotEnvConfig().set({ "probe.codex-model": "gpt-6" });
  expect(await detectCodexDirect(DIRECT_NONE, "ghu_tok", COMMAND, ok)).toBe(true);
  expect([probeCalls, fetches, pinnedModel()]).toEqual([2, 1, "gpt-6"]);
  new CopilotEnvConfig().del("probe.codex-model");
  // The live read-only prompt failed -> proxy.
  expect(
    await detectCodexDirect(DIRECT_NONE, "ghu_tok", COMMAND, {
      ...ok,
      runProbe: () => ({ ok: false }),
    }),
  )
    .toBe(false);

  // No credential returns false WITHOUT calling runProbe, with or without a CLI.
  probeCalls = 0;
  expect(await detectCodexDirect(DIRECT_NONE, null, COMMAND, ok)).toBe(false);
  expect(
    await detectCodexDirect(DIRECT_NONE, null, COMMAND, {
      ...ok,
      findCommand: (c: string) => ({ path: c === "codex" ? null : `/bin/${c}` }),
    }),
  ).toBe(false);
  expect(probeCalls).toBe(0);

  // A pasted or device-flow token needs no gh on the machine: the probe still runs.
  expect(
    await detectCodexDirect(DIRECT_NONE, "ghu_tok", COMMAND, {
      ...ok,
      findCommand: (c: string) => ({ path: c === "gh" ? null : `/bin/${c}` }),
    }),
  ).toBe(true);
  expect(probeCalls).toBe(1);
});

test("detectCodexDirect: with no codex CLI the endpoint smoke pings the first codex-servable model on /responses", async () => {
  isolate();
  const requests: { url: string; body: unknown }[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    // claude-fable-5 is first but not on the /responses wire; gpt-6-mini is picker-disabled.
    const catalog = {
      data: [
        {
          "id": "claude-fable-5",
          "capabilities": {
            "type": "chat",
            "limits": { "max_context_window_tokens": 200000, "max_prompt_tokens": 190000 },
          },
          "model_picker_enabled": true,
          "supported_endpoints": ["/v1/messages"],
        },
        {
          "id": "gpt-6-mini",
          "capabilities": {
            "type": "chat",
            "limits": { "max_context_window_tokens": 128000, "max_prompt_tokens": 120000 },
          },
          "model_picker_enabled": false,
          "supported_endpoints": ["/responses"],
        },
        {
          "id": "gpt-6",
          "capabilities": {
            "type": "chat",
            "limits": { "max_context_window_tokens": 272000, "max_prompt_tokens": 260000 },
          },
          "model_picker_enabled": true,
          "supported_endpoints": ["/responses"],
        },
      ],
    };
    return Promise.resolve(
      new Response(requests.length === 1 ? JSON.stringify(catalog) : "{}", { status: 200 }),
    );
  };
  const verdict = await detectCodexDirect(DIRECT_NONE, "ghu_tok", COMMAND, {
    findCommand: (c: string) => ({ path: c === "codex" ? null : `/bin/${c}` }),
    runProbe: () => ({ ok: false }), // must never run: no CLI was found
    fetchImpl,
  });
  expect(verdict).toBe(true);
  expect(requests.map((r) => r.url)).toEqual([
    "https://api.githubcopilot.com/models",
    "https://api.githubcopilot.com/responses",
  ]);
  expect(requests[1]?.body).toEqual({
    "model": "gpt-6",
    "input": "x",
    "stream": false,
    "max_output_tokens": 16,
  });
});

test("detectCodexDirect: the probe home carries the Direct provider table alone, spawned from inside it", async () => {
  isolate();
  // The user's real wiring adds web_search and the generated catalog reference; the probe must
  // judge Direct without them, since a catalog produced under another credential (or a stale one)
  // would colour the verdict. The provider table itself is the real write's, byte for byte.
  enableCatalog();
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
  const catalog = {
    "id": "gpt-6",
    "capabilities": {
      "type": "chat",
      "limits": { "max_context_window_tokens": 272000, "max_prompt_tokens": 260000 },
    },
    "model_picker_enabled": true,
    "supported_endpoints": ["/responses"],
  };
  let probeDoc: Record<string, unknown> | null = null;
  let spawn: { cwd: string; home: string } | null = null;
  const verdict = await detectCodexDirect(
    directWiring("copilot-developer-cli", DEFAULT_COPILOT_API_BASE),
    "ghu_tok",
    COMMAND,
    {
      findCommand: (c: string) => ({ path: `/bin/${c}` }),
      runProbe: (_cli: string, _args: string[], env: Record<string, string>, cwd: string) => {
        const home = env.CODEX_HOME ?? "";
        spawn = { cwd, home };
        // A reference sync run with this env (a wiring write or a launch under this $CODEX_HOME)
        // must neither add the reference to the throwaway config nor ledger it.
        process.env.CODEX_HOME = home;
        syncCodexCatalogReference();
        probeDoc = asRecord(parse(readFileSync(join(home, "config.toml"), "utf8")));
        return { ok: true };
      },
      fetchImpl: () =>
        Promise.resolve(new Response(JSON.stringify({ data: [catalog] }), { status: 200 })),
    },
  );
  delete process.env.CODEX_HOME;
  expect(verdict).toBe(true);
  const seen = spawn as unknown as { cwd: string; home: string };
  expect(seen.cwd).toBe(seen.home);
  expect(new OwnershipLedger().ownedPaths("codexCatalog")).toEqual([]);

  const realHome = join(dir, ".codex");
  configureCodexConfig(realHome, {
    mode: "direct",
    credential: COMMAND,
    direct: directWiring("copilot-developer-cli", DEFAULT_COPILOT_API_BASE),
  });
  const realDoc = asRecord(parse(readFileSync(join(realHome, "config.toml"), "utf8")));
  const probe = probeDoc as unknown as Record<string, unknown>;
  expect(Object.keys(probe).sort()).toEqual(
    ["analytics", "feedback", "model_provider", "model_providers"],
  );
  // Selected under a non-managed id (what keeps the self-heal off), the table itself the real one.
  expect(probe.model_provider).toBe("copilot-env-probe");
  expect(probe.model_providers).toEqual({
    "copilot-env-probe": asRecord(realDoc.model_providers)["copilot-env"],
  });
  expect([realDoc.web_search, realDoc.model_catalog_json]).toEqual(["live", catalogFile]);
});

test("model_catalog_json on the write: set and claimed only with the opt-in on, a usable file, and the installed codex not rejecting it; otherwise scrubbed and the claim released, the file kept, both modes alike", () => {
  // A dangling or unparseable model_catalog_json is a Codex STARTUP error, so usability (not
  // existence) gates the key; a schema the installed codex rejects is the same failure, while an
  // unverifiable verdict (no codex to ask) keeps the pre-probe behaviour. The write never deletes
  // the file (that is the disabled sync's job). Seeded references go through the TOML writer,
  // never a hand-quoted string: a raw Windows path inside a basic string reads as escapes.
  type File = "usable" | "absent" | "corrupt" | "dir";
  /** What the config already carries: a reference to our file (with the ledger's claim), or a
   *  reference to a path that never existed and was never ours. */
  type Seed = "ours" | "foreign-missing";
  const FOREIGN_MISSING = "/nonexistent/codex-model-catalog.json";
  const cases: {
    name: string;
    enabled: boolean;
    mode: "direct" | "proxy";
    file: File;
    seed?: Seed;
    accepts?: boolean | null;
    key: boolean;
    claimed: boolean;
  }[] = [
    {
      name: "direct, enabled, usable",
      enabled: true,
      mode: "direct",
      file: "usable",
      key: true,
      claimed: true,
    },
    {
      name: "proxy, enabled, usable",
      enabled: true,
      mode: "proxy",
      file: "usable",
      key: true,
      claimed: true,
    },
    {
      name: "disabled: a usable file, our reference and claim seeded",
      enabled: false,
      mode: "direct",
      file: "usable",
      seed: "ours",
      key: false,
      claimed: false,
    },
    {
      name: "enabled: our seeded reference, the file gone",
      enabled: true,
      mode: "direct",
      file: "absent",
      seed: "ours",
      key: false,
      claimed: false,
    },
    {
      // A dangling reference is a startup error whoever wrote it: the full write scrubs it.
      name: "enabled: a seeded reference to a path that never existed",
      enabled: true,
      mode: "direct",
      file: "absent",
      seed: "foreign-missing",
      key: false,
      claimed: false,
    },
    {
      name: "enabled: a corrupt file",
      enabled: true,
      mode: "direct",
      file: "corrupt",
      key: false,
      claimed: false,
    },
    {
      name: "enabled: the installed codex accepts",
      enabled: true,
      mode: "direct",
      file: "usable",
      accepts: true,
      key: true,
      claimed: true,
    },
    {
      name: "enabled: the installed codex rejects (the reference IS the startup failure)",
      enabled: true,
      mode: "direct",
      file: "usable",
      seed: "ours",
      accepts: false,
      key: false,
      claimed: false,
    },
    {
      name: "enabled: unverifiable keeps the pre-probe behaviour",
      enabled: true,
      mode: "direct",
      file: "usable",
      accepts: null,
      key: true,
      claimed: true,
    },
    {
      name:
        "enabled: our seeded reference, the file now a directory, even when a probe would accept",
      enabled: true,
      mode: "direct",
      file: "dir",
      seed: "ours",
      accepts: true,
      key: false,
      claimed: false,
    },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    isolate();
    const codexHome = join(dir, ".codex");
    const configPath = join(codexHome, "config.toml");
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    if (c.enabled) enableCatalog();
    if (c.file === "usable") writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
    if (c.file === "corrupt") writeFileSync(catalogFile, "{ corrupt");
    if (c.file === "dir") mkdirSync(catalogFile);
    if (c.seed !== undefined) {
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(
        configPath,
        stringify({ "model_catalog_json": c.seed === "ours" ? catalogFile : FOREIGN_MISSING }),
      );
      if (c.seed === "ours") new OwnershipLedger().record("codexCatalog", configPath);
    }
    installedCodex(c.accepts ?? null);
    configureCodexConfig(
      codexHome,
      c.mode === "direct"
        ? { mode: "direct", direct: null, credential: COMMAND }
        : { mode: "proxy", credential: COMMAND, baseUrl: "http://127.0.0.1:4141/v1" },
    );
    const doc = asRecord(parse(readFileSync(configPath, "utf8")));
    expect({ name: c.name, key: doc.model_catalog_json }).toEqual({
      name: c.name,
      key: c.key ? catalogFile : undefined,
    });
    expect(new OwnershipLedger().owns("codexCatalog", configPath), c.name).toBe(c.claimed);
    expect(existsSync(catalogFile), c.name).toBe(c.file !== "absent");
  }
});

test("a write to an unknown home never enters the ledger", () => {
  isolate();
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');

  // A write to a home outside the cleanup sweep (a test dir, a hand-passed one) still writes the
  // key (inert there), but must never be claimed -- the ledger would accumulate dead paths.
  const probeHome = join(dir, "probe-home");
  configureCodexConfig(probeHome, {
    mode: "direct",
    direct: null,
    credential: COMMAND,
  });
  const doc = asRecord(parse(readFileSync(join(probeHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBe(catalogFile);
  expect(new OwnershipLedger().ownedPaths("codexCatalog")).toEqual([]);
});

test("syncCodexCatalogReference (enabled) heals a managed config missing the key in place and touches nothing else: a config not on our provider, an absent one, a user-pinned path", () => {
  // The wiring-time seed failed (no catalog yet), so the managed config was written WITHOUT the
  // key; once the refresh generates the file, the post-refresh hook adds the reference in place.
  // It is ADD-only and ours-only: no model_provider (the --mobile pairing shape), a foreign
  // provider, no config.toml at all, and a user-pinned catalog path are left byte for byte.
  const cases: { name: string; content: string | null; healed: boolean }[] = [
    {
      name: "managed, missing the key",
      content: ['model_provider = "copilot-env"', 'user_key = "kept"', ""].join("\n"),
      healed: true,
    },
    { name: "no model_provider", content: 'user_key = "kept"\n', healed: false },
    { name: "a foreign provider", content: 'model_provider = "openai"\n', healed: false },
    { name: "no config.toml at all", content: null, healed: false },
    {
      name: "a user-pinned catalog path",
      content: [
        'model_provider = "copilot-env"',
        'model_catalog_json = "/home/user/custom-catalog.json"',
        "",
      ].join("\n"),
      healed: false,
    },
  ];
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  for (const c of cases) {
    rmSync(configPath, { force: true });
    if (c.content !== null) writeFileSync(configPath, c.content);
    syncCodexCatalogReference();
    if (c.healed) {
      const doc = asRecord(parse(readFileSync(configPath, "utf8")));
      expect(doc.model_catalog_json, c.name).toBe(catalogFile);
      expect(doc.user_key, c.name).toBe("kept");
    } else if (c.content === null) {
      expect(existsSync(configPath), c.name).toBe(false);
    } else {
      expect(readFileSync(configPath, "utf8"), c.name).toBe(c.content);
    }
  }
});

test("disabled: one sync strips our reference from every config carrying it (the active home, a per-host farm home, a ledger-recorded one elsewhere), drops stale claims, deletes the file, and clears the throttle state", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  const referencing = stringify({ "model_catalog_json": catalogFile });
  const active = join(codexHome, "config.toml");
  writeFileSync(
    active,
    stringify({
      "model_provider": "copilot-env",
      "model_catalog_json": catalogFile,
      "user_key": "kept",
    }),
  );
  // A per-host farm config referencing the shared file.
  const farm = join(codexHome, "hosts", "otherhost", "config.toml");
  mkdirSync(join(codexHome, "hosts", "otherhost"), { recursive: true });
  writeFileSync(farm, referencing);
  // A RECORDED config outside every known home (a retired farm home, a moved CODEX_HOME) still
  // referencing our file: only the ledger knows to sweep it.
  const outside = join(dir, "retired-home", "config.toml");
  mkdirSync(join(dir, "retired-home"), { recursive: true });
  writeFileSync(outside, referencing);
  const ledger = new OwnershipLedger();
  ledger.record("codexCatalog", outside);
  // And a stale claim: the recorded config no longer exists at all.
  ledger.record("codexCatalog", join(dir, "gone", "config.toml"));
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: 123,
    codexCatalogCodexVersion: "1.0.0",
    codexCatalogAccepted: { sha256: "0".repeat(64), codexVersion: "1.0.0" },
  });

  syncCodexCatalogReference();

  for (const configPath of [active, farm, outside]) {
    expect(asRecord(parse(readFileSync(configPath, "utf8"))).model_catalog_json, configPath)
      .toBeUndefined();
  }
  expect(asRecord(parse(readFileSync(active, "utf8"))).user_key).toBe("kept");
  expect(existsSync(catalogFile)).toBe(false);
  expect(new OwnershipLedger().ownedPaths("codexCatalog")).toEqual([]);
  const state = new CopilotEnvState().read();
  expect(state.codexCatalogLastAttemptMs).toBe(0);
  expect(state.codexCatalogCodexVersion).toBeNull();
  expect(state.codexCatalogAccepted).toBeNull();
});

test("disabled: our file goes only when every reference is provably not ours; a reference we cannot read, or an alias of our path, keeps it (fail closed)", () => {
  // Codex treats a dangling model_catalog_json as a startup error, so deletion waits on any
  // reference that MIGHT denote our file: an unparseable config, or a symlink alias resolving to
  // it (not provably ours to strip either, but deleting the file would dangle it). A resolvable
  // reference elsewhere, or a path that does not exist at all, is a proven "not ours": the user's
  // line stays and the ordinary cleanup runs. The reference we CANNOT resolve (EACCES) is its own
  // test below: it needs non-root POSIX.
  const cases: {
    name: string;
    posixOnly?: true;
    /** Writes what the reference needs and answers the config text. */
    config: (catalogFile: string) => string;
    fileKept: boolean;
  }[] = [
    {
      name: "a user-pinned path that does not exist",
      config: () =>
        [
          'model_provider = "copilot-env"',
          'model_catalog_json = "/home/user/custom-catalog.json"',
          "",
        ].join("\n"),
      fileKept: false,
    },
    {
      name: "a resolvable reference elsewhere (the control)",
      config: () => {
        const foreign = join(dir, "someone-elses-catalog.json");
        writeFileSync(foreign, "{}");
        return stringify({ "model_catalog_json": foreign });
      },
      fileKept: false,
    },
    {
      name: "an unparseable config",
      config: () => "model_catalog_json = [unclosed",
      fileKept: true,
    },
    {
      name: "a symlink alias of our path",
      posixOnly: true, // symlink creation needs privileges on Windows
      config: (catalogFile) => {
        const alias = join(dir, "catalog-alias.json");
        symlinkSync(catalogFile, alias);
        return stringify({ "model_catalog_json": alias });
      },
      fileKept: true,
    },
  ];
  for (const c of cases) {
    if (c.posixOnly && process.platform === "win32") continue;
    dir = removeDir(dir);
    isolate();
    const codexHome = join(dir, ".codex");
    process.env.CODEX_HOME = codexHome;
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
    const text = c.config(catalogFile);
    writeFileSync(join(codexHome, "config.toml"), text);

    syncCodexCatalogReference();

    expect(readFileSync(join(codexHome, "config.toml"), "utf8"), c.name).toBe(text); // untouched
    expect(existsSync(catalogFile), c.name).toBe(c.fileKept);
  }
});

test("disabled: steady-state sync is write-free", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  const clean = 'model_provider = "copilot-env"\n';
  writeFileSync(join(codexHome, "config.toml"), clean);
  const stateFile = new CopilotApiPaths().stateStoreFile;

  syncCodexCatalogReference();
  const stateAfterFirst = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
  syncCodexCatalogReference();

  // Nothing to clean: the config text is untouched and no state file appears.
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(clean);
  const stateAfterSecond = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
  expect(stateAfterSecond).toBe(stateAfterFirst);
  expect(stateAfterFirst).toBeNull();
});

// One step further out than the symlink alias: a reference realpath cannot resolve at all (EACCES
// on a component, ELOOP) is not proof it is someone else's, and Codex treats a dangling
// model_catalog_json as a startup error. Non-root POSIX only: root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "disabled: a reference we CANNOT resolve blocks deletion too (fail closed)",
  () => {
    isolate();
    const codexHome = join(dir, ".codex");
    process.env.CODEX_HOME = codexHome;
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
    // A reference under a directory we cannot traverse: realpathSync raises EACCES,
    // so whether it denotes our file is UNKNOWN, not "no".
    const blocked = join(dir, "blocked");
    mkdirSync(blocked, { recursive: true });
    const pinned = stringify({ "model_catalog_json": join(blocked, "catalog.json") });
    writeFileSync(join(codexHome, "config.toml"), pinned);
    chmodSync(blocked, 0o000);
    try {
      syncCodexCatalogReference();

      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(pinned);
      expect(existsSync(catalogFile)).toBe(true);
    } finally {
      chmodSync(blocked, 0o755);
    }
  },
);

// --- the retired script-shaped proxy auth is foreign now -----------------------

function proxyConfigWithAuth(auth: { command: string; args: string[] }): string {
  return stringify({
    "model_provider": "copilot-env",
    "model_providers": {
      "copilot-env": {
        "name": "copilot-env",
        "base_url": "http://127.0.0.1:4141/v1",
        "wire_api": "responses",
        "auth": { "command": auth.command, "args": auth.args },
      },
    },
  });
}

test("a proxy auth block that is not the managed proxy-token command (the 3.5.6 script shape, a foreign resolver) reads proxy but unwired", () => {
  // The 4.0.0 migration rewrites the script shape; a config it never reached is proxy but unwired,
  // so `agent health` says re-run `agent init --proxy` instead of vouching for a resolver script
  // no release ships. A genuinely foreign resolver is the same verdict.
  const script = process.platform === "win32"
    ? { command: "powershell", args: ["-File", "C:\\r\\src\\scripts\\proxy-token.ps1", "--yes"] }
    : { command: "/bin/sh", args: ["/r/src/scripts/proxy-token.sh", "--yes"] };
  for (const auth of [script, { command: "/usr/local/bin/my-token", args: ["--yes"] }]) {
    const wiring = inspectCodexWiring(proxyConfigWithAuth(auth), null, 4141, false);
    expect([wiring.providerMode, wiring.envKeyMatches, wiring.providerWired], auth.command)
      .toEqual(["proxy", false, false]);
  }
});

test(
  "inspectCodexWiring classifies the read result (unreadable is other/read-error with the file " +
    "EXISTING, absent is none, ours is selected, a foreign one is other/custom carrying its id), " +
    "then config.toml, .env, and the environ decide the wiring facts",
  () => {
    const proxyToml = (baseUrl: string) => codexConfigToml({ baseUrl, auth: proxyTokenCommand() });
    const good = proxyToml("http://localhost:4141/v1");
    const env = "OPENAI_API_KEY=sk-test\n";
    const cases: {
      name: string;
      input: Parameters<typeof inspectCodexWiring>[0];
      env?: string;
      environ?: true;
      expected: Record<string, unknown>;
    }[] = [
      {
        name: "unreadable",
        input: { kind: "unreadable", error: "EACCES" },
        expected: { providerMode: "other", otherReason: "read-error", configExists: true },
      },
      {
        name: "absent",
        input: { kind: "absent" },
        expected: { providerMode: "none", configExists: false },
      },
      {
        name: "no config.toml",
        input: null,
        expected: { configExists: false, providerWired: false, providerMode: "none" },
      },
      {
        name: "ours",
        input: { kind: "text", text: 'model_provider = "copilot-env"' },
        expected: { providerSelected: true, otherReason: null },
      },
      {
        name: "foreign",
        input: 'model_provider = "openai"',
        expected: { providerMode: "other", otherReason: "custom", modelProvider: "openai" },
      },
      {
        name: "managed proxy provider + .env key",
        input: good,
        env,
        expected: {
          providerMode: "proxy",
          providerWired: true,
          envKeyInDotenv: true,
          tokenAvailable: true,
        },
      },
      {
        name: "stale port",
        input: proxyToml("http://localhost:9999/v1"),
        env,
        expected: { baseUrlMatches: false, providerWired: false },
      },
      {
        name: "foreign auth command",
        input: codexConfigToml({
          baseUrl: "http://localhost:4141/v1",
          auth: { command: "/usr/local/bin/other", args: ["--yes"] },
        }),
        env,
        expected: { providerWired: false },
      },
      {
        // The pre-4.0.0 proxy shape (`env_key` instead of the managed auth block) is proxy by base_url
        // but never managed wiring; the 4.0.0 migration rewrites it.
        name: "legacy env_key provider",
        input: codexConfigToml({ baseUrl: "http://localhost:4141/v1", envKey: "OPENAI_API_KEY" }),
        env,
        expected: {
          providerMode: "proxy",
          envKeyMatches: false,
          providerWired: false,
          tokenAvailable: true,
        },
      },
      {
        name: "key only in the environ",
        input: good,
        env: "FOO=1\n",
        environ: true,
        expected: { envKeyInDotenv: false, envKeyInEnviron: true, tokenAvailable: true },
      },
      { name: "key nowhere", input: good, env: "FOO=1\n", expected: { tokenAvailable: false } },
      {
        name: "spaces around the .env equals sign",
        input: good,
        env: "OPENAI_API_KEY = sk-test\n",
        expected: { envKeyInDotenv: true },
      },
      {
        name: "direct provider needs no OPENAI_API_KEY",
        input:
          `model_provider = "copilot-env"\n[model_providers.copilot-env]\nbase_url = "https://api.githubcopilot.com"\n`,
        expected: { providerMode: "direct", providerWired: true, tokenAvailable: false },
      },
    ];
    for (const c of cases) {
      expect(inspectCodexWiring(c.input, c.env ?? null, 4141, c.environ ?? false), c.name)
        .toMatchObject(c.expected);
    }
  },
);

// --- the installed codex's schema verdict ----------------------------------------

test("syncCodexCatalogReference strips our reference when the installed codex rejects the file", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
  writeFileSync(
    configPath,
    stringify({
      "model_provider": "copilot-env",
      "model_catalog_json": catalogFile,
      "user_key": "kept",
    }),
  );
  new OwnershipLedger().record("codexCatalog", configPath);

  // Rejected: the reference goes (user keys stay), the claim is released, the
  // file and the throttle state are untouched (this is not the opt-out sweep).
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: 123 });
  const codex = installedCodex(false);
  syncCodexCatalogReference();
  let doc = asRecord(parse(readFileSync(configPath, "utf8")));
  expect(doc.model_catalog_json).toBeUndefined();
  expect(doc.user_key).toBe("kept");
  expect(new OwnershipLedger().owns("codexCatalog", configPath)).toBe(false);
  expect(existsSync(catalogFile)).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogLastAttemptMs).toBe(123);

  // Still rejected: the self-heal never adds the reference back.
  syncCodexCatalogReference();
  expect(asRecord(parse(readFileSync(configPath, "utf8"))).model_catalog_json).toBeUndefined();

  // Accepted again (regenerated from the new codex): the self-heal adds it.
  codex.script({ probe: "accept" });
  syncCodexCatalogReference();
  doc = asRecord(parse(readFileSync(configPath, "utf8")));
  expect(doc.model_catalog_json).toBe(catalogFile);
});

test("syncCodexCatalogReference strips our reference when the catalog file is gone, malformed, or empty, and a user-pinned custom path never, whatever ours looks like or the installed codex says", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  const referenced = stringify({
    "model_provider": "copilot-env",
    "model_catalog_json": catalogFile,
  });
  const cases: [string, (() => void)][] = [
    ["absent", () => rmSync(catalogFile, { force: true })],
    ["malformed", () => writeFileSync(catalogFile, "{ corrupt")],
    ["empty", () => writeFileSync(catalogFile, '{"models":[]}')],
  ];
  const codex = installedCodex(true);
  for (const [label, arrange] of cases) {
    writeFileSync(configPath, referenced);
    arrange();
    syncCodexCatalogReference();
    expect([label, asRecord(parse(readFileSync(configPath, "utf8"))).model_catalog_json])
      .toEqual([label, undefined]);
  }
  // Control: a user-pinned custom path is not ours to strip, however our file looks and whatever
  // the installed codex says about ours (exact-value match alone proves ownership).
  const pinned = stringify({
    "model_provider": "copilot-env",
    "model_catalog_json": "/home/user/custom-catalog.json",
  });
  for (const [ours, accepts] of [["absent", true], ["usable", false]] as const) {
    if (ours === "absent") rmSync(catalogFile, { force: true });
    else writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
    writeFileSync(configPath, pinned);
    codex.script({ probe: probeFor(accepts) });
    syncCodexCatalogReference();
    expect(readFileSync(configPath, "utf8"), `${ours}, accepts ${accepts}`).toBe(pinned);
  }
});

test("a rejected catalog is stripped from every known config even when the active config is absent or foreign", () => {
  isolate();
  const active = join(dir, ".codex");
  process.env.CODEX_HOME = active;
  mkdirSync(active, { recursive: true });
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
  // A second home (a recorded claim extends the sweep past the enumerated homes)
  // still references the file.
  const otherConfig = join(dir, "other-home", "config.toml");
  mkdirSync(join(dir, "other-home"), { recursive: true });
  const referenced = stringify({
    "model_provider": "copilot-env",
    "model_catalog_json": catalogFile,
  });
  writeFileSync(otherConfig, referenced);
  new OwnershipLedger().record("codexCatalog", otherConfig);

  // Active config ABSENT: the sweep still strips the other home.
  installedCodex(false);
  syncCodexCatalogReference();
  expect(asRecord(parse(readFileSync(otherConfig, "utf8"))).model_catalog_json).toBeUndefined();
  expect(new OwnershipLedger().owns("codexCatalog", otherConfig)).toBe(false);

  // Active config on a FOREIGN provider, both configs referencing the file: both
  // stripped, the foreign provider kept.
  writeFileSync(otherConfig, referenced);
  new OwnershipLedger().record("codexCatalog", otherConfig);
  writeFileSync(
    join(active, "config.toml"),
    stringify({ "model_provider": "openai", "model_catalog_json": catalogFile }),
  );
  syncCodexCatalogReference();
  expect(asRecord(parse(readFileSync(otherConfig, "utf8"))).model_catalog_json).toBeUndefined();
  const activeDoc = asRecord(parse(readFileSync(join(active, "config.toml"), "utf8")));
  expect(activeDoc.model_catalog_json).toBeUndefined();
  expect(activeDoc.model_provider).toBe("openai");
});

// --- nothing hidden: every catalog artifact change is named ----------------------

/** Everything `fn` says on stderr: the logger's lines, then the seam's write reports
 *  (which bypass process.stderr, so they are held back and read at the flush). */
async function stderrOfAsync(fn: () => Promise<void>): Promise<string> {
  return (await captureChannels(fn, { writeReports: true })).stderr;
}

function stderrOfSync(fn: () => void): string {
  return captureChannelsSync(fn, { writeReports: true }).stderr;
}

test("the config write's one line carries the model_catalog_json change it makes", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
  installedCodex(true);
  const write = (home: string) =>
    configureCodexConfig(home, { mode: "direct", direct: null, credential: COMMAND });
  // Added: the write's line says so, once. Re-written unchanged: nothing said.
  expect(linesNaming(stderrOfSync(() => write(codexHome)), configPath)).toEqual([
    `created -> ${configPath} (Codex config; model_catalog_json = "${catalogFile}" set)`,
  ]);
  expect(stderrOfSync(() => write(codexHome))).toBe("");
  // Disabled: a config carrying the reference (a second home, since the seam names a
  // path once per process) is rewritten, its line naming the old value.
  const otherHome = join(dir, "other-home");
  const otherConfig = join(otherHome, "config.toml");
  mkdirSync(otherHome, { recursive: true });
  // Through the TOML writer, never a hand-quoted string: on Windows the path's backslashes
  // would read as escapes in a basic string, and the reference would never match.
  writeFileSync(otherConfig, stringify({ "model_catalog_json": catalogFile }));
  new CopilotEnvConfig().set({ "codex.model-catalog": false });
  expect(linesNaming(stderrOfSync(() => write(otherHome)), otherConfig)).toEqual([
    `rewritten -> ${otherConfig} (Codex config; model_catalog_json removed, was "${catalogFile}")`,
  ]);
});

test("the disabled sync names the file it deletes and every reference it strips; the enabled sync names the add", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
  writeFileSync(configPath, 'model_provider = "copilot-env"\n');
  installedCodex(true);
  const added = stderrOfSync(() => syncCodexCatalogReference());
  expect(added).toContain(
    `rewritten -> ${configPath} (Codex config; model_catalog_json = "${catalogFile}" set)`,
  );
  // A recorded config outside the home carries the reference too: the sweep strips it,
  // and its line says so (the active config's strip is a second write of a path this
  // process already named, so the seam says nothing more about it).
  const outside = join(dir, "retired-home", "config.toml");
  mkdirSync(join(dir, "retired-home"), { recursive: true });
  writeFileSync(outside, stringify({ "model_catalog_json": catalogFile }));
  new OwnershipLedger().record("codexCatalog", outside);
  new CopilotEnvConfig().set({ "codex.model-catalog": false });
  const cleaned = stderrOfSync(() => syncCodexCatalogReference());
  expect(asRecord(parse(readFileSync(configPath, "utf8"))).model_catalog_json).toBeUndefined();
  expect(cleaned).toContain(`rewritten -> ${outside} (Codex config; model_catalog_json removed)`);
  expect(existsSync(catalogFile)).toBe(false); // in the data home: removed, never named
  // A second disabled sync has nothing left to do, and says nothing.
  expect(stderrOfSync(() => syncCodexCatalogReference())).toBe("");
});

test("the launch hook: a throttled refresh leaves the file alone, and the sync that follows still heals the reference in place", async () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  const onDisk = '{"models":[{"slug":"gpt-5.5"}]}\n';
  writeFileSync(catalogFile, onDisk);
  writeFileSync(configPath, 'model_provider = "copilot-env"\n');
  // A fresh attempt under the installed codex's version: the refresh is throttled (nothing fetched,
  // the file untouched), and the sync adds the reference the wiring write never got to seed.
  const codex = installedCodex(true);
  codex.script({ version: "1.0.0" });
  const attemptMs = Date.now() - 1000;
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: attemptMs,
    codexCatalogCodexVersion: "1.0.0",
    codexCatalogPatchVersion: CATALOG_PATCH_VERSION,
  });
  const said = await stderrOfAsync(() => refreshCodexCatalogAndSync("direct"));
  // Throttled: no new attempt recorded, the file untouched.
  expect(new CopilotEnvState().read().codexCatalogLastAttemptMs).toBe(attemptMs);
  expect(readFileSync(catalogFile, "utf8")).toBe(onDisk);
  expect(asRecord(parse(readFileSync(configPath, "utf8"))).model_catalog_json).toBe(catalogFile);
  expect(new OwnershipLedger().owns("codexCatalog", configPath)).toBe(true);
  expect(said).toContain(
    `rewritten -> ${configPath} (Codex config; model_catalog_json = "${catalogFile}" set)`,
  );
});

test("agent profile check --codex reports a Direct config's service_tier line and never rewrites it", async () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  configureCodexConfig(codexHome, {
    mode: "direct",
    direct: null,
    credential: COMMAND,
  });
  const checkLine = async (): Promise<string | undefined> => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    process.exitCode = 99;
    try {
      await runCodex({ kind: "check" });
    } finally {
      console.log = realLog;
    }
    expect(process.exitCode).toBe(0); // informational: the provider-mode exit code stays
    return lines.find((l) => l.startsWith("service_tier:"));
  };
  const withTier = (tier: string | undefined): void => {
    const doc = asRecord(parse(readFileSync(configPath, "utf8")));
    if (tier === undefined) delete doc.service_tier;
    else doc.service_tier = tier;
    writeFileSync(configPath, stringify(doc));
  };
  const cases: [tier: string | undefined, expected: string][] = [
    [undefined, "service_tier: not pinned"],
    ["priority", 'service_tier: "priority" (Copilot Direct rejects it'],
    ["flex", 'service_tier: "flex" (accepted by Copilot Direct)'],
    ["fast", 'service_tier: "fast" (unrecognized; left alone)'],
  ];
  for (const [tier, expected] of cases) {
    withTier(tier);
    expect(await checkLine()).toContain(expected);
    // A rewrite leaves the user's line exactly as it was.
    configureCodexConfig(codexHome, {
      mode: "direct",
      direct: null,
      credential: COMMAND,
    });
    expect(asRecord(parse(readFileSync(configPath, "utf8"))).service_tier).toBe(tier);
  }
});
