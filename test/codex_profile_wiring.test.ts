// inspectCodexWiring's named-profile view: the selection fact is Codex's native
// `[profiles.<name>].model_provider` pointing at `[model_providers.copilot-env-<name>]`,
// and key resolution is the managed auth.command alone (the writer never emits an
// env_key for a named profile, so the OPENAI_API_KEY facts read false). Fixtures are
// built via configureCodexConfig where practical, so inspection is tested against the
// real write output; the drift cases are hand-mutated copies of that output.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { configureCodexConfig, inspectCodexWiring } from "../src/codex/config.ts";
import { openaiBaseUrl } from "../src/copilot_api/port.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { PROJECT_ROOT, proxyTokenCommand } from "../src/utils/root.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, removeDir } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

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
    profile: WORK,
    quiet: true,
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

/** Parse-mutate-stringify a writer-produced config: real output, one drifted detail. */
function mutateConfig(codexHome: string, mutate: (doc: Record<string, unknown>) => void): string {
  const doc = asRecord(parse(configText(codexHome)));
  mutate(doc);
  const text = stringify(doc);
  writeFileSync(join(codexHome, "config.toml"), text);
  return text;
}

function profileProvider(doc: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(doc.model_providers)["copilot-env-work"]);
}

test("a writer-produced proxy profile inspects as wired; token facts stay off", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);

  // envText carries the token and envKeyInEnviron is passed true: both are
  // DEFAULT-selection facts, so the named view must report them false anyway.
  const wiring = inspectCodexWiring(
    configText(codexHome),
    "OPENAI_API_KEY=sk-user\n",
    PROFILE_PORT,
    true,
    WORK,
  );
  expect(wiring.configExists).toBe(true);
  expect(wiring.modelProvider).toBe("copilot-env-work");
  expect(wiring.providerSelected).toBe(true);
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrl).toBe(openaiBaseUrl(String(PROFILE_PORT)));
  expect(wiring.baseUrlMatches).toBe(true);
  expect(wiring.envKeyMatches).toBe(true);
  expect(wiring.providerWired).toBe(true);
  expect(wiring.directUsesToken).toBe(false);
  expect(wiring.envFilePresent).toBe(true);
  expect(wiring.envKeyInDotenv).toBe(false);
  expect(wiring.envKeyInEnviron).toBe(false);
  expect(wiring.tokenAvailable).toBe(false);
});

test("a base_url on the wrong port un-wires the proxy profile", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);

  const wiring = inspectCodexWiring(configText(codexHome), null, PROFILE_PORT + 1, false, WORK);
  expect(wiring.providerSelected).toBe(true);
  // A selected-but-unrecognized table shape still reads as proxy for messaging.
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrlMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);
});

test("a repointed [profiles.<name>] selector reads unselected (other)", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  const text = mutateConfig(codexHome, (doc) => {
    asRecord(asRecord(doc.profiles).work).model_provider = "openai";
  });

  const wiring = inspectCodexWiring(text, null, PROFILE_PORT, false, WORK);
  expect(wiring.modelProvider).toBe("openai");
  expect(wiring.providerSelected).toBe(false);
  expect(wiring.providerMode).toBe("other");
  expect(wiring.providerWired).toBe(false);
});

test("foreign or missing managed proxy auth un-wires the profile", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);

  // A foreign auth.command in an otherwise perfect table.
  let text = mutateConfig(codexHome, (doc) => {
    profileProvider(doc).auth = { "command": "/usr/local/bin/my-token", "args": [] };
  });
  let wiring = inspectCodexWiring(text, null, PROFILE_PORT, false, WORK);
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrlMatches).toBe(true);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);

  // The DEFAULT selection's managed auth (no --profile) is NOT the profile's:
  // it would route the resolver at the default daemon, not this profile's.
  text = mutateConfig(codexHome, (doc) => {
    const auth = proxyTokenCommand();
    profileProvider(doc).auth = { "command": auth.command, "args": auth.args };
  });
  wiring = inspectCodexWiring(text, null, PROFILE_PORT, false, WORK);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);

  // No auth block at all.
  text = mutateConfig(codexHome, (doc) => {
    delete profileProvider(doc).auth;
  });
  wiring = inspectCodexWiring(text, null, PROFILE_PORT, false, WORK);
  expect(wiring.providerWired).toBe(false);
});

test("a legacy env_key never wires a named profile (default-only back-compat)", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  const text = mutateConfig(codexHome, (doc) => {
    const provider = profileProvider(doc);
    delete provider.auth;
    provider.env_key = "OPENAI_API_KEY";
  });

  // Even with the token exported AND in .env: those facts are the default
  // selection's, so the named profile stays unwired.
  const wiring = inspectCodexWiring(text, "OPENAI_API_KEY=sk-user\n", PROFILE_PORT, true, WORK);
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.tokenAvailable).toBe(false);
  expect(wiring.providerWired).toBe(false);
});

test("an env_key alongside intact managed auth still un-wires a named profile", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  // The managed auth block stays byte-identical; only a stray env_key appears.
  // The writer strips env_key from a profile table and Codex rejects auth +
  // env_key on one provider, so this drift must not read as wired.
  const text = mutateConfig(codexHome, (doc) => {
    profileProvider(doc).env_key = "OPENAI_API_KEY";
  });

  const wiring = inspectCodexWiring(text, null, PROFILE_PORT, false, WORK);
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrlMatches).toBe(true);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);

  // Same on a direct-mode profile table.
  configureCodexConfig(codexHome, { mode: "direct", profile: WORK, quiet: true });
  const directText = mutateConfig(codexHome, (doc) => {
    profileProvider(doc).env_key = "OPENAI_API_KEY";
  });
  const directWiring = inspectCodexWiring(directText, null, PROFILE_PORT, false, WORK);
  expect(directWiring.providerMode).toBe("direct");
  expect(directWiring.directUsesToken).toBe(true);
  expect(directWiring.envKeyMatches).toBe(false);
  expect(directWiring.providerWired).toBe(false);
});

test("a writer-produced direct profile inspects as wired via its own auth command", () => {
  const codexHome = isolate();
  configureCodexConfig(codexHome, { mode: "direct", profile: WORK, quiet: true });

  const wiring = inspectCodexWiring(configText(codexHome), null, PROFILE_PORT, false, WORK);
  expect(wiring.modelProvider).toBe("copilot-env-work");
  expect(wiring.providerSelected).toBe(true);
  expect(wiring.providerMode).toBe("direct");
  expect(wiring.baseUrl).toBe("https://api.githubcopilot.com");
  expect(wiring.baseUrlMatches).toBe(true);
  expect(wiring.envKeyMatches).toBe(true);
  expect(wiring.directUsesToken).toBe(true);
  expect(wiring.providerWired).toBe(true);

  // The DEFAULT direct auth (`agent auth --get` without --profile) resolves the
  // default credential, not the profile's -- it must not read as the profile's,
  // and a named direct profile is only wired through ITS OWN managed auth
  // (named profiles hard-fail, never fall back to the default credential).
  const drifted = mutateConfig(codexHome, (doc) => {
    const auth = asRecord(profileProvider(doc).auth);
    auth.args = ["auth", "--get"];
  });
  const driftedWiring = inspectCodexWiring(drifted, null, PROFILE_PORT, false, WORK);
  expect(driftedWiring.providerMode).toBe("direct");
  expect(driftedWiring.directUsesToken).toBe(false);
  expect(driftedWiring.providerWired).toBe(false);

  // Same with the auth block missing entirely.
  const authless = mutateConfig(codexHome, (doc) => {
    delete profileProvider(doc).auth;
  });
  const authlessWiring = inspectCodexWiring(authless, null, PROFILE_PORT, false, WORK);
  expect(authlessWiring.directUsesToken).toBe(false);
  expect(authlessWiring.providerWired).toBe(false);
});

test("default and profile wiring coexist; each view reads only its own selection", () => {
  const codexHome = isolate();
  configureCodexConfig(codexHome, { mode: "direct", quiet: true });
  writeProxyProfile(codexHome);

  // The default view (existing 4-arg call shape, untouched by this refactor)
  // still reads the top-level selection only.
  const defaultWiring = inspectCodexWiring(configText(codexHome), null, DEFAULT_PORT, false);
  expect(defaultWiring.modelProvider).toBe("copilot-env");
  expect(defaultWiring.providerMode).toBe("direct");
  expect(defaultWiring.baseUrl).toBe("https://api.githubcopilot.com");
  expect(defaultWiring.directUsesToken).toBe(true);
  expect(defaultWiring.providerWired).toBe(true);

  // The profile view reads its own tables only -- the default's port/mode play no part.
  const profileWiring = inspectCodexWiring(configText(codexHome), null, PROFILE_PORT, false, WORK);
  expect(profileWiring.modelProvider).toBe("copilot-env-work");
  expect(profileWiring.providerMode).toBe("proxy");
  expect(profileWiring.baseUrlMatches).toBe(true);
  expect(profileWiring.providerWired).toBe(true);
});

test("a profile-only config leaves the default view unconfigured", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);

  // The named write seeds no top-level selection (it even scrubs the template's),
  // so the default view must read none while the profile view reads wired.
  const defaultWiring = inspectCodexWiring(configText(codexHome), null, DEFAULT_PORT, false);
  expect(defaultWiring.modelProvider).toBeNull();
  expect(defaultWiring.providerMode).toBe("none");
  expect(defaultWiring.providerSelected).toBe(false);
  expect(defaultWiring.providerWired).toBe(false);
});

test("profile tables absent entirely read as none for the named view", () => {
  const codexHome = isolate();
  configureCodexConfig(codexHome, { mode: "direct", quiet: true });

  const wiring = inspectCodexWiring(configText(codexHome), null, PROFILE_PORT, false, WORK);
  expect(wiring.configExists).toBe(true);
  expect(wiring.modelProvider).toBeNull();
  expect(wiring.providerSelected).toBe(false);
  expect(wiring.providerMode).toBe("none");
  expect(wiring.providerWired).toBe(false);
});

test("an absent config reads fully unwired for the named view", () => {
  const wiring = inspectCodexWiring(null, null, PROFILE_PORT, false, WORK);
  expect(wiring.configExists).toBe(false);
  expect(wiring.modelProvider).toBeNull();
  expect(wiring.providerMode).toBe("none");
  expect(wiring.providerSelected).toBe(false);
  expect(wiring.providerWired).toBe(false);
  expect(wiring.tokenAvailable).toBe(false);
});

test("a selector for a DIFFERENT profile never selects this one", () => {
  const codexHome = isolate();
  const other = parseProfileName("other");
  configureCodexConfig(codexHome, {
    mode: "proxy",
    profile: other,
    quiet: true,
    baseUrl: openaiBaseUrl(String(PROFILE_PORT)),
  });

  const wiring = inspectCodexWiring(configText(codexHome), null, PROFILE_PORT, false, WORK);
  expect(wiring.modelProvider).toBeNull();
  expect(wiring.providerSelected).toBe(false);
  expect(wiring.providerMode).toBe("none");
  expect(wiring.providerWired).toBe(false);
});

test("a selected profile whose provider table is absent reads unwired, not a false positive", () => {
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  const text = mutateConfig(codexHome, (doc) => {
    delete asRecord(doc.model_providers)["copilot-env-work"];
  });

  const wiring = inspectCodexWiring(text, null, PROFILE_PORT, false, WORK);
  expect(wiring.providerSelected).toBe(true);
  // Selected but unrecognized table shape reads as proxy for messaging, with
  // every wiring fact off.
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.baseUrl).toBeNull();
  expect(wiring.baseUrlMatches).toBe(false);
  expect(wiring.envKeyMatches).toBe(false);
  expect(wiring.providerWired).toBe(false);

  // A non-record table (a scalar where the table should be) degrades the same way.
  const scalar = mutateConfig(codexHome, (doc) => {
    asRecord(doc.model_providers)["copilot-env-work"] = "not-a-table";
  });
  const scalarWiring = inspectCodexWiring(scalar, null, PROFILE_PORT, false, WORK);
  expect(scalarWiring.providerSelected).toBe(true);
  expect(scalarWiring.providerMode).toBe("proxy");
  expect(scalarWiring.providerWired).toBe(false);
});

test("malformed TOML reads unwired for the named view too", () => {
  const wiring = inspectCodexWiring('model_provider = "unclosed', null, PROFILE_PORT, false, WORK);
  expect(wiring.configExists).toBe(true);
  expect(wiring.modelProvider).toBeNull();
  expect(wiring.providerMode).toBe("none");
  expect(wiring.providerSelected).toBe(false);
  expect(wiring.providerWired).toBe(false);
  expect(wiring.tokenAvailable).toBe(false);
});

test("legacy script-shaped auth addressed at THIS profile still reads wired (tolerance)", () => {
  // A named profile wired by a pre-`agent proxy-token` release: its auth block execs
  // the src/scripts resolver with `--profile <name>`. The tolerance is profile-aware --
  // the same legacy shape addressed at the DEFAULT daemon must stay unwired here
  // (a mis-addressed resolver would serve the wrong daemon's key).
  const codexHome = isolate();
  writeProxyProfile(codexHome);
  const legacyScript = join(
    PROJECT_ROOT,
    "src",
    "scripts",
    process.platform === "win32" ? "proxy-token.ps1" : "proxy-token.sh",
  );
  const legacyAuth = (scoped: boolean) => ({
    "command": process.platform === "win32" ? "powershell" : "/bin/sh",
    "args": [
      ...(process.platform === "win32"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
        : []),
      legacyScript,
      "--yes",
      ...(scoped ? ["--profile", WORK] : []),
    ],
  });

  let text = mutateConfig(codexHome, (doc) => {
    profileProvider(doc).auth = legacyAuth(true);
  });
  let wiring = inspectCodexWiring(text, null, PROFILE_PORT, false, WORK);
  expect(wiring.envKeyMatches).toBe(true);
  expect(wiring.providerWired).toBe(true);

  text = mutateConfig(codexHome, (doc) => {
    profileProvider(doc).auth = legacyAuth(false); // default-addressed: not this profile's
  });
  wiring = inspectCodexWiring(text, null, PROFILE_PORT, false, WORK);
  expect(wiring.providerWired).toBe(false);
});
