// Pure evaluators for the agent wiring: how Codex, Claude, and Claude Desktop
// stand against the facts probe.ts gathered, plus the `--live` end-to-end
// checks. No I/O, like checks.ts, whose evaluateAll registers these alongside
// the environment and runtime checks.
import { basename, dirname } from "node:path";
import { type ClaudeDesktopStatus, renderClaudeDesktopStatus } from "../claude/desktop_status.ts";
import { type CodexOtherReason, codexProviderId } from "../codex/config.ts";
import { codexHostDriftFrom, codexHostDriftLine } from "../codex/host.ts";
import { codexConfigPath, codexProfileConfigPath } from "../codex/paths.ts";
import type { AuthProvider } from "../copilot_api/env_state.ts";
import { isDirectBaseUrl } from "../copilot_api/integration_identity.ts";
import { agentStartCommand, type Profile } from "../copilot_api/profile.ts";
import { v409CodexProfileFiles } from "../migrations/4.0.9.ts";
import { assertNever } from "../utils/assert.ts";
import { versionLessThan } from "../utils/semver.ts";
import { packageVersion } from "../utils/version.ts";
import type {
  BakedCredentialFreshness,
  ClaudeFacts,
  CodexDirectAuthFacts,
  CodexFacts,
  CodexHostFacts,
  LiveProbeFacts,
} from "./facts.ts";
import { type CheckResult, meta, profileAddFix } from "./types.ts";

/**
 * Shared by the Codex and Claude Direct checks: both mint the bearer via `gh auth token`.
 * Callers wrap `ghFix` in their own fix selection (a base-URL/provider fix takes precedence). An
 * UNPROVEN probe keeps the warn direction but wears could-not-check words: "not found" / "not
 * authenticated" and their advice would be false claims about a check that never happened.
 */
function describeDirectGhAuth(a: CodexDirectAuthFacts): {
  ok: boolean;
  detail: string;
  ghFix: string;
} {
  // The account is part of the verdict: a pinned slot's verdict is about THAT account (gh's
  // active login is exactly what it did NOT check), and ghActiveLogin is its own probe, so an
  // auto slot names its account even on the unproven line.
  //
  //   gh found, proven or unproven -> the line names the account
  //   command === null             -> not-found / could-not-check, with no account
  const accountClause = (a.ghUser ?? null) !== null
    ? `account '${a.ghUser}'`
    : (a.ghActiveLogin ?? null) !== null
    ? `AUTO - currently account ${a.ghActiveLogin}`
    : "AUTO - follows gh's active account";
  if (a.unproven) {
    return {
      ok: false,
      detail: a.command === null
        ? "gh auth: could not check for the GitHub CLI (the command probe failed to run)"
        : "gh auth: could not check gh authentication " +
          `(\`gh auth token\` did not run to completion; ${accountClause})`,
      ghFix: "re-run `agent health` (the gh check did not run to completion)",
    };
  }
  const account = (a.ghUser ?? null) !== null ? ` as ${accountClause}` : ` (${accountClause})`;
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

/** How a static wiring's baked value stands against what a rewire would bake; the stale arm names
 *  the rewire because nothing else refreshes a baked value. */
function bakedCredentialClause(
  freshness: BakedCredentialFreshness | undefined,
  rewire: string,
): { stale: boolean; clause: string } {
  switch (freshness) {
    case "stale":
      return { stale: true, clause: `; out of step with the store, re-run \`${rewire}\`` };
    case "unchecked":
      return { stale: false, clause: "; freshness not checked" };
    case "fresh":
    case undefined:
      return { stale: false, clause: "" };
    default:
      return assertNever(freshness);
  }
}

/** The identical decision (static value -> stored token -> gh-cli -> nothing resolves) for
 *  checkCodex and checkClaude. `wiringOk` is each agent's "rest of the wiring is right" signal
 *  (Codex: providerWired; Claude: base URL matches); `directFix` its `agent <cli> --direct` repair. */
function directAuthVerdict(
  f: {
    directUsesToken: boolean;
    provider?: AuthProvider | null;
    directAuth: CodexDirectAuthFacts;
    credential?: "command" | "static" | "none" | null;
    bakedCredential?: BakedCredentialFreshness;
  },
  wiringOk: boolean,
  directFix: string,
  profile: Profile = null,
): DirectAuthVerdict {
  const getCommand = profile === null
    ? "agent auth --get"
    : `agent auth --get --profile ${profile}`;
  const authFix = profile === null ? "agent auth" : `agent auth --profile ${profile}`;
  if (f.credential === "static") {
    const baked = bakedCredentialClause(f.bakedCredential, directFix);
    const authLine = `auth: GitHub token baked into the config (static-key${baked.clause})`;
    return wiringOk && !baked.stale
      ? { status: "ok", authLine }
      : { status: "warn", authLine, fix: directFix };
  }
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

/** Keyed off the reason the classifier minted (exhaustive, so a new reason forces a verdict), with
 *  the repair: `repair <file>` for a broken one, or the one step that lifts a profile-v1 shape (a
 *  rewire never removes it, so `agent profile --add` alone would leave Codex refusing). Null =
 *  "custom": a foreign selection is re-wirable, so checkCodex's generic model_provider reporting
 *  owns it. */
function codexOtherLine(
  reason: CodexOtherReason,
  configPath: string,
  profile: Profile,
): { line: string; repair: string } | null {
  // The inspector mints a profile reason only for a named inspection, so the fallback is unreached.
  const profileFile = profile === null
    ? configPath
    : codexProfileConfigPath(dirname(configPath), profile);
  switch (reason) {
    case "malformed":
      return { line: "config.toml is present but not valid TOML", repair: `repair ${configPath}` };
    case "read-error":
      return { line: "config.toml exists but could not be read", repair: `repair ${configPath}` };
    case "profile-malformed":
      return {
        line: `${basename(profileFile)} is present but not valid TOML`,
        repair: `repair ${profileFile}`,
      };
    case "profile-read-error":
      return {
        line: `${basename(profileFile)} exists but could not be read`,
        repair: `repair ${profileFile}`,
      };
    case "legacy-profile-key":
      return {
        line:
          "config.toml carries a top-level `profile` key, which Codex no longer supports (every launch refuses to start)",
        repair: `delete the \`profile\` line from ${configPath}`,
      };
    case "legacy-profile-table":
      return {
        line:
          `config.toml carries a [profiles.${profile}] table, which Codex no longer supports (\`codex --profile ${profile}\` refuses to start)`,
        repair: legacyTableRepair(basename(profileFile)),
      };
    case "custom":
      return null;
    default:
      return assertNever(reason);
  }
}

/** A binary built from a checkout still at the step's own version renders an EMPTY [from, to)
 *  range (the runner's selection rule, src/migrations/index.ts; its module is not imported here
 *  because it loads the install-state .env at import), so that install gets no command to run.
 *  `agent update` is not the route: an already-updated install runs no migration. */
export function legacyTableRepair(
  profileFile: string,
  installed: string = packageVersion(),
): string {
  const from = v409CodexProfileFiles.version;
  const byHand = `move the table into ${profileFile} by hand`;
  return versionLessThan(from, installed)
    ? `run \`agent migrate ${from} ${installed}\` (moves the table into ${profileFile}), or ${byHand}`
    : byHand;
}

export function checkCodex(f: CodexFacts, profile: Profile = null): CheckResult {
  const configPath = codexConfigPath(f.home);
  // A named profile's selector lives in its own file, named on every row beside config.toml.
  const profileConfigPath = profile === null ? null : codexProfileConfigPath(f.home, profile);
  const fileLines = [
    `config.toml: ${configPath}`,
    ...(profileConfigPath === null ? [] : [`${basename(profileConfigPath)}: ${profileConfigPath}`]),
  ];
  // A named profile's whole wiring (both agents, one mode) is rewritten by ONE command, so every
  // named repair points there instead of `agent codex ...`.
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
      // The store-aware "Direct needs no gh" verdict, under the key this JSON report has always
      // used.
      directUsesToken: f.directNeedsNoGh,
    },
  };
  // A file that could not be parsed or read: the managed writers REFUSE such a file, so a re-wire
  // fix cannot land and the repair comes first (mirrors the Claude malformed/read-error arm;
  // codexOtherLine's null sends a foreign "custom" selection to the re-wire path below). Judged
  // before "no config": a named profile's broken file needs repairing whether config.toml exists.
  if (f.providerMode === "other") {
    const other = codexOtherLine(f.otherReason, configPath, profile);
    if (other !== null) {
      const rewire = profile === null ? "agent codex" : profileAddFix(profile);
      return {
        ...base,
        status: "warn",
        detail: ["provider: other", ...fileLines, other.line].join("\n"),
        fix: `${other.repair}, then re-run \`${rewire}\``,
      };
    }
  }
  // No config: fine for the default, but a NAMED profile promises both-agent wiring, so its
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
  // A NAMED profile's wiring is DERIVED from its slot's recorded mode; a managed wiring in the
  // OTHER mode is an interrupted rewire (`profile --add` switched the slot but not this agent)
  // and must not read green.
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
        ...fileLines,
        `wired ${f.providerMode}, but the profile's recorded mode is ${f.expectedMode} (out of step with the store slot)`,
      ].join("\n"),
      fix: profileAddFix(profile),
    };
  }
  if (f.providerMode === "direct") {
    // A stored token means the resolver (`agent auth --get`) needs no `gh`; wiring alone decides.
    // A gh-cli provider is probed live; with no provider at all, nothing resolves and it warns.
    const verdict = directAuthVerdict(
      {
        directUsesToken: f.directNeedsNoGh,
        provider: f.provider,
        directAuth: f.directAuth,
        credential: f.credential,
        bakedCredential: f.bakedCredential,
      },
      f.providerWired,
      directFix,
      profile,
    );
    const detail = [
      "provider: direct",
      ...fileLines,
      `model_provider ${f.modelProvider ?? "(unset)"} (direct) → ${f.baseUrl ?? "(missing)"}`,
      verdict.authLine,
    ].join("\n");
    return verdict.status === "ok"
      ? { ...base, status: "ok", detail }
      : { ...base, status: "warn", detail, fix: verdict.fix };
  }
  // Config exists: report precisely which part of the wiring is off.
  const withConfigPath = (message: string) => [...fileLines, message].join("\n");
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
    // Selected + base_url ok, but the managed proxy auth.command (the proxy-token resolver) is
    // missing or foreign.
    detail = [
      "provider: proxy",
      withConfigPath(`copilot-env proxy is not fully wired - run \`${proxyFix}\``),
    ].join("\n");
  }
  if (detail !== null) {
    return { ...base, status: "warn", detail, fix: proxyFix };
  }
  // Fully wired. The command shape resolves the key at runtime, so there is no baked value to
  // report; the static shape has one, and the daemon it addresses must be up on its own.
  const baked = bakedCredentialClause(f.bakedCredential, proxyFix);
  const detailLines = [
    "provider: proxy",
    ...fileLines,
    `model_provider ${codexProviderId(profile)} → ${f.baseUrl}`,
    f.credential === "static"
      ? `auth: local proxy key baked into the config (static-key; the daemon must be running: \`${
        agentStartCommand(profile)
      }\`${baked.clause})`
      : "auth: local proxy key via the proxy-token resolver",
  ];
  return baked.stale
    ? { ...base, status: "warn", detail: detailLines.join("\n"), fix: proxyFix }
    : { ...base, status: "ok", detail: detailLines.join("\n") };
}

/** Any key-vs-disk drift warns with the wiring pass that resolves it (the same verdict `agent
 *  codex --check` prints). */
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
  // Not built, not wanted: informational, an optional feature.
  return { ...base, status: "ok", detail: "not built (optional)" };
}

/** Keyed off the reason the classifier minted, never re-derived from paths here. */
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
  // A NAMED profile's settings file is derived from its slot's recorded mode; a managed wiring
  // in the OTHER mode is an interrupted rewire (see checkCodex).
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
    const baseOk = f.baseUrl !== null && isDirectBaseUrl(f.baseUrl);
    // A stored token means the resolver (`agent auth --get`) needs no `gh`; only the base URL
    // must be right. A gh-cli provider is probed live; with no provider at all, nothing resolves.
    const verdict = directAuthVerdict(f, baseOk, directFix, profile);
    const baseUrlLine = `ANTHROPIC_BASE_URL → ${f.baseUrl ?? "(missing)"}${
      baseOk ? "" : " (not an https Copilot host)"
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
    // Wiring presence AND that ANTHROPIC_BASE_URL points at the resolved proxy port: a stale URL
    // (after `config port` changed and the daemon rebound) would send Claude to the wrong port,
    // so it must not read green. Reachability is the proxy check's job. Mirrors the Codex check.
    const baseUrlOk = f.baseUrl !== null && f.baseUrlMatches;
    const proxyFix = profile === null
      // --proxy explicitly: the bare commands auto-detect a mode, which is not guaranteed to
      // re-bake the proxy wiring this fix is repairing.
      ? "agent claude --proxy"
      : profileAddFix(profile);
    const baked = bakedCredentialClause(f.bakedCredential, proxyFix);
    const detail = [
      "provider: proxy",
      `settings.json: ${f.settingsPath}`,
      `ANTHROPIC_BASE_URL → ${f.baseUrl ?? "(missing)"}${
        baseUrlOk ? "" : " (does not match the resolved proxy port)"
      }`,
      f.credential === "static"
        ? `credential → static ANTHROPIC_AUTH_TOKEN (static-key; the daemon must be running: \`${
          agentStartCommand(profile)
        }\`${baked.clause})`
        : `apiKeyHelper → ${f.helperPath ?? "(missing)"}`,
    ].join("\n");
    if (baseUrlOk && !baked.stale) return { ...base, status: "ok", detail };
    return {
      ...base,
      status: "warn",
      detail,
      fix: baked.stale
        ? proxyFix
        : `Re-run \`${proxyFix}\` to repoint ANTHROPIC_BASE_URL at the ${
          profile === null ? "current proxy port" : "profile's proxy port"
        }.`,
    };
  }
  if (f.providerMode === "other") {
    // Foreign wiring in the DEFAULT settings.json is the user's own business; in a NAMED
    // profile's file it is drift: the profile promises managed wiring, and `profile --add`
    // refuses to overwrite an unmanaged file, so the fix names the removal first.
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
    // Default-profile exception to "the user's own business": a settings file that could not be
    // read or parsed will trip Claude itself too.
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
  // none: fine for the default (`cl` writes proxy wiring on first launch); a NAMED profile
  // promises both-agent wiring, so its absence is an interrupted `agent profile --add`.
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

/** A rendered fix (drift) is a warn, anything else informational. The drift rule lives in
 *  renderClaudeDesktopStatus, shared with `agent claude --check`. */
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
          applied: f.applied,
          app: f.app,
        }
        : {}),
    },
  };
  const detail = lines.join("\n");
  return fix === null
    ? { ...base, status: "ok", detail }
    : { ...base, status: "warn", detail, fix };
}

/** Shared by Codex and Claude: only the ids/labels/group/scopes/fix differ. */
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

export function checkCodexLive(f: LiveProbeFacts, profile: Profile = null): CheckResult {
  return checkAgentLive("codex", f, profile);
}
export function checkClaudeLive(f: LiveProbeFacts, profile: Profile = null): CheckResult {
  return checkAgentLive("claude", f, profile);
}
