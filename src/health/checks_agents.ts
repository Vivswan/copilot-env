// Pure evaluators for the agent wiring: how Codex, Claude, and Claude Desktop
// stand against the facts probe.ts gathered, plus the `--live` end-to-end
// checks. No I/O, like checks.ts, whose evaluateAll registers these alongside
// the environment and runtime checks.
import { DIRECT_BASE_URL } from "../claude/config.ts";
import { type ClaudeDesktopStatus, renderClaudeDesktopStatus } from "../claude/desktop_status.ts";
import { type CodexOtherReason, codexProviderId } from "../codex/config.ts";
import { codexHostDriftFrom, codexHostDriftLine } from "../codex/host.ts";
import { codexConfigPath } from "../codex/paths.ts";
import type { AuthProvider } from "../copilot_api/env_state.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import type {
  ClaudeFacts,
  CodexDirectAuthFacts,
  CodexFacts,
  CodexHostFacts,
  LiveProbeFacts,
} from "./facts.ts";
import { type CheckResult, meta, profileAddFix } from "./types.ts";

/**
 * The gh-auth status shared by Codex and Claude Direct (gh-backed) checks: both
 * mint the bearer via `gh auth token`. Returns whether it's usable, a one-line
 * detail, and the gh-specific fix. Callers wrap `ghFix` in their own fix
 * selection (e.g. a base-URL/provider fix takes precedence). An UNPROVEN probe
 * (the gh look or the `gh auth token` spawn never ran to completion) keeps the
 * warn direction but wears could-not-check words -- "not found"/"not
 * authenticated" and their advice would be false claims about a check that
 * never happened.
 */
function describeDirectGhAuth(a: CodexDirectAuthFacts): {
  ok: boolean;
  detail: string;
  ghFix: string;
} {
  if (a.unproven) {
    return {
      ok: false,
      detail: a.command === null
        ? "gh auth: could not check for the GitHub CLI (the command probe failed to run)"
        : "gh auth: could not check gh authentication (`gh auth token` did not run to completion)",
      ghFix: "re-run `agent health` (the gh check did not run to completion)",
    };
  }
  // Always name the account (no hidden information): a pinned slot's verdict is
  // about THAT account (gh's active login is exactly what it did NOT check), and
  // an auto slot names the account it follows -- or says it is on AUTO when the
  // account list could not name the active login.
  const account = (a.ghUser ?? null) !== null
    ? ` as account '${a.ghUser}'`
    : (a.ghActiveLogin ?? null) !== null
    ? ` (AUTO - currently account ${a.ghActiveLogin})`
    : " (AUTO - follows gh's active account)";
  return {
    ok: a.command !== null && a.authenticated,
    detail: a.command === null
      ? "gh auth: GitHub CLI not found"
      : a.authenticated
      ? `gh auth: authenticated via ${a.command}${account}`
      : `gh auth: ${a.command} is not authenticated${account}`,
    ghFix: a.command === null ? "install gh and run gh auth login" : "gh auth login",
  };
}

/** The shared direct-mode auth verdict: ok, or warn carrying its fix. */
type DirectAuthVerdict =
  | { status: "ok"; authLine: string }
  | { status: "warn"; authLine: string; fix: string };

/**
 * The shared direct-mode auth verdict for `checkCodex`/`checkClaude`: an identical
 * three-way decision (stored token -> gh-cli -> no credential resolves) over the same
 * facts. `wiringOk` is each agent's "rest of the wiring is correct" signal (Codex:
 * `providerWired`; Claude: base URL matches) and `directFix` is its `agent <cli> --direct`
 * repair hint. Each check wraps this with its own provider/base-url header lines.
 */
function directAuthVerdict(
  f: {
    directUsesToken: boolean;
    provider?: AuthProvider | null;
    directAuth: CodexDirectAuthFacts;
  },
  wiringOk: boolean,
  directFix: string,
  profile: Profile = null,
): DirectAuthVerdict {
  const getCommand = profile === null
    ? "agent auth --get"
    : `agent auth --get --profile ${profile}`;
  const authFix = profile === null ? "agent auth" : `agent auth --profile ${profile}`;
  if (f.directUsesToken) {
    const authLine = `auth: stored GitHub token (${getCommand}, no gh CLI)`;
    return wiringOk ? { status: "ok", authLine } : { status: "warn", authLine, fix: directFix };
  }
  if (f.provider === "gh-cli") {
    const { ok: authOk, detail: authLine, ghFix } = describeDirectGhAuth(f.directAuth);
    return wiringOk && authOk
      ? { status: "ok", authLine }
      : { status: "warn", authLine, fix: wiringOk ? ghFix : directFix };
  }
  return {
    status: "warn",
    authLine: `auth: no credential resolves via \`${getCommand}\` - run \`${authFix}\``,
    fix: wiringOk ? authFix : directFix,
  };
}

/** The repair line of a Codex "other" classification, keyed off the reason the
 *  classifier minted (exhaustive, so a new reason forces a verdict here). Null
 *  = "custom": a foreign selection is re-wirable, so the generic model_provider
 *  reporting in checkCodex owns it. */
function codexOtherLine(reason: CodexOtherReason): string | null {
  switch (reason) {
    case "malformed":
      return "config.toml is present but not valid TOML";
    case "read-error":
      return "config.toml exists but could not be read";
    case "custom":
      return null;
    default:
      return assertNever(reason);
  }
}

export function checkCodex(f: CodexFacts, profile: Profile = null): CheckResult {
  const configPath = codexConfigPath(f.home);
  // A named profile's whole wiring (both agents, one mode) is (re)written by ONE
  // command, so every named repair points there instead of `agent codex ...`.
  const directFix = profile === null ? "agent codex --direct" : profileAddFix(profile);
  const proxyFix = profile === null ? "agent codex --proxy" : profileAddFix(profile);
  const base = {
    ...meta("setup.codex"),
    profile,
    value: {
      home: f.home,
      configFile: configPath,
      configExists: f.configExists,
      modelProvider: f.modelProvider,
      providerMode: f.providerMode,
      otherReason: f.otherReason,
      baseUrl: f.baseUrl,
      providerWired: f.providerWired,
      envFilePresent: f.envFilePresent,
      envKeyInDotenv: f.envKeyInDotenv,
      envKeyInEnviron: f.envKeyInEnviron,
      tokenAvailable: f.tokenAvailable,
      directAuth: f.directAuth,
      // The store-aware "Direct needs no gh" verdict, under the key this JSON
      // report has always used.
      directUsesToken: f.directNeedsNoGh,
    },
  };
  // No config at the effective CODEX_HOME: the user hasn't wired Codex -- fine
  // for the default, but a NAMED profile promises both-agent wiring, so its
  // absence is an interrupted `agent profile --add`.
  if (!f.configExists) {
    if (profile !== null) {
      return {
        ...base,
        status: "warn",
        detail:
          `provider: none\nno Codex config at ${configPath} (profile '${profile}' is not wired into Codex)`,
        fix: profileAddFix(profile),
      };
    }
    return {
      ...base,
      status: "ok",
      detail: `provider: none\nno Codex config at ${configPath} (not wired)`,
    };
  }
  // A NAMED profile's wiring is DERIVED from its store slot's recorded mode; a
  // managed wiring in the OTHER mode is an interrupted rewire (`profile --add`
  // switched the slot but not this agent) and must not read green.
  if (
    profile !== null &&
    f.expectedMode != null &&
    (f.providerMode === "direct" || f.providerMode === "proxy") &&
    f.providerMode !== f.expectedMode
  ) {
    return {
      ...base,
      status: "warn",
      detail: [
        `provider: ${f.providerMode}`,
        `config.toml: ${configPath}`,
        `wired ${f.providerMode}, but the profile's recorded mode is ${f.expectedMode} (out of step with the store slot)`,
      ].join("\n"),
      fix: profileAddFix(profile),
    };
  }
  if (f.providerMode === "direct") {
    // A stored token means the resolver (`agent auth --get`) needs no `gh`; wiring
    // alone decides. Otherwise it falls back to `gh auth token`, which must work.
    const verdict = directAuthVerdict(
      { directUsesToken: f.directNeedsNoGh, provider: f.provider, directAuth: f.directAuth },
      f.providerWired,
      directFix,
      profile,
    );
    const detail = [
      "provider: direct",
      `config.toml: ${configPath}`,
      `model_provider ${f.modelProvider ?? "(unset)"} (direct) → ${f.baseUrl ?? "(missing)"}`,
      verdict.authLine,
    ].join("\n");
    return verdict.status === "ok"
      ? { ...base, status: "ok", detail }
      : { ...base, status: "warn", detail, fix: verdict.fix };
  }
  // A config.toml we could not parse or read: the managed writers REFUSE such a
  // file, so a re-wire fix cannot land -- the repair comes first (mirrors the
  // Claude malformed/read-error arm; codexOtherLine's null sends a foreign
  // "custom" selection to the generic re-wire path below).
  if (f.providerMode === "other") {
    const otherLine = codexOtherLine(f.otherReason);
    if (otherLine !== null) {
      const rewire = profile === null ? "agent codex" : profileAddFix(profile);
      return {
        ...base,
        status: "warn",
        detail: ["provider: other", `config.toml: ${configPath}`, otherLine].join("\n"),
        fix: `repair ${configPath}, then re-run \`${rewire}\``,
      };
    }
  }
  // Config exists: report precisely which part of the wiring is off.
  const withConfigPath = (message: string) => `config.toml: ${configPath}\n${message}`;
  let detail: string | null = null;
  if (!f.providerSelected) {
    detail = [
      `provider: ${f.providerMode}`,
      withConfigPath(
        `model_provider is ${f.modelProvider ?? "unset"}, not "${codexProviderId(profile)}"`,
      ),
    ].join("\n");
  } else if (!f.baseUrlMatches) {
    detail = [
      "provider: proxy",
      withConfigPath(`copilot-env base_url ${f.baseUrl ?? "(missing)"} is not the running proxy`),
    ].join("\n");
  } else if (!f.providerWired) {
    // Selected + base_url ok, but not fully wired: the managed proxy auth.command
    // (the shared proxy-token resolver, which ensures the proxy is up then prints its key)
    // is missing/foreign.
    detail = [
      "provider: proxy",
      withConfigPath(`copilot-env proxy is not fully wired - run \`${proxyFix}\``),
    ].join("\n");
  }
  if (detail !== null) {
    return { ...base, status: "warn", detail, fix: proxyFix };
  }
  // Fully wired: the proxy resolves its key at runtime via the managed auth.command (the
  // proxy-token resolver, which ensures the proxy when the lifecycle is on), so there's no
  // baked token to report.
  const detailLines = [
    "provider: proxy",
    `config.toml: ${configPath}`,
    `model_provider ${codexProviderId(profile)} → ${f.baseUrl}`,
    "auth: local proxy key via the proxy-token resolver",
  ];
  return { ...base, status: "ok", detail: detailLines.join("\n") };
}

/** Report the per-host CODEX_HOME farm (~/.codex/hosts/<hostname>) against the
 *  `codex-host` key that derives it: any key-vs-disk drift warns with the wiring
 *  pass that resolves it (the same verdict `agent codex --check` prints). */
export function checkCodexHost(f: CodexHostFacts): CheckResult {
  const configFile = codexConfigPath(f.hostHome);
  const detail = (summary: string) => f.exists ? `${summary}\nconfig.toml: ${configFile}` : summary;
  const base = {
    ...meta("setup.codex-host"),
    profile: null,
    value: {
      supported: f.supported,
      hostHome: f.hostHome,
      configFile,
      exists: f.exists,
      wired: f.wired,
      probeError: f.probeError,
      active: f.active,
      enabled: f.enabled,
    },
  };
  const warn = (summary: string): CheckResult => ({
    ...base,
    status: "warn",
    detail: detail(summary),
    fix: "agent codex",
  });
  if (!f.supported) return { ...base, status: "ok", detail: "not built (unsupported on Windows)" };
  const drift = codexHostDriftFrom(f.enabled, {
    hostHome: f.hostHome,
    present: f.exists,
    wired: f.wired,
    probeError: f.probeError,
    active: f.active,
  });
  if (drift !== null) return warn(codexHostDriftLine(drift));
  if (f.enabled) {
    return { ...base, status: "ok", detail: detail(`active per-host CODEX_HOME: ${f.hostHome}`) };
  }
  // Not built, not wanted. Informational -- it's an optional feature.
  return { ...base, status: "ok", detail: "not built (optional)" };
}

/** The one-line reading of a Claude "other" classification, keyed off the
 *  reason the classifier minted (never re-derived from paths here). */
function claudeOtherLine(f: ClaudeFacts & { providerMode: "other" }): string {
  switch (f.otherReason) {
    case "malformed":
      return "settings.json is present but not valid JSON";
    case "read-error":
      return "settings.json exists but could not be read";
    case "custom":
      return `custom apiKeyHelper/ANTHROPIC_BASE_URL set (${f.helperPath ?? f.baseUrl})`;
    default:
      return assertNever(f.otherReason);
  }
}

/** Report Claude Code wiring (settings.json, or a named profile's
 *  settings-<name>.json): direct / proxy / custom. */
export function checkClaude(f: ClaudeFacts, profile: Profile = null): CheckResult {
  const directFix = profile === null ? "agent claude --direct" : profileAddFix(profile);
  const base = {
    ...meta("setup.claude"),
    profile,
    value: {
      home: f.home,
      settingsFile: f.settingsPath,
      settingsExists: f.settingsExists,
      providerMode: f.providerMode,
      otherReason: f.otherReason,
      apiKeyHelper: f.helperPath,
      baseUrl: f.baseUrl,
      directAuth: f.directAuth,
      directUsesToken: f.directUsesToken,
    },
  };
  // A NAMED profile's settings file is derived from its slot's recorded mode; a
  // managed wiring in the OTHER mode is an interrupted rewire (see checkCodex).
  if (
    profile !== null &&
    f.expectedMode != null &&
    (f.providerMode === "direct" || f.providerMode === "proxy") &&
    f.providerMode !== f.expectedMode
  ) {
    return {
      ...base,
      status: "warn",
      detail: [
        `provider: ${f.providerMode}`,
        `settings.json: ${f.settingsPath}`,
        `wired ${f.providerMode}, but the profile's recorded mode is ${f.expectedMode} (out of step with the store slot)`,
      ].join("\n"),
      fix: profileAddFix(profile),
    };
  }
  if (f.providerMode === "direct") {
    const baseOk = f.baseUrl === DIRECT_BASE_URL;
    // A stored token means the resolver (`agent auth --get`) needs no `gh`; only
    // the base URL must be right. Otherwise it falls back to `gh auth token`.
    const verdict = directAuthVerdict(f, baseOk, directFix, profile);
    const baseUrlLine = `ANTHROPIC_BASE_URL → ${f.baseUrl ?? "(missing)"}${
      baseOk ? "" : ` (expected ${DIRECT_BASE_URL})`
    }`;
    const detail = [
      "provider: direct",
      `settings.json: ${f.settingsPath}`,
      baseUrlLine,
      verdict.authLine,
    ].join("\n");
    return verdict.status === "ok"
      ? { ...base, status: "ok", detail }
      : { ...base, status: "warn", detail, fix: verdict.fix };
  }
  if (f.providerMode === "proxy") {
    // Proxy-backed via settings.json (apiKeyHelper prints the proxy token, base URL points at
    // the local proxy). Runtime reachability is the proxy check's job; here we confirm the
    // wiring is present AND that ANTHROPIC_BASE_URL actually points at the resolved proxy port
    // -- a stale base URL (e.g. after `config port` changed and the daemon rebound) would send
    // Claude to the wrong/absent port, so it must not read green. Mirrors the Codex check.
    // A named profile's repair is its own atomic re-add (which re-reserves and re-bakes).
    const baseUrlOk = f.baseUrl !== null && f.baseUrlMatches;
    const detail = [
      "provider: proxy",
      `settings.json: ${f.settingsPath}`,
      `ANTHROPIC_BASE_URL → ${f.baseUrl ?? "(missing)"}${
        baseUrlOk ? "" : " (does not match the resolved proxy port)"
      }`,
      `apiKeyHelper → ${f.helperPath ?? "(missing)"}`,
    ].join("\n");
    return baseUrlOk ? { ...base, status: "ok", detail } : {
      ...base,
      status: "warn",
      detail,
      fix: profile === null
        // --proxy explicitly: the bare commands auto-detect a mode, which is not
        // guaranteed to re-bake the proxy wiring this fix is repairing.
        ? "Re-run `agent claude --proxy` to repoint ANTHROPIC_BASE_URL at the current proxy port."
        : `Re-run \`${
          profileAddFix(profile)
        }\` to repoint ANTHROPIC_BASE_URL at the profile's proxy port.`,
    };
  }
  if (f.providerMode === "other") {
    // Foreign wiring in the DEFAULT settings.json is the user's own business; in
    // a NAMED profile's settings file it is drift -- the profile promises managed
    // wiring, and `profile --add` refuses to overwrite an unmanaged file, so the
    // fix names the removal first.
    if (profile !== null) {
      return {
        ...base,
        status: "warn",
        detail: [
          "provider: other",
          `settings.json: ${f.settingsPath}`,
          `${claudeOtherLine(f)}; profile '${profile}' expects managed wiring`,
        ].join("\n"),
        fix: `remove ${f.settingsPath} (not managed by copilot-env), then ${
          profileAddFix(profile)
        }`,
      };
    }
    // Default-profile exception to "the user's own business", keyed off the
    // classifier's reason: a settings file we could not read/parse will trip
    // Claude itself too.
    if (f.otherReason === "malformed" || f.otherReason === "read-error") {
      return {
        ...base,
        status: "warn",
        detail: ["provider: other", `settings.json: ${f.settingsPath}`, claudeOtherLine(f)]
          .join("\n"),
        fix: `repair ${f.settingsPath}, then re-run \`agent claude\``,
      };
    }
    return {
      ...base,
      status: "ok",
      detail: [
        "provider: other",
        `settings.json: ${f.settingsPath}`,
        `${claudeOtherLine(f)}; not managed`,
      ].join("\n"),
    };
  }
  // none: never configured. Fine for the default (`cl` writes proxy wiring on
  // first launch); a NAMED profile promises both-agent wiring, so its absence is
  // an interrupted `agent profile --add`.
  if (profile !== null) {
    return {
      ...base,
      status: "warn",
      detail: [
        "provider: none",
        `settings.json: ${f.settingsPath}`,
        `profile '${profile}' is not wired into Claude`,
      ].join("\n"),
      fix: profileAddFix(profile),
    };
  }
  return {
    ...base,
    status: "ok",
    detail: [
      "provider: none",
      `settings.json: ${f.settingsPath}`,
      "not configured; run `agent claude` (or --direct/--proxy)",
    ].join("\n"),
  };
}

/** The Claude Desktop library against the `claude-desktop` key: a rendered fix (drift) is a
 *  warn, anything else informational. The drift rule lives in renderClaudeDesktopStatus,
 *  shared with `agent claude --check`. */
export function checkClaudeDesktop(f: ClaudeDesktopStatus): CheckResult {
  const { lines, fix } = renderClaudeDesktopStatus(f);
  const base = {
    ...meta("setup.claude-desktop"),
    profile: null,
    value: {
      kind: f.kind,
      enabled: f.enabled,
      installed: f.installed,
      helperPaths: f.helperPaths,
      ...(f.kind === "unreadable" ? { metaPath: f.metaPath } : {}),
      ...(f.kind === "unjudged" ? { reason: f.reason } : {}),
      ...(f.kind === "inspected"
        ? {
          libraryDir: f.libraryDir,
          owned: f.owned,
          unlisted: f.unlisted,
          entries: f.entries.map((e) => ({ profile: e.profile, mode: e.mode, ...e.verdict })),
          orphans: f.orphans,
        }
        : {}),
    },
  };
  const detail = lines.join("\n");
  return fix === null
    ? { ...base, status: "ok", detail }
    : { ...base, status: "warn", detail, fix };
}

/**
 * `--live` end-to-end check shared by Codex and Claude: did the agent actually
 * respond via its configured backend? Only the ids/labels/group/scopes/fix differ.
 */
function checkAgentLive(
  agent: "codex" | "claude",
  f: LiveProbeFacts,
  profile: Profile = null,
): CheckResult {
  const base = {
    ...meta(agent === "codex" ? "codex.live" : "claude.live"),
    profile,
    // The JSON report's historical shape: ran/ok/cli, derived from the probe kind.
    value: {
      ran: f.kind !== "skipped",
      ok: f.kind === "ok",
      cli: f.kind === "skipped" ? null : f.cli,
      ...(f.kind === "skipped" && f.lookFailed ? { lookFailed: true } : {}),
    },
  };
  if (f.kind === "skipped") {
    // A skip off a FAILED look is a could-not-check, never a proven absence.
    return {
      ...base,
      status: "ok",
      detail: f.lookFailed
        ? `skipped (could not check for the ${agent} CLI - the command probe failed to run)`
        : `skipped (${agent} CLI not installed)`,
    };
  }
  return f.kind === "ok"
    ? { ...base, status: "ok", detail: `read-only prompt responded via ${f.cli}` }
    : {
      ...base,
      status: "warn",
      detail: `read-only prompt failed (${f.cli})\n${f.detail}`,
      fix: profile === null ? `agent ${agent}` : profileAddFix(profile),
    };
}

/** `--live` end-to-end check: did Codex actually respond via its configured backend? */
export function checkCodexLive(f: LiveProbeFacts, profile: Profile = null): CheckResult {
  return checkAgentLive("codex", f, profile);
}
export function checkClaudeLive(f: LiveProbeFacts, profile: Profile = null): CheckResult {
  return checkAgentLive("claude", f, profile);
}
