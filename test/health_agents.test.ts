// The agent-wiring checks (src/health/checks_agents.ts): Codex and Claude against their
// gathered facts, the per-host CODEX_HOME farm, the Claude Desktop library, and the
// `--live` end-to-end verdicts. The environment/runtime checks and the fact gatherer are
// pinned in health.test.ts; named-profile behaviour in health_profiles.test.ts.
import { join } from "node:path";
import type { ClaudeDesktopStatus } from "../src/claude/desktop_status.ts";
import { type CodexHostDrift, codexHostDriftLine } from "../src/codex/host.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import {
  checkClaude,
  checkClaudeDesktop,
  checkClaudeLive,
  checkCodex,
  checkCodexHost,
  checkCodexLive,
} from "../src/health/checks_agents.ts";
import type { ClaudeFacts, CodexFacts, CodexHostFacts } from "../src/health/facts.ts";
import { expect, test } from "./helpers/testing.ts";

// --- codex wiring -----------------------------------------------------------

test("codex: not configured is ok; each broken part warns with a precise message", () => {
  // Shared non-wiring facts; `satisfies` keeps the literal arms narrow so the
  // spreads below stay inside the discriminated union's proxy/direct variants.
  const codexExtras = {
    home: "/c",
    directAuth: { command: "/bin/gh", authenticated: true },
    directUsesToken: false,
    directNeedsNoGh: false,
    provider: "gh-cli",
    otherReason: null,
  } as const;
  const wired = {
    ...codexExtras,
    configExists: true,
    providerSelected: true,
    providerMode: "proxy",
    modelProvider: "copilot-env",
    baseUrl: "http://localhost:4141/v1",
    baseUrlMatches: true,
    envKeyMatches: true,
    providerWired: true,
    envFilePresent: true,
    envKeyInDotenv: true,
    envKeyInEnviron: false,
    tokenAvailable: true,
  } satisfies CodexFacts;
  // No config at all -> ok (user never wired Codex): the "none" arm.
  expect(
    checkCodex({
      ...wired,
      providerMode: "none",
      configExists: false,
      modelProvider: null,
      providerSelected: false,
      baseUrl: null,
      baseUrlMatches: false,
      envKeyMatches: false,
      providerWired: false,
    }).status,
  ).toBe("ok");
  // Fully wired -> ok, multi-line detail: wiring, proxy, then the auth.command resolver.
  const ok = checkCodex(wired);
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("copilot-env");
  expect(ok.detail).toContain("4141");
  expect(ok.detail).toContain("provider: proxy");
  expect(ok.detail.split("\n")).toHaveLength(4);
  expect(ok.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  expect(ok.detail).toContain("proxy-token resolver");
  // A foreign model_provider selected: the "other" arm.
  const foreign = {
    ...wired,
    providerMode: "other",
    modelProvider: "openai",
    providerSelected: false,
    baseUrl: null,
    baseUrlMatches: false,
    envKeyMatches: false,
    providerWired: false,
    otherReason: "custom",
  } satisfies CodexFacts;
  expect(checkCodex(foreign).detail).toContain("model_provider");
  expect(checkCodex(foreign).detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  // The classifier's reason travels into the --json value on every arm.
  expect(checkCodex(foreign).value?.otherReason).toBe("custom");
  expect(ok.value?.otherReason).toBe(null);
  // A config.toml the writers REFUSE (malformed/read-error) gets the repair fix,
  // never the generic `agent codex --proxy` re-wire that cannot land.
  const malformed = checkCodex({ ...foreign, modelProvider: null, otherReason: "malformed" });
  expect(malformed.status).toBe("warn");
  expect(malformed.detail).toContain("not valid TOML");
  expect(malformed.detail).toContain("provider: other");
  expect(malformed.fix).toBe(`repair ${join("/c", "config.toml")}, then re-run \`agent codex\``);
  expect(malformed.value?.otherReason).toBe("malformed");
  const unreadable = checkCodex({ ...foreign, modelProvider: null, otherReason: "read-error" });
  expect(unreadable.status).toBe("warn");
  expect(unreadable.detail).toContain("could not be read");
  expect(unreadable.fix).toBe(`repair ${join("/c", "config.toml")}, then re-run \`agent codex\``);
  // A named profile's repair re-runs its atomic re-add instead of `agent codex`.
  const namedMalformed = checkCodex(
    { ...foreign, modelProvider: null, otherReason: "malformed" },
    parseProfileName("work"),
  );
  expect(namedMalformed.status).toBe("warn");
  expect(namedMalformed.fix).toBe(
    `repair ${join("/c", "config.toml")}, then re-run \`agent profile --add work\``,
  );
  // base_url points at the wrong port.
  expect(
    checkCodex({
      ...wired,
      baseUrl: "http://localhost:9999/v1",
      baseUrlMatches: false,
      providerWired: false,
    }).detail,
  ).toContain("base_url");
  expect(
    checkCodex({
      ...wired,
      baseUrl: "http://localhost:9999/v1",
      baseUrlMatches: false,
      providerWired: false,
    }).detail,
  ).toContain(`config.toml: ${join("/c", "config.toml")}`);
  // Not fully wired (e.g. the managed proxy auth.command is missing/foreign).
  const notWired = checkCodex({ ...wired, providerWired: false });
  expect(notWired.status).toBe("warn");
  expect(notWired.detail).toContain("not fully wired");
  expect(notWired.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);
  // A wired proxy is ok regardless of any env token (the key comes from auth.command).
  const noEnvToken = checkCodex({ ...wired, envKeyInDotenv: false, tokenAvailable: false });
  expect(noEnvToken.status).toBe("ok");
  expect(noEnvToken.detail).toContain("proxy-token resolver");

  const direct = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
  });
  expect(direct.status).toBe("ok");
  expect(direct.detail).toContain("provider: direct");
  expect(direct.detail).toContain("gh auth: authenticated via /bin/gh");
  expect(direct.detail).toContain(`config.toml: ${join("/c", "config.toml")}`);

  const directMissingGh = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    directAuth: { command: null, authenticated: false },
  });
  expect(directMissingGh.status).toBe("warn");
  expect(directMissingGh.detail).toContain("GitHub CLI not found");
  expect(directMissingGh.fix).toBe("install gh and run gh auth login");

  const directUnauthed = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    directAuth: { command: "/bin/gh", authenticated: false },
  });
  expect(directUnauthed.status).toBe("warn");
  expect(directUnauthed.detail).toContain("not authenticated");
  expect(directUnauthed.fix).toBe("gh auth login");

  // A PINNED slot's verdict names its account: the probe ran `gh auth token
  // --user work-bot`, so "not authenticated" is about that account, not gh's
  // active one (which may be fine).
  const directPinnedUnauthed = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    directAuth: { command: "/bin/gh", authenticated: false, ghUser: "work-bot" },
  });
  expect(directPinnedUnauthed.status).toBe("warn");
  expect(directPinnedUnauthed.detail).toContain(
    "gh auth: /bin/gh is not authenticated as account 'work-bot'",
  );
  expect(directPinnedUnauthed.fix).toBe("gh auth login");

  // An AUTO slot's ok line names the account it follows (no hidden information).
  const directAutoNamed = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    directAuth: { command: "/bin/gh", authenticated: true, ghActiveLogin: "vivswan" },
  });
  expect(directAutoNamed.status).toBe("ok");
  expect(directAutoNamed.detail).toContain(
    "gh auth: authenticated via /bin/gh (active account vivswan)",
  );

  // Non-gh-cli provider (or none) with no stored token: gh is NOT a fallback, so
  // a managed Direct config that doesn't resolve warns and points at `agent auth`
  // (NOT the gh-specific message). Guards against the provider-blind false-OK.
  const directNoCred = checkCodex({
    ...wired,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    envKeyMatches: false,
    tokenAvailable: false,
    provider: "copilot",
    directUsesToken: false,
    directAuth: { command: "/bin/gh", authenticated: true },
  });
  expect(directNoCred.status).toBe("warn");
  expect(directNoCred.detail).toContain("no credential resolves");
  expect(directNoCred.detail).not.toContain("gh auth:");
  expect(directNoCred.fix).toBe("agent auth");
});

test("checkCodex/checkClaude direct: an UNPROVEN gh probe says could-not-check, never a confident verdict", () => {
  const codexDirect = {
    home: "/c",
    configExists: true,
    providerSelected: true,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: true,
    envKeyMatches: false,
    providerWired: true,
    envFilePresent: false,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    otherReason: null,
    directUsesToken: false,
    directNeedsNoGh: false,
    provider: "gh-cli",
    directAuth: { command: "/bin/gh", authenticated: false, unproven: true },
  } satisfies CodexFacts;
  // `gh auth token` spawned but never completed (error / timeout kill).
  const codexUnproven = checkCodex(codexDirect);
  expect(codexUnproven.status).toBe("warn");
  expect(codexUnproven.detail).toContain(
    "gh auth: could not check gh authentication (`gh auth token` did not run to completion)",
  );
  expect(codexUnproven.detail).not.toContain("is not authenticated");
  expect(codexUnproven.fix).toBe("re-run `agent health` (the gh check did not run to completion)");
  // The gh LOOKUP itself failed to run: not a proven "GitHub CLI not found".
  const lookupUnproven = checkCodex({
    ...codexDirect,
    directAuth: { command: null, authenticated: false, unproven: true },
  });
  expect(lookupUnproven.status).toBe("warn");
  expect(lookupUnproven.detail).toContain(
    "gh auth: could not check for the GitHub CLI (the command probe failed to run)",
  );
  expect(lookupUnproven.detail).not.toContain("not found");
  expect(lookupUnproven.fix).toBe(
    "re-run `agent health` (the gh check did not run to completion)",
  );
  // Same shared verdict on the Claude side.
  const claudeUnproven = checkClaude({
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings.json"),
    settingsExists: true,
    wired: true,
    helperPath: join("/h/.claude", "copilot-token.sh"),
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: false,
    providerMode: "direct",
    otherReason: null,
    directAuth: { command: "/bin/gh", authenticated: false, unproven: true },
    directUsesToken: false,
    provider: "gh-cli",
  });
  expect(claudeUnproven.status).toBe("warn");
  expect(claudeUnproven.detail).toContain(
    "gh auth: could not check gh authentication (`gh auth token` did not run to completion)",
  );
  expect(claudeUnproven.detail).not.toContain("is not authenticated");
  expect(claudeUnproven.fix).toBe("re-run `agent health` (the gh check did not run to completion)");
});

// --- claude wiring ----------------------------------------------------------

test("checkClaude: direct needs gh + managed base URL; proxy/none/other informational", () => {
  // `satisfies` keeps the literal arm narrow so spreads stay in the union.
  const direct = {
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings.json"),
    settingsExists: true,
    wired: true,
    helperPath: join("/h/.claude", "copilot-token.sh"),
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: false,
    providerMode: "direct",
    otherReason: null,
    directAuth: { command: "/bin/gh", authenticated: true },
    directUsesToken: false,
    provider: "gh-cli",
  } satisfies ClaudeFacts;
  const directOk = checkClaude(direct);
  expect(directOk.status).toBe("ok");
  expect(directOk.detail).toContain("provider: direct");
  expect(directOk.detail).toContain("ANTHROPIC_BASE_URL → https://api.githubcopilot.com");
  expect(directOk.detail).toContain("authenticated via /bin/gh");

  const missingGh = checkClaude({ ...direct, directAuth: { command: null, authenticated: false } });
  expect(missingGh.status).toBe("warn");
  expect(missingGh.detail).toContain("GitHub CLI not found");
  expect(missingGh.fix).toBe("install gh and run gh auth login");

  const unauthed = checkClaude({
    ...direct,
    directAuth: { command: "/bin/gh", authenticated: false },
  });
  expect(unauthed.status).toBe("warn");
  expect(unauthed.detail).toContain("not authenticated");
  expect(unauthed.fix).toBe("gh auth login");

  // Non-gh-cli provider with no stored token: gh is NOT a fallback -- warn pointing
  // at `agent auth`, not the gh-specific message.
  const noCred = checkClaude({ ...direct, provider: "copilot", directUsesToken: false });
  expect(noCred.status).toBe("warn");
  expect(noCred.detail).toContain("no credential resolves");
  expect(noCred.detail).not.toContain("gh auth:");
  expect(noCred.fix).toBe("agent auth");

  // Direct helper present but the managed base URL was dropped/altered: warn.
  const staleBase = checkClaude({ ...direct, baseUrl: null });
  expect(staleBase.status).toBe("warn");
  expect(staleBase.detail).toContain("(missing)");
  expect(staleBase.fix).toBe("agent claude --direct");

  // Proxy: proxy-backed via settings.json (localhost base URL matching the resolved port).
  const proxy = checkClaude({
    ...direct,
    helperPath: join("/h/.claude", "copilot-proxy-token.sh"),
    baseUrl: "http://localhost:4141",
    baseUrlMatches: true,
    providerMode: "proxy",
    directAuth: { command: null, authenticated: false },
  });
  expect(proxy.status).toBe("ok");
  expect(proxy.detail).toContain("provider: proxy");
  expect(proxy.detail).toContain("ANTHROPIC_BASE_URL → http://localhost:4141");
  expect(proxy.detail).toContain("apiKeyHelper → ");

  // Proxy but the base URL points at the WRONG port (stale after `config port` changed):
  // must warn, not read green, with a repoint fix.
  const proxyStale = checkClaude({
    ...direct,
    helperPath: join("/h/.claude", "copilot-proxy-token.sh"),
    baseUrl: "http://localhost:4141",
    baseUrlMatches: false,
    providerMode: "proxy",
    directAuth: { command: null, authenticated: false },
  });
  expect(proxyStale.status).toBe("warn");
  expect(proxyStale.detail).toContain("does not match the resolved proxy port");
  // The fix names the deterministic proxy rewire (the bare commands auto-detect
  // a mode, which is not guaranteed to re-bake the proxy wiring).
  expect(proxyStale.fix).toContain("agent claude --proxy");

  // Never configured: informational; cl defaults it to the proxy.
  const none = checkClaude({
    ...direct,
    wired: false,
    settingsExists: false,
    helperPath: null,
    baseUrl: null,
    providerMode: "none",
    directAuth: { command: null, authenticated: false },
  });
  expect(none.status).toBe("ok");
  expect(none.detail).toContain("provider: none");
  expect(none.detail).toContain("not configured");

  // Custom apiKeyHelper the user set -- left alone, reported informationally.
  const other = checkClaude({
    ...direct,
    wired: false,
    helperPath: "/opt/x/helper.sh",
    baseUrl: null,
    providerMode: "other",
    otherReason: "custom",
  });
  expect(other.status).toBe("ok");
  expect(other.detail).toContain("provider: other");
  expect(other.detail).toContain("not managed");

  // A file that could not be parsed or read warns too: Claude itself will trip
  // over it, and copilot-env can verify nothing there.
  const malformed = checkClaude({
    ...direct,
    wired: false,
    helperPath: null,
    baseUrl: null,
    providerMode: "other",
    otherReason: "malformed",
  });
  expect(malformed.status).toBe("warn");
  expect(malformed.detail).toContain("not valid JSON");
  expect(malformed.fix).toContain("repair");
  const unreadable = checkClaude({
    ...direct,
    wired: false,
    helperPath: null,
    baseUrl: null,
    providerMode: "other",
    otherReason: "read-error",
  });
  expect(unreadable.status).toBe("warn");
  expect(unreadable.detail).toContain("could not be read");
});

test("direct + stored token reports ok with gh absent (no gh requirement)", () => {
  // Codex: a stored token (directUsesToken, providerWired) is ok even with gh missing.
  const codexToken: CodexFacts = {
    home: "/c",
    configExists: true,
    providerSelected: true,
    providerMode: "direct",
    modelProvider: "copilot-env",
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: true,
    envKeyMatches: true,
    providerWired: true,
    envFilePresent: true,
    envKeyInDotenv: false,
    envKeyInEnviron: false,
    tokenAvailable: false,
    directAuth: { command: null, authenticated: false },
    directUsesToken: true,
    directNeedsNoGh: true,
    otherReason: null,
  };
  const codexRes = checkCodex(codexToken);
  expect(codexRes.status).toBe("ok");
  expect(codexRes.detail).toContain("stored GitHub token");
  expect(codexRes.detail).not.toContain("GitHub CLI not found");

  // Claude: stored-token resolver, gh absent -> still ok (base URL is right).
  const claudeToken: ClaudeFacts = {
    home: "/h/.claude",
    settingsPath: join("/h/.claude", "settings.json"),
    settingsExists: true,
    helperPath: join("/h/.claude", "copilot-token.sh"),
    baseUrl: "https://api.githubcopilot.com",
    baseUrlMatches: false,
    providerMode: "direct",
    wired: true,
    otherReason: null,
    directAuth: { command: null, authenticated: false },
    directUsesToken: true,
  };
  const claudeRes = checkClaude(claudeToken);
  expect(claudeRes.status).toBe("ok");
  expect(claudeRes.detail).toContain("stored GitHub token");
  expect(claudeRes.detail).not.toContain("GitHub CLI not found");
});

// --- live (--live) checks ---------------------------------------------------

test("checkCodexLive/checkClaudeLive: ok responds, fail warns, missing skips", () => {
  expect(checkCodexLive({ kind: "ok", cli: "/bin/codex" }).status).toBe("ok");
  const codexFail = checkCodexLive({ kind: "failed", cli: "/bin/codex", detail: "exit 1" });
  expect(codexFail.status).toBe("warn");
  expect(codexFail.fix).toBe("agent codex");
  const codexSkip = checkCodexLive({ kind: "skipped" });
  expect(codexSkip.status).toBe("ok");
  expect(codexSkip.detail).toContain("skipped");

  // The captured output is surfaced verbatim (a failed probe ALWAYS carries it).
  const codexFailWithDetail = checkCodexLive({
    kind: "failed",
    cli: "/bin/codex",
    detail: '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
  });
  expect(codexFailWithDetail.status).toBe("warn");
  expect(codexFailWithDetail.detail).toContain("401 Unauthorized");
  expect(codexFailWithDetail.detail).not.toContain("did not answer");

  expect(checkClaudeLive({ kind: "ok", cli: "/bin/claude" }).status).toBe("ok");
  const claudeFail = checkClaudeLive({ kind: "failed", cli: "/bin/claude", detail: "exit 1" });
  expect(claudeFail.status).toBe("warn");
  expect(claudeFail.fix).toBe("agent claude");
  // Claude surfaces the full captured error too (symmetric with codex).
  const claudeFailWithDetail = checkClaudeLive({
    kind: "failed",
    cli: "/bin/claude",
    detail: "API Error: 401 invalid x-api-key",
  });
  expect(claudeFailWithDetail.detail).toContain("401 invalid x-api-key");
  expect(claudeFailWithDetail.detail).not.toContain("did not answer");
  expect(checkClaudeLive({ kind: "skipped" }).status).toBe("ok");
});

test("live checks: a skip off a FAILED look says could-not-check, never 'not installed'", () => {
  const codexSkip = checkCodexLive({ kind: "skipped", lookFailed: true });
  expect(codexSkip.status).toBe("ok");
  expect(codexSkip.detail).toBe(
    "skipped (could not check for the codex CLI - the command probe failed to run)",
  );
  expect(codexSkip.value).toEqual({ ran: false, ok: false, cli: null, lookFailed: true });
  const claudeSkip = checkClaudeLive({ kind: "skipped", lookFailed: true });
  expect(claudeSkip.status).toBe("ok");
  expect(claudeSkip.detail).toBe(
    "skipped (could not check for the claude CLI - the command probe failed to run)",
  );
  // The proven-absent skip keeps the landed wording, unmarked.
  const proven = checkCodexLive({ kind: "skipped" });
  expect(proven.detail).toBe("skipped (codex CLI not installed)");
  expect(proven.value).toEqual({ ran: false, ok: false, cli: null });
});

// --- codex host farm --------------------------------------------------------

test("checkCodexHost: the codex-host key against the disk, every drift warns with `agent codex`", () => {
  const hostHome = "/h/.codex/hosts/box";
  const configLine = `config.toml: ${join(hostHome, "config.toml")}`;
  const on: CodexHostFacts = {
    supported: true,
    hostHome,
    exists: true,
    wired: true,
    probeError: null,
    active: true,
    enabled: true,
  };
  // Key on, farm wired and recorded as the active home: the one healthy on-state.
  const active = checkCodexHost(on);
  expect(active.status).toBe("ok");
  expect(active.fix).toBeUndefined();
  expect(active.detail).toBe(`active per-host CODEX_HOME: ${hostHome}\n${configLine}`);
  expect(active.value).toEqual({
    supported: true,
    hostHome,
    configFile: join(hostHome, "config.toml"),
    exists: true,
    wired: true,
    probeError: null,
    active: true,
    enabled: true,
  });
  // Every disagreement is a warn rendering the shared drift line (its wording is pinned
  // once, in test/codex_host.test.ts) with the command that resolves it.
  const line = (drift: CodexHostDrift): string => codexHostDriftLine(drift);
  const drifts: Array<{ facts: CodexHostFacts; summary: string; withConfig: boolean }> = [
    // On but hand-deleted (nothing on disk), or only half-built (dir without config.toml).
    {
      facts: { ...on, exists: false, wired: false },
      summary: line({ kind: "missing", hostHome }),
      withConfig: false,
    },
    {
      facts: { ...on, wired: false },
      summary: line({ kind: "missing", hostHome }),
      withConfig: true,
    },
    // On and wired, but no wiring pass recorded it as the active home yet.
    {
      facts: { ...on, active: false },
      summary: line({ kind: "inactive", hostHome }),
      withConfig: true,
    },
    // Off with OUR wired farm still on disk: the next pass removes it.
    {
      facts: { ...on, active: false, enabled: false },
      summary: line({ kind: "disabled", hostHome }),
      withConfig: true,
    },
  ];
  for (const { facts, summary, withConfig } of drifts) {
    const result = checkCodexHost(facts);
    expect(result.status).toBe("warn");
    expect(result.fix).toBe("agent codex");
    expect(result.detail).toBe(withConfig ? `${summary}\n${configLine}` : summary);
  }
  // Off with something at the path that is not proven ours NOW (no managed wiring on
  // disk, recorded or not, probeable or not): no drift, nothing to fix; the derivation
  // leaves it alone.
  for (
    const facts of [
      { ...on, wired: false, active: false, enabled: false },
      { ...on, wired: false, probeError: "EACCES", enabled: false },
      { ...on, exists: false, wired: false, probeError: "EACCES", enabled: false },
    ]
  ) {
    const foreign = checkCodexHost(facts);
    expect(foreign.status).toBe("ok");
    expect(foreign.fix).toBeUndefined();
  }
  // Not built, not wanted: informational, and the path is not echoed.
  const unbuilt = checkCodexHost({
    ...on,
    exists: false,
    wired: false,
    active: false,
    enabled: false,
  });
  expect(unbuilt.status).toBe("ok");
  expect(unbuilt.fix).toBeUndefined();
  expect(unbuilt.detail).toBe("not built (optional)");
  // Windows: no farm is possible, whatever the key says.
  const unsupported = checkCodexHost({ ...on, supported: false, enabled: false });
  expect(unsupported.status).toBe("ok");
  expect(unsupported.detail).toBe("not built (unsupported on Windows)");
});

// --- claude desktop ---------------------------------------------------------

test("checkClaudeDesktop: a rendered fix is a warn, none is ok; the detail is the rendered lines", () => {
  // The rendering itself (every arm) is proven over real libraries in claude_desktop.test.ts;
  // this pins the check's mapping of that rendering onto a health verdict.
  const inspected = {
    kind: "inspected" as const,
    enabled: true,
    installed: true,
    helperPaths: [] as string[],
    libraryDir: "/lib",
    unlisted: [] as Extract<ClaudeDesktopStatus, { kind: "inspected" }>["unlisted"],
    owned: [{ name: "copilot-env", path: "/lib/a.json", profile: null }],
    entries: [] as Extract<ClaudeDesktopStatus, { kind: "inspected" }>["entries"],
    orphans: [] as Extract<ClaudeDesktopStatus, { kind: "inspected" }>["orphans"],
  };
  const wired = checkClaudeDesktop({
    ...inspected,
    entries: [{ profile: null, mode: "direct", verdict: { kind: "wired", path: "/lib/a.json" } }],
  });
  expect(wired.status).toBe("ok");
  expect(wired.detail).toBe(`"copilot-env" (direct) wired at /lib/a.json`);
  expect(wired.fix).toBeUndefined();
  // The `--json` contract: each entry's verdict flattened beside its target.
  expect(wired.value?.entries).toEqual([
    { profile: null, mode: "direct", kind: "wired", path: "/lib/a.json" },
  ]);

  const missing = checkClaudeDesktop({
    ...inspected,
    entries: [
      { profile: null, mode: "direct", verdict: { kind: "wired", path: "/lib/a.json" } },
      { profile: parseProfileName("work"), mode: "proxy", verdict: { kind: "missing" } },
    ],
  });
  expect(missing.status).toBe("warn");
  expect(missing.detail).toBe(
    `"copilot-env" (direct) wired at /lib/a.json\n"copilot-env: work" (proxy) missing`,
  );
  expect(missing.fix).toBe("agent profile --add work");

  // A profile's helper script left behind with the key off and no library at all: still a
  // leftover (the default's helper stays with its entry, so it is not one).
  const helperLeft = checkClaudeDesktop({
    kind: "no-library",
    enabled: false,
    installed: false,
    helperPaths: ["/root/claude-desktop-token.sh", "/root/claude-desktop-token-work.sh"],
  });
  expect(helperLeft.status).toBe("warn");
  expect(helperLeft.detail).toContain("/root/claude-desktop-token-work.sh");
  expect(helperLeft.detail).toContain("1 copilot-env leftover remains");
  expect(helperLeft.fix).toBe("agent claude");

  // The rest of the `--json` value contract: each arm's own fields ride along whole.
  const old = parseProfileName("old");
  const drift = checkClaudeDesktop({
    ...inspected,
    orphans: [{ name: "copilot-env: old", path: "/lib/o.json", profile: old }],
    unlisted: [{ path: "/lib/gone.json", profile: old }],
  });
  expect(drift.value).toEqual({
    kind: "inspected",
    enabled: true,
    installed: true,
    helperPaths: [],
    libraryDir: "/lib",
    owned: [{ name: "copilot-env", path: "/lib/a.json", profile: null }],
    unlisted: [{ path: "/lib/gone.json", profile: old }],
    entries: [],
    orphans: [{ name: "copilot-env: old", path: "/lib/o.json", profile: old }],
  });
  const unreadable = checkClaudeDesktop({
    kind: "unreadable",
    enabled: true,
    installed: true,
    helperPaths: [],
    metaPath: "/lib/_meta.json",
  });
  expect(unreadable.value).toEqual({
    kind: "unreadable",
    enabled: true,
    installed: true,
    helperPaths: [],
    metaPath: "/lib/_meta.json",
  });
  const unjudged = checkClaudeDesktop({
    kind: "unjudged",
    enabled: true,
    installed: true,
    helperPaths: [],
    reason: "settings.json malformed",
  });
  expect(unjudged.value).toEqual({
    kind: "unjudged",
    enabled: true,
    installed: true,
    helperPaths: [],
    reason: "settings.json malformed",
  });
});
