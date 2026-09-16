// A named profile is selected through the top-level `model_provider` of its own
// `<name>.config.toml` (what `codex --profile <name>` layers over config.toml) pointing at
// config.toml's `[model_providers.copilot-env-<name>]`, and keyed through the managed auth.command
// or a static bearer alone. The writer never emits an env_key for a named profile, so the
// OPENAI_API_KEY facts read false here.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  type CodexWiringStatus,
  configureCodexConfig,
  inspectCodexWiring,
  removeCodexProfile,
} from "../src/codex/config.ts";
import { codexProfileConfigPath } from "../src/codex/paths.ts";
import { openaiBaseUrl } from "../src/copilot_api/port.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { childEnvWithPath, cliSpawn, resolveCommand } from "../src/utils/command.ts";
import { readTextResult } from "../src/utils/fs.ts";
import { proxyTokenCommand } from "../src/utils/root.ts";
import { runSync } from "./helpers/run.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";
// The default credential shape: the config names a copilot-env command that prints the credential.
const COMMAND = { kind: "command" } as const;

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

const WORK = parseProfileName("work");
const PROFILE_PORT = 4545;
const DEFAULT_PORT = 4141;

function isolate(): string {
  dir = isolateAgentHomes("copilot-codex-profile-", { mkdirs: true }).dir;
  return join(dir, ".codex");
}

function writeProxyProfile(codexHome: string): void {
  configureCodexConfig(codexHome, {
    mode: "proxy",
    credential: COMMAND,
    profile: WORK,
    baseUrl: openaiBaseUrl(String(PROFILE_PORT)),
  });
}

function configText(codexHome: string): string {
  return readFileSync(join(codexHome, "config.toml"), "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

/** Parse-mutate-stringify a writer-produced file: real output, one drifted detail. */
function mutateToml(path: string, mutate: (doc: Record<string, unknown>) => void): string {
  const doc = asRecord(parse(readFileSync(path, "utf8")));
  mutate(doc);
  const text = stringify(doc);
  writeFileSync(path, text);
  return text;
}

function mutateConfig(codexHome: string, mutate: (doc: Record<string, unknown>) => void): string {
  return mutateToml(join(codexHome, "config.toml"), mutate);
}

function profileProvider(doc: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(doc.model_providers)["copilot-env-work"]);
}

/** The named view as the health probe reads it: config.toml plus `work.config.toml`, three-way. */
function inspectWork(
  codexHome: string,
  opts: { config?: string; port?: number; envText?: string | null; envKey?: boolean } = {},
): CodexWiringStatus {
  return inspectCodexWiring(
    opts.config ?? configText(codexHome),
    opts.envText ?? null,
    opts.port ?? PROFILE_PORT,
    opts.envKey ?? false,
    { profile: WORK, profileToml: readTextResult(codexProfileConfigPath(codexHome, WORK)) },
  );
}

test("a named write lands the selector in <name>.config.toml and no [profiles.<name>] anywhere", () => {
  // Codex >= 0.134 refuses `--profile work` while config.toml carries a [profiles.work] table, so
  // the selector's only home is the profile file, and the file carries nothing else of ours.
  const codexHome = isolate();
  const profilePath = codexProfileConfigPath(codexHome, WORK);
  writeFileSync(profilePath, stringify({ "model": "gpt-5.4-mini", "model_provider": "openai" }));
  writeProxyProfile(codexHome);

  expect(asRecord(parse(readFileSync(profilePath, "utf8")))).toEqual({
    "model": "gpt-5.4-mini",
    "model_provider": "copilot-env-work",
  });
  const config = asRecord(parse(configText(codexHome)));
  expect(config.profiles).toBeUndefined();
  expect(config.profile).toBeUndefined();
  expect(profileProvider(config).base_url).toBe(openaiBaseUrl(String(PROFILE_PORT)));

  const wiring = inspectWork(codexHome, { envText: "OPENAI_API_KEY=sk-user\n", envKey: true });
  // The token in envText and envKeyInEnviron are DEFAULT-selection facts; the named view reports
  // them false anyway.
  expect(wiring).toMatchObject({
    configExists: true,
    modelProvider: "copilot-env-work",
    providerSelected: true,
    providerMode: "proxy",
    baseUrl: openaiBaseUrl(String(PROFILE_PORT)),
    baseUrlMatches: true,
    envKeyMatches: true,
    providerWired: true,
    credential: "command",
    directUsesToken: false,
    envFilePresent: true,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
  });
});

test("an unparseable <name>.config.toml refuses the whole write: config.toml is left as it was", () => {
  const codexHome = isolate();
  configureCodexConfig(codexHome, { mode: "direct", credential: COMMAND });
  const before = configText(codexHome);
  writeFileSync(codexProfileConfigPath(codexHome, WORK), 'model_provider = "unclosed');

  expect(() => writeProxyProfile(codexHome)).toThrow(/work\.config\.toml is not valid TOML/);
  expect(configText(codexHome)).toBe(before);
});

test("removing a profile deletes its file, or only our selector when the user's keys remain", () => {
  const codexHome = isolate();
  configureCodexConfig(codexHome, { mode: "direct", credential: COMMAND });
  writeProxyProfile(codexHome);
  const profilePath = codexProfileConfigPath(codexHome, WORK);

  removeCodexProfile(codexHome, WORK);
  expect(existsSync(profilePath)).toBe(false);
  const config = asRecord(parse(configText(codexHome)));
  expect(asRecord(config.model_providers)["copilot-env-work"]).toBeUndefined();
  expect(asRecord(config.model_providers)["copilot-env"]).toBeDefined();
  expect(inspectWork(codexHome).providerMode).toBe("none");

  // A model pin of the user's keeps the file; only the selector goes.
  writeProxyProfile(codexHome);
  mutateToml(profilePath, (doc) => {
    doc.model = "gpt-5.4-mini";
  });
  removeCodexProfile(codexHome, WORK);
  expect(asRecord(parse(readFileSync(profilePath, "utf8")))).toEqual({ "model": "gpt-5.4-mini" });

  // A user-repointed selector is no longer ours: the file stays whole.
  writeProxyProfile(codexHome);
  mutateToml(profilePath, (doc) => {
    doc.model_provider = "openai";
  });
  removeCodexProfile(codexHome, WORK);
  expect(asRecord(parse(readFileSync(profilePath, "utf8")))).toEqual({
    "model": "gpt-5.4-mini",
    "model_provider": "openai",
  });
});

test("a base_url on the wrong port un-wires the proxy profile", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);

  const wiring = inspectWork(codexHome, { port: PROFILE_PORT + 1 });
  expect(wiring.providerSelected).toBe(true);
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrlMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);
});

test("a repointed <name>.config.toml selector reads unselected (other)", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  mutateToml(codexProfileConfigPath(codexHome, WORK), (doc) => {
    doc.model_provider = "openai";
  });

  const wiring = inspectWork(codexHome);
  expect(wiring.modelProvider).toBe("openai");
  expect(wiring.providerSelected).toBe(false);
  expect(wiring.providerMode).toBe("other");
  expect(wiring.providerWired).toBe(false);
});

test("foreign or missing managed proxy auth un-wires the profile", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);

  mutateConfig(codexHome, (doc) => {
    profileProvider(doc).auth = { "command": "/usr/local/bin/my-token", "args": [] };
  });
  let wiring = inspectWork(codexHome);
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrlMatches).toBe(true);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);

  // The DEFAULT selection's managed auth would route the resolver at the default daemon, not this profile's.
  mutateConfig(codexHome, (doc) => {
    const auth = proxyTokenCommand();
    profileProvider(doc).auth = { "command": auth.command, "args": auth.args };
  });
  wiring = inspectWork(codexHome);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);

  mutateConfig(codexHome, (doc) => {
    delete profileProvider(doc).auth;
  });
  wiring = inspectWork(codexHome);
  expect(wiring.providerWired).toBe(false);
});

test("an env_key never wires a named profile", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  mutateConfig(codexHome, (doc) => {
    const provider = profileProvider(doc);
    delete provider.auth;
    provider.env_key = "OPENAI_API_KEY";
  });

  // The exported token and the .env line are the default selection's facts; the named profile stays unwired.
  const wiring = inspectWork(codexHome, { envText: "OPENAI_API_KEY=sk-user\n", envKey: true });
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.tokenAvailable).toBe(false);
  expect(wiring.providerWired).toBe(false);
});

test("an env_key alongside intact managed auth still un-wires a named profile", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  // The writer strips env_key from a profile table and Codex rejects auth + env_key on one
  // provider, so a stray env_key beside intact auth is drift and must not read as wired.
  mutateConfig(codexHome, (doc) => {
    profileProvider(doc).env_key = "OPENAI_API_KEY";
  });

  const wiring = inspectWork(codexHome);
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrlMatches).toBe(true);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);

  configureCodexConfig(codexHome, { mode: "direct", credential: COMMAND, profile: WORK });
  mutateConfig(codexHome, (doc) => {
    profileProvider(doc).env_key = "OPENAI_API_KEY";
  });
  const directWiring = inspectWork(codexHome);
  expect(directWiring.providerMode).toBe("direct");
  expect(directWiring.directUsesToken).toBe(true);
  expect(directWiring.envKeyMatches).toBe(false);
  expect(directWiring.providerWired).toBe(false);
});

test("a writer-produced direct profile inspects as wired via its own auth command", () => {
  const codexHome = isolate();
  configureCodexConfig(codexHome, { mode: "direct", credential: COMMAND, profile: WORK });

  const wiring = inspectWork(codexHome);
  expect(wiring.modelProvider).toBe("copilot-env-work");
  expect(wiring.providerSelected).toBe(true);
  expect(wiring.providerMode).toBe("direct");
  expect(wiring.baseUrl).toBe("https://api.githubcopilot.com");
  expect(wiring.baseUrlMatches).toBe(true);
  expect(wiring.envKeyMatches).toBe(true);
  expect(wiring.directUsesToken).toBe(true);
  expect(wiring.credential).toBe("command");
  expect(wiring.providerWired).toBe(true);

  // The DEFAULT direct auth (`agent auth --get` without --profile) resolves the default credential;
  // a named profile hard-fails rather than fall back to it, so this must not read as wired.
  mutateConfig(codexHome, (doc) => {
    const auth = asRecord(profileProvider(doc).auth);
    auth.args = ["auth", "--get"];
  });
  const driftedWiring = inspectWork(codexHome);
  expect(driftedWiring.providerMode).toBe("direct");
  expect(driftedWiring.directUsesToken).toBe(false);
  expect(driftedWiring.providerWired).toBe(false);

  mutateConfig(codexHome, (doc) => {
    delete profileProvider(doc).auth;
  });
  const authlessWiring = inspectWork(codexHome);
  expect(authlessWiring.directUsesToken).toBe(false);
  expect(authlessWiring.providerWired).toBe(false);
});

test("a static named profile inspects as wired through its baked bearer, proxy and direct", () => {
  const codexHome = isolate();
  const STATIC = { kind: "static", token: "cpk_baked_token" } as const;
  configureCodexConfig(codexHome, {
    mode: "proxy",
    credential: STATIC,
    profile: WORK,
    baseUrl: openaiBaseUrl(String(PROFILE_PORT)),
  });

  // The profile-addressed table carries the bearer and no resolver command.
  const table = profileProvider(asRecord(parse(configText(codexHome))));
  expect(table.auth).toBeUndefined();
  expect(asRecord(table.http_headers).Authorization).toBe(`Bearer ${STATIC.token}`);
  const proxyWiring = inspectWork(codexHome);
  expect(proxyWiring.modelProvider).toBe("copilot-env-work");
  expect(proxyWiring.providerMode).toBe("proxy");
  expect(proxyWiring.credential).toBe("static");
  expect(proxyWiring.envKeyMatches).toBe(true);
  expect(proxyWiring.providerWired).toBe(true);

  configureCodexConfig(codexHome, { mode: "direct", credential: STATIC, profile: WORK });
  const directWiring = inspectWork(codexHome);
  expect(directWiring.providerMode).toBe("direct");
  expect(directWiring.credential).toBe("static");
  expect(directWiring.directUsesToken).toBe(false);
  expect(directWiring.providerWired).toBe(true);
});

test("default and profile wiring coexist; each view reads only its own selection", () => {
  const codexHome = isolate();
  configureCodexConfig(codexHome, { mode: "direct", credential: COMMAND });
  writeProxyProfile(codexHome);

  const defaultWiring = inspectCodexWiring(configText(codexHome), null, DEFAULT_PORT, false);
  expect(defaultWiring.modelProvider).toBe("copilot-env");
  expect(defaultWiring.providerMode).toBe("direct");
  expect(defaultWiring.baseUrl).toBe("https://api.githubcopilot.com");
  expect(defaultWiring.directUsesToken).toBe(true);
  expect(defaultWiring.providerWired).toBe(true);

  // The profile view reads its own file and table only; the default's port and mode play no part.
  const profileWiring = inspectWork(codexHome);
  expect(profileWiring.modelProvider).toBe("copilot-env-work");
  expect(profileWiring.providerMode).toBe("proxy");
  expect(profileWiring.baseUrlMatches).toBe(true);
  expect(profileWiring.providerWired).toBe(true);
});

test("a profile-only config leaves the default view unconfigured", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);

  // The named write seeds no top-level selection (it even scrubs the template's).
  const defaultWiring = inspectCodexWiring(configText(codexHome), null, DEFAULT_PORT, false);
  expect(defaultWiring.modelProvider).toBeNull();
  expect(defaultWiring.providerMode).toBe("none");
  expect(defaultWiring.providerSelected).toBe(false);
  expect(defaultWiring.providerWired).toBe(false);
});

test("no <name>.config.toml, or one without a selector, reads as none for the named view", () => {
  const codexHome = isolate();
  configureCodexConfig(codexHome, { mode: "direct", credential: COMMAND });

  // `codex --profile work` would then run on config.toml alone (the DEFAULT credential), which a
  // named profile must never read as its own wiring.
  for (const seed of [null, stringify({ "model": "gpt-5.4-mini" })]) {
    if (seed !== null) writeFileSync(codexProfileConfigPath(codexHome, WORK), seed);
    const wiring = inspectWork(codexHome);
    expect(wiring, seed ?? "absent").toMatchObject({
      configExists: true,
      modelProvider: null,
      providerSelected: false,
      providerMode: "none",
      providerWired: false,
    });
  }
});

test("an absent config reads fully unwired for the named view", () => {
  const absent = inspectCodexWiring(null, null, PROFILE_PORT, false, {
    profile: WORK,
    profileToml: { kind: "absent" },
  });
  expect(absent.configExists).toBe(false);
  expect(absent.modelProvider).toBeNull();
  expect(absent.providerMode).toBe("none");
  expect(absent.providerSelected).toBe(false);
  expect(absent.providerWired).toBe(false);
  expect(absent.tokenAvailable).toBe(false);
});

test("a selector for a DIFFERENT profile never selects this one", () => {
  const codexHome = isolate();
  const other = parseProfileName("other");
  configureCodexConfig(codexHome, {
    mode: "proxy",
    credential: COMMAND,
    profile: other,
    baseUrl: openaiBaseUrl(String(PROFILE_PORT)),
  });

  const wiring = inspectWork(codexHome);
  expect(wiring.modelProvider).toBeNull();
  expect(wiring.providerSelected).toBe(false);
  expect(wiring.providerMode).toBe("none");
  expect(wiring.providerWired).toBe(false);
});

test("a selected profile whose provider table is absent reads unwired, not a false positive", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  mutateConfig(codexHome, (doc) => {
    delete asRecord(doc.model_providers)["copilot-env-work"];
  });

  const wiring = inspectWork(codexHome);
  expect(wiring.providerSelected).toBe(true);
  // A selected but unrecognized table shape still reads as proxy, so the message names what is off.
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrl).toBeNull();
  expect(wiring.baseUrlMatches).toBe(false);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);

  mutateConfig(codexHome, (doc) => {
    asRecord(doc.model_providers)["copilot-env-work"] = "not-a-table";
  });
  const scalarWiring = inspectWork(codexHome);
  expect(scalarWiring.providerSelected).toBe(true);
  expect(scalarWiring.providerMode).toBe("proxy");
  expect(scalarWiring.providerWired).toBe(false);
});

test("malformed TOML in either file reads other for the named view, naming the file, never none", () => {
  // "none" would authorize a best-effort caller to write over a config it could not parse; the
  // writer's refuse-to-overwrite guard is the second layer of the same decision. The reason says
  // WHICH file, so the repair points at it.
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  const configBroken = inspectWork(codexHome, { config: 'model_provider = "unclosed' });
  expect(configBroken).toMatchObject({
    configExists: true,
    modelProvider: null,
    providerMode: "other",
    otherReason: "malformed",
    providerSelected: false,
    providerWired: false,
    tokenAvailable: false,
  });

  writeFileSync(codexProfileConfigPath(codexHome, WORK), 'model_provider = "unclosed');
  expect(inspectWork(codexHome)).toMatchObject({
    providerMode: "other",
    otherReason: "profile-malformed",
    providerWired: false,
  });
  const unreadable = inspectCodexWiring(configText(codexHome), null, PROFILE_PORT, false, {
    profile: WORK,
    profileToml: { kind: "unreadable", error: "EACCES" },
  });
  expect(unreadable).toMatchObject({ providerMode: "other", otherReason: "profile-read-error" });
  // With no config.toml at all the broken profile file still names itself: `agent profile --add`
  // would refuse it, so "no config, re-add" is the wrong repair.
  const noConfig = inspectCodexWiring(null, null, PROFILE_PORT, false, {
    profile: WORK,
    profileToml: { kind: "text", text: 'model_provider = "unclosed' },
  });
  expect(noConfig).toMatchObject({
    providerMode: "other",
    otherReason: "profile-malformed",
    configExists: false,
  });
});

test("a script-shaped auth on a named profile's table never reads wired", () => {
  // The 3.5.6 shape (the src/scripts resolver script): a table the migration never reached is
  // unwired, addressed at this profile or not.
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  mutateConfig(codexHome, (doc) => {
    profileProvider(doc).auth = {
      "command": "/bin/sh",
      "args": ["/r/src/scripts/proxy-token.sh", "--yes", "--profile", WORK],
    };
  });
  const wiring = inspectWork(codexHome);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);
});

// --- the installed Codex -----------------------------------------------------------

/** Skips where no codex is installed; `codex --profile <name> mcp list` loads the config (and the
 *  profile file) without a model call or a credential, so it is the cheapest "does Codex accept
 *  what the writer produced" probe. Resolved ONCE, here: isolate() swaps HOME, under which an
 *  nvm-installed codex no longer resolves. */
const CODEX_PATH = resolveCommand("codex");
const liveCodex = test.skipIf(CODEX_PATH === null);

liveCodex("the installed Codex starts `--profile work` on a writer-produced named profile", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  const codexPath = CODEX_PATH ?? "";
  const run = (home: string) => {
    const s = cliSpawn(codexPath, ["--profile", WORK, "mcp", "list"]);
    const cliDir = dirname(codexPath);
    return runSync(s.file, s.args, {
      cwd: home,
      env: childEnvWithPath([cliDir === "." ? null : cliDir], { extra: { CODEX_HOME: home } }),
      timeoutMs: 60_000,
      shell: s.shell,
    });
  };
  const accepted = run(codexHome);
  expect(accepted.exitCode, accepted.stderr).toBe(0);

  // Negative control: the same selector as a [profiles.work] table is what Codex refuses, so a
  // Codex that accepted both would make the positive run prove nothing.
  mutateConfig(codexHome, (doc) => {
    doc.profiles = { work: { "model_provider": "copilot-env-work" } };
  });
  const refused = run(codexHome);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr).toContain("work.config.toml");
});
