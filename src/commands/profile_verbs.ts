// `agent profile [<name>] <verb> ...`: one tree for everything about one profile, routed onto the
// functions that own each write (src/commands/profile.ts, auth.ts, init.ts, config.ts, and the
// default's per-agent re-render in src/agents/configure_defaults.ts). No name is the default
// profile. The verbs are reserved words for a NEW profile (src/copilot_api/profile.ts), so
// `agent profile <word>` routes by the word alone.
import type { Command } from "commander";
import { parseClaudeAction, parseCodexAction } from "../agents/configure.ts";
import { runClaude, runCodex } from "../agents/configure_defaults.ts";
import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import {
  MANAGED_MODE_DETAIL,
  parseModeFlags,
  providerModeExitCode,
} from "../agents/provider_mode.ts";
import { wireBothAgents } from "../agents/profile_wiring.ts";
import { inspectClaudeWiring } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { inspectCodexWiring } from "../codex/config.ts";
import { effectiveCodexHome } from "../codex/host.ts";
import { codexConfigPath, codexProfileConfigPath } from "../codex/paths.ts";
import { Credential } from "../copilot_api/credential.ts";
import { proxyStatus } from "../copilot_api/daemon.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import {
  configDelCommand,
  configGetCommand,
  configKeyDef,
  configSetCommand,
} from "../copilot_api/env_config.ts";
import {
  allProfileNames,
  assertKnownProfile,
  AUTH_PROVIDERS,
  type AuthProvider,
  CopilotEnvState,
  credentialProvider,
  partialSlotGap,
} from "../copilot_api/env_state.ts";
import { ghTokenEnvVarsLabel } from "../copilot_api/gh_cli.ts";
import {
  isReservedProfileWord,
  parseProfileName,
  type Profile,
  PROFILE_VERBS,
  profileLabel,
  type ProfileName,
  type ProfileVerb,
} from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { readTextResult } from "../utils/fs.ts";
import { createStderrLogger, prompt } from "../utils/logger.ts";
import { printKeyValue, printWrapped } from "../utils/table.ts";
import { ensureAuthenticated, runAuth } from "./auth.ts";
import { printClaudeDesktopCheck } from "./claude.ts";
import { runConfig } from "./config.ts";
import { runDryRun } from "./dry_run.ts";
import { runInit } from "./init.ts";
import { runProfile } from "./profile.ts";

/** Commander hands action callbacks an options bag of mixed-typed values. */
export type Opts = Record<string, unknown>;

/** The one wording of `--dry-run` on every writing command (the plan is src/commands/dry_run.ts). */
export const DRY_RUN_HELP =
  "Print every file and store key the command would change (old -> new, secrets redacted) and write nothing.";

// Keyed exhaustively on AuthProvider so a membership change in env_state.ts fails the compile here
// instead of drifting the help.
const AUTH_PROVIDER_HELP: Record<AuthProvider, string> = {
  "copilot": "device flow, read:user scope",
  "gh-cli": "use the machine's gh login",
  "gh-token": "paste a GitHub token, or --set <token>",
  "gh-env": `copy a token from ${ghTokenEnvVarsLabel()} - for headless servers`,
};

/** The providers as natural-language help: "'a' (...), 'b' (...), or 'c' (...)". */
function authProviderChoicesHelp(): string {
  const parts = AUTH_PROVIDERS.map((p) => `'${p}' (${AUTH_PROVIDER_HELP[p]})`);
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

const VERB_LIST = PROFILE_VERBS.join(" | ");

export interface ProfileInvocation {
  /** The user's arguments with the name taken out, for Commander. */
  args: string[];
  /** The bare word after `profile` when it is not a verb. Passed on as the string the owning
   *  function takes, so it validates the name in its own order. */
  profile: string | null;
}

/** Pulls `<name>` out of `profile <name> <verb> ...`. Total: any bare word after `profile` that is
 *  not a verb (or Commander's `help`) is the name; a flag or a verb there means the default. */
export function splitProfileInvocation(args: readonly string[]): ProfileInvocation {
  const [command, word, ...rest] = args;
  if (
    command !== "profile" || word === undefined || word.startsWith("-") ||
    isReservedProfileWord(word)
  ) {
    return { args: [...args], profile: null };
  }
  return { args: ["profile", ...rest], profile: word };
}

// Narration to stderr, so `show`'s and `get`'s stdout stay the payload.
const logger = createStderrLogger();

function reservedWordError(word: string): Error {
  return new Error(
    `'${word}' is a reserved word (it is a verb of \`agent profile\`), not a profile name`,
  );
}

/** A verb's stray operand is a name in the wrong place or a verb used as a name; the verbs take
 *  excess arguments only so this can say which. */
function refuseStrayWords(cmd: Command, verb: ProfileVerb, rawProfile: string | null): void {
  const [word] = cmd.args.slice(cmd.registeredArguments.length);
  if (word === undefined) return;
  if (isReservedProfileWord(word)) throw reservedWordError(word);
  if (rawProfile === null) {
    throw new Error(
      `the profile name goes before the verb: \`agent profile ${word} ${verb} ...\``,
    );
  }
  throw new Error(`\`agent profile ${rawProfile} ${verb}\` takes no '${word}' argument`);
}

/** A key of every profile belongs here; a machine-wide key has no per-profile value. */
function refuseGlobalKey(key: string): void {
  const def = configKeyDef(key);
  if (def === undefined || def.scope !== "global") return;
  throw new Error(
    `'${def.key}' is a global preference (this machine, every profile): \`${
      configGetCommand(def.key)
    }\`, \`${configSetCommand(def.key, "<value>")}\`, or \`${configDelCommand(def.key)}\``,
  );
}

/** `del` always asks, `add` only before a mode change. `--yes` answers it, and `--dry-run`
 *  writes nothing so it asks nothing; a script with neither is refused before anything runs. */
async function confirmOrRefuse(question: string, opts: Opts, what: string): Promise<void> {
  if (opts.yes || opts.dryRun) return;
  if (!process.stdin.isTTY) {
    throw new Error(`not a terminal - pass --yes to ${what} non-interactively`);
  }
  const confirmed = await prompt(question, { type: "confirm", initial: false });
  if (confirmed !== true) throw new Error(`${what} aborted - nothing was changed`);
}

/** The recorded mode of a profile, for the add question: null when it has none yet. */
function recordedMode(rawProfile: string | null): "direct" | "proxy" | null {
  const profile = rawProfile === null ? null : parseProfileName(rawProfile);
  return new CopilotEnvState().readProfileSlot(profile).mode;
}

/** `add`'s question, asked only when an explicit flag moves a recorded mode. */
async function confirmModeChange(opts: Opts, rawProfile: string | null): Promise<void> {
  const mode = parseModeFlags(
    opts,
    "--direct and --proxy are mutually exclusive (a profile has ONE mode)",
  );
  if (mode === "auto") return;
  const recorded = recordedMode(rawProfile);
  if (recorded === null || recorded === mode) return;
  const whose = rawProfile === null ? "the default profile" : `profile '${rawProfile}'`;
  await confirmOrRefuse(
    `Switch ${whose} from ${recorded} to ${mode}? Both agents' files are rewritten.`,
    opts,
    "switch the mode",
  );
}

/** The credential step `add` runs on a profile that has none: `auth`'s interactive flow, which
 *  then wires both agents. `--no-auth` leaves it to `auth` and says so; a dry run names it; a
 *  script with neither is refused BEFORE the mode lands, so nothing is half done. A profile with
 *  a credential is never asked again. */
function credentialStep(profile: Profile, opts: Opts): () => Promise<void> {
  // Resolving, not merely stored: a gh-cli slot whose gh login is gone is as good as none.
  if (new Credential(undefined, profile).isAuthenticated()) return () => Promise.resolve();
  const authCommand = profile === null ? "agent auth" : `agent profile ${profile} auth`;
  const providers = `--provider <${
    AUTH_PROVIDERS.join("|")
  }>  (or --set <token>, --gh-user <login>)`;
  // Commander stores a `--no-<x>` flag as `<x>: false`.
  if (opts.auth === false) {
    return () => {
      logger.log(`  Next:  ${authCommand} ${providers}`);
      return Promise.resolve();
    };
  }
  if (opts.dryRun) {
    return () => {
      logger.log(`  Would run the credential step (${authCommand}); a dry run never logs in.`);
      return Promise.resolve();
    };
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `not a terminal - pass --no-auth to record the mode alone, then \`${authCommand} ${providers}\``,
    );
  }
  return () => ensureAuthenticated(profile);
}

function agentFlag(opts: Opts): "claude" | "codex" | null {
  if (opts.claude && opts.codex) throw new Error("--claude and --codex are mutually exclusive");
  if (opts.claude) return "claude";
  if (opts.codex) return "codex";
  return null;
}

interface AgentCommandFlags {
  check: boolean;
  dryRun: boolean;
}

/** The default's Claude re-render or file check (`profile sync|check --claude`). */
function runClaudeCommand(flags: AgentCommandFlags): Promise<void> {
  const action = parseClaudeAction({ ...flags, mode: "auto" });
  switch (action.kind) {
    case "check":
      // The exit code stays the provider-mode contract; the Desktop status only prints.
      return runClaude(action).then(() => printClaudeDesktopCheck());
    case "configure": {
      // The default's Desktop entry rode on the write itself; the reconcile covers the named
      // profiles.
      const land = () =>
        ensureAuthenticated()
          .then(() => runClaude(action))
          .then(() => reconcileClaudeDesktopWiring());
      return flags.dryRun ? runDryRun(land) : land();
    }
    default:
      return assertNever(action);
  }
}

/** The default's Codex re-render or file check (`profile sync|check --codex`). */
function runCodexCommand(flags: AgentCommandFlags): Promise<void> {
  const action = parseCodexAction({ ...flags, mode: "auto", mobile: false });
  switch (action.kind) {
    case "mobile":
      throw new Error("the Codex pairing flow is `agent codex-mobile`");
    case "check":
      return runCodex(action);
    case "configure": {
      // A re-render of the recorded default mode; `agent profile add` is what sets or moves it.
      const land = () => ensureAuthenticated().then(() => runCodex(action));
      return flags.dryRun ? runDryRun(land) : land();
    }
    default:
      return assertNever(action);
  }
}

/** The store slot's answer for the default, on the launcher exit-code contract (a named
 *  profile's reaches the same slot through runProfile). */
function runDefaultSlotCheck(): void {
  const slot = new CopilotEnvState().readProfileSlot(null);
  switch (slot.kind) {
    case "partial":
      printKeyValue("default", slot.mode ?? "none");
      printWrapped("  the default profile has no complete wiring yet - run `agent init`");
      process.exitCode = providerModeExitCode("other");
      return;
    case "complete":
      printKeyValue(profileLabel(null), slot.mode);
      process.exitCode = providerModeExitCode(slot.mode);
      return;
    default:
      assertNever(slot);
  }
}

/** One agent's file of a NAMED profile, read as the launcher reads it: `settings-<name>.json`, or
 *  `<name>.config.toml`'s selection into config.toml. The exit code is the provider-mode
 *  contract, as for the default's per-agent check. */
function runNamedAgentCheck(name: ProfileName, agent: "claude" | "codex"): void {
  const port = Number(copilotApiResolvePort(name));
  if (agent === "claude") {
    const path = settingsPathFor(resolveClaudeHome(), name);
    const status = inspectClaudeWiring(readTextResult(path), port, name);
    printKeyValue("Claude provider mode", modeDetail(status.providerMode));
    printKeyValue(`settings-${name}.json`, path);
    process.exitCode = providerModeExitCode(status.providerMode);
    return;
  }
  const home = effectiveCodexHome();
  const profileToml = codexProfileConfigPath(home, name);
  const status = inspectCodexWiring(
    readTextResult(codexConfigPath(home)),
    null,
    port,
    false,
    { profile: name, profileToml: readTextResult(profileToml) },
  );
  printKeyValue("Codex provider mode", modeDetail(status.providerMode));
  printKeyValue(`${name}.config.toml`, profileToml);
  process.exitCode = providerModeExitCode(status.providerMode);
}

function modeDetail(mode: "direct" | "proxy" | "other" | "none"): string {
  switch (mode) {
    case "direct":
    case "proxy":
      return `${mode} (${MANAGED_MODE_DETAIL[mode]})`;
    case "other":
      return "other (a provider copilot-env does not manage)";
    case "none":
      return "none (not wired)";
    default:
      return assertNever(mode);
  }
}

/** One profile's row of the list, as key/value lines: the same words. */
async function runShow(profile: Profile): Promise<void> {
  if (profile !== null) assertKnownProfile(profile);
  const slot = new CopilotEnvState().readProfileSlot(profile);
  const daemon = slot.mode === "proxy" ? await proxyStatus(profile) : null;
  printWrapped(profileLabel(profile));
  printKeyValue("  mode", slot.mode ?? "incomplete");
  printKeyValue("  provider", credentialProvider(slot.credential) ?? "no credential");
  // A direct profile has no daemon: "-", never a blank that reads as missing data.
  printKeyValue(
    "  daemon",
    daemon === null ? "-" : daemon.up ? `up (port ${daemon.port})` : "down",
  );
}

/** The list, then the one hint the list cannot carry: a profile named before its word became a
 *  verb routes as the verb here, and the update's migration renames it. */
async function runList(): Promise<void> {
  await runProfile({ list: true, mode: "auto" });
  for (const name of allProfileNames().filter(isReservedProfileWord)) {
    logger.warn(
      `profile '${name}' is named like a verb of \`agent profile\`; \`agent update\` renames it ` +
        `to '${name}-<n>'. Until then address it with \`--profile ${name}\` on the runtime commands.`,
    );
  }
}

/** The named re-render `agent sync` runs for every profile, for this one profile. */
async function syncNamed(name: ProfileName): Promise<void> {
  const slot = new CopilotEnvState().readProfileSlot(name);
  if (slot.kind === "partial") throw new Error(partialSlotGap(name, slot));
  await wireBothAgents(name, slot.mode, true, "stored");
}

/** The default's re-render, both agents. */
function syncDefault(): Promise<void> {
  const configure = { kind: "configure", mode: "auto" } as const;
  return ensureAuthenticated()
    .then(() => runClaude(configure))
    .then(() => runCodex(configure))
    .then(() => reconcileClaudeDesktopWiring());
}

/** The name from the word position is passed on as the string the owning function takes, so both
 *  it and the verb validate the name in one order; a verb that owns its own read mints it. */
export function registerProfileCommand(program: Command, rawProfile: string | null): void {
  const minted = (): Profile => rawProfile === null ? null : parseProfileName(rawProfile);
  /** The optional name in each verb's help. */
  const forWhom = "the named profile, or the default profile when no name is given";

  const profile = program
    .command("profile")
    .helpGroup("Settings:")
    .usage("[<name>] <verb> [options]")
    // The verbs' flags stay theirs: without this the parent would eat an `--direct` after `add`.
    .enablePositionalOptions()
    // A first word that is no verb (a reserved runtime name, a typo) carries the rest into the
    // bare action, whose diagnostic names the word; Commander would otherwise reject the flag
    // after it as unknown first.
    .passThroughOptions()
    // The bare action handler would otherwise suppress `agent profile help <verb>`.
    .helpCommand(true)
    .description(
      "Everything about one profile (one credential + one mode, wired into BOTH agents): " +
        `agent profile [<name>] <verb>, where the verbs are ${VERB_LIST} and no name means the ` +
        "default profile. Bare `agent profile` lists every profile, as `agent list` does.",
    )
    .allowExcessArguments()
    .action((_opts: Opts, cmd: Command) => {
      if (rawProfile !== null) {
        throw new Error(`\`agent profile ${rawProfile}\` takes a verb (${VERB_LIST})`);
      }
      // A reserved word that is not a verb (`list`, a runtime command's name) lands here.
      const [word] = cmd.args;
      if (word === "list") {
        throw new Error(
          "'list' is a reserved word; the listing is `agent list` (or bare `agent profile`)",
        );
      }
      if (word !== undefined) throw reservedWordError(word);
      return runList();
    });

  const verb = (name: ProfileVerb, description: string): Command =>
    profile.command(name).description(description).allowExcessArguments();

  verb(
    "add",
    `Create or re-wire ${forWhom}: one mode for BOTH agents, the mode alone. The default: no ` +
      "flag probes GitHub Copilot Direct vs the proxy on a fresh default (a recorded mode is " +
      "re-wired as it is), and prints the next steps. A named " +
      "profile: records the mode, then runs the credential step (`auth`'s flow, which wires " +
      "both agents) unless --no-auth. Re-add with the other flag to switch modes (asks first).",
  )
    .option("--direct", "Wire to GitHub Copilot Direct.")
    .option("--proxy", "Wire to the local copilot-api proxy (a named profile: its own daemon).")
    .option("--yes", "Switch a recorded mode without asking (headless use).")
    .option("--no-auth", "Record the mode alone; the credential step is left to `auth`.")
    .option("--dry-run", DRY_RUN_HELP)
    .action(async (opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "add", rawProfile);
      if (rawProfile === null) return runDefaultAdd(opts);
      if (isReservedProfileWord(rawProfile)) throw reservedWordError(rawProfile);
      await confirmModeChange(opts, rawProfile);
      const step = credentialStep(parseProfileName(rawProfile), opts);
      await runProfile({
        add: rawProfile,
        mode: parseModeFlags(
          opts,
          "--direct and --proxy are mutually exclusive (a profile has ONE mode)",
        ),
        dryRun: Boolean(opts.dryRun),
      });
      await step();
    });

  verb(
    "del",
    "Delete the named profile everywhere: stop its daemon, clear its credential, strip both " +
      "agents' wiring, remove its daemon home. A preference is dropped with `unset <key>`; the " +
      "default profile is not deletable. Asks first; --yes answers.",
  )
    .option("--yes", "Delete without asking (headless use).")
    .option("--dry-run", DRY_RUN_HELP)
    .action(async (opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "del", rawProfile);
      if (rawProfile === null) {
        throw new Error(
          "the default profile cannot be deleted; `agent uninstall` removes everything " +
            "(`agent profile auth --del` clears its credential)",
        );
      }
      await confirmOrRefuse(
        `Delete profile '${rawProfile}' everywhere (its daemon, credential, both agents' ` +
          "wiring, and daemon home)?",
        opts,
        "delete the profile",
      );
      return runProfile({ del: rawProfile, mode: "auto", dryRun: Boolean(opts.dryRun) });
    });

  verb("show", `Print the mode, provider, and daemon status of ${forWhom}.`)
    .action((_opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "show", rawProfile);
      return runShow(minted());
    });

  addAuthOptions(
    verb(
      "auth",
      `Manage the GitHub Copilot credential of ${forWhom} (the single source of truth for ` +
        "Direct). A named profile never falls back to the default credential; `agent auth` is " +
        "the default's alias.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "auth", rawProfile);
    return runAuth({ ...authArgs(opts), profile: rawProfile ?? undefined });
  });

  verb(
    "set",
    `Set a preference of ${forWhom}: a profile key (host, identity, passthrough, static-key) ` +
      "lands in the profile's section; a named profile may also override a profile-default key " +
      "(proxy.*, probe.*), and with no name that key's shared default is written, as `agent " +
      "config --set` does. `set identity <id|auto>` probes the id against the hosts before it " +
      "pins (`auto` restores probing).",
  )
    .argument("<key>", "A key of the PROFILE block of `agent config --help`.")
    .argument("<value>", "The value, parsed by the key's type.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((key: string, value: string, opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "set", rawProfile);
      refuseGlobalKey(key);
      if (configKeyDef(key)?.key === "identity") {
        if (opts.dryRun) {
          throw new Error("`set identity` probes the id and pins it; it has no --dry-run");
        }
        return setIdentity(rawProfile, value);
      }
      return runConfig({
        set: [key, value],
        profile: rawProfile ?? undefined,
        dryRun: Boolean(opts.dryRun),
      });
    });

  verb(
    "unset",
    `Drop a preference of ${forWhom}: the value falls back to the shared default, then the ` +
      "built-in one. With no name, a profile-default key's shared default is dropped, as " +
      "`agent config --del` does.",
  )
    .argument("<key>", "A key of the PROFILE block of `agent config --help`.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((key: string, opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "unset", rawProfile);
      refuseGlobalKey(key);
      return runConfig({
        del: key,
        profile: rawProfile ?? undefined,
        dryRun: Boolean(opts.dryRun),
      });
    });

  verb(
    "get",
    `Print a preference of ${forWhom} as it resolves for it: one value for scripts, or the ` +
      "whole table with no key.",
  )
    .argument("[key]", "A key of the PROFILE block of `agent config --help`.")
    .action((key: string | undefined, _opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "get", rawProfile);
      if (key !== undefined) refuseGlobalKey(key);
      return runConfig({ get: key ?? true, profile: rawProfile ?? undefined });
    });

  verb(
    "identity",
    `The Copilot client identities the credential of ${forWhom} is accepted under, on the ` +
      "Direct and the proxy host (* marks the one in effect); a read, never a write. The flags " +
      "are aliases: --set <id|auto> is `set identity <id|auto>`, --get is `get identity`, --del " +
      "is `unset identity`.",
  )
    .option("--set <id|auto>", "Pin the identity (probed first); `auto` restores probing.")
    .option("--get", "Print the identity in effect.")
    .option("--del", "Drop the pin (back to auto).")
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "identity", rawProfile);
      const flags = [opts.set !== undefined, Boolean(opts.get), Boolean(opts.del)].filter(Boolean);
      if (flags.length > 1) throw new Error("--set, --get, and --del are mutually exclusive");
      const profile = rawProfile ?? undefined;
      if (opts.set !== undefined) return setIdentity(rawProfile, String(opts.set));
      if (opts.get) return runConfig({ get: "identity", profile });
      if (opts.del) return runConfig({ del: "identity", profile });
      return runAuth({ identities: true, profile });
    });

  verb(
    "sync",
    `Re-render the agent files of ${forWhom} from its recorded mode; a mode is set by add alone. ` +
      "Both agents, or one with --claude | --codex (a named profile is written as a pair, so " +
      "both of its files are re-rendered and the line says so).",
  )
    .option("--claude", "Re-render Claude Code alone.")
    .option("--codex", "Re-render Codex alone.")
    .option("--dry-run", DRY_RUN_HELP)
    .action(async (opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "sync", rawProfile);
      const name = minted();
      const agent = agentFlag(opts);
      const dryRun = Boolean(opts.dryRun);
      if (name !== null) {
        const land = () => syncNamed(name);
        if (dryRun) {
          await runDryRun(land);
          return;
        }
        await land();
        logger.log(
          agent === null
            ? `  ✓ Synced ${profileLabel(name)}.`
            : `  ✓ Synced ${profileLabel(name)}: both agents were re-rendered (a named profile ` +
              `is written as a pair; --${agent} names the one you asked about).`,
        );
        return;
      }
      const flags = { check: false, dryRun };
      switch (agent) {
        case "claude":
          return runClaudeCommand(flags);
        case "codex":
          return runCodexCommand(flags);
        case null:
          return dryRun ? runDryRun(syncDefault) : syncDefault();
        default:
          return assertNever(agent);
      }
    });

  verb(
    "check",
    `Report the recorded mode of ${forWhom} and exit (0 direct, 2 proxy, 1 no or incomplete ` +
      "profile) - the launcher probe. With --claude | --codex, that agent's own file instead " +
      "(0 direct, 2 proxy or none, 1 other); the default's Claude check adds the Claude Desktop " +
      "status.",
  )
    .option("--claude", "Claude Code's configured provider (its settings file).")
    .option("--codex", "Codex's configured provider (its config selection).")
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "check", rawProfile);
      const agent = agentFlag(opts);
      if (rawProfile !== null) {
        if (agent === null) return runProfile({ check: rawProfile, mode: "auto" });
        runNamedAgentCheck(parseProfileName(rawProfile), agent);
        return Promise.resolve();
      }
      const flags = { check: true, dryRun: false };
      switch (agent) {
        case "claude":
          return runClaudeCommand(flags);
        case "codex":
          return runCodexCommand(flags);
        case null:
          runDefaultSlotCheck();
          return Promise.resolve();
        default:
          return assertNever(agent);
      }
    });
}

/** `agent list`: every profile, one row each (bare `agent profile` prints the same). */
export function registerListCommand(program: Command): void {
  program
    .command("list")
    .helpGroup("Settings:")
    .description(
      "Every profile with its mode, provider, and daemon status (also bare `agent profile`).",
    )
    .action(() => runList());
}

/** `agent sync`: every profile's re-render (the `cx --profile` hook). */
/** `agent sync`: every profile's re-render. The default's is `profile sync`'s (each agent's own,
 *  the Desktop entry discovered); the named loop (`runProfile({ sync })`) is the launcher's quiet
 *  hook and stays discovery-free, so the default is not folded into it. */
export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .helpGroup("Settings:")
    .description(
      "Re-render every profile's agent files from the store, the default's included; one " +
        "profile is `agent profile [<name>] sync`.",
    )
    .option("--dry-run", DRY_RUN_HELP)
    .action(async (opts: Opts) => {
      const dryRun = Boolean(opts.dryRun);
      if (new CopilotEnvState().readProfileSlot(null).kind === "complete") {
        await (dryRun ? runDryRun(syncDefault) : syncDefault());
      }
      await runProfile({ sync: true, mode: "auto", dryRun });
    });
}

/** The default's add (`agent init` and `agent profile add` with no name): both agents, the
 *  Direct-vs-proxy probe with no flag. The default's credential is `auth`'s, never a flag here. */
async function runDefaultAdd(opts: Opts): Promise<void> {
  await confirmModeChange(opts, null);
  // The probe sets a mode on a fresh default; a recorded one is re-wired as it is (a flag moves
  // it, and asks), so no unflagged add can move a mode by a probe's answer.
  const requested = parseModeFlags(opts);
  const mode = requested === "auto" ? recordedMode(null) ?? "auto" : requested;
  const step = credentialStep(null, opts);
  // The default's mode record has one writer, the landing that follows its credential, so with
  // no resolving credential the step is all that runs here: the flow (runInit's own), the
  // --no-auth next step, or the dry run's planned line.
  if (!new Credential().isAuthenticated() && (opts.auth === false || opts.dryRun)) {
    await step();
    logger.log(`  then:  agent init${mode === "auto" ? "" : ` --${mode}`}`);
    return;
  }
  return runInit({ mode, dryRun: Boolean(opts.dryRun) });
}

/** `set identity <id|auto>` and its `identity --set` alias: the probe-backed pin (`auto` stores
 *  without one), the same arm `agent auth --identity` ran. */
function setIdentity(rawProfile: string | null, value: string): Promise<void> {
  return runAuth({ identity: value, profile: rawProfile ?? undefined });
}

/** `agent init`: the default's `agent profile add`, as its own command. */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .helpGroup("Setup:")
    .description(
      "Set up both Codex and Claude for the default profile (auto-detect GitHub Copilot Direct " +
        "vs the proxy): the same as `agent profile add`.",
    )
    .option("--direct", "Force both agents to GitHub Copilot Direct (no auto-detect probe).")
    .option("--proxy", "Force both agents to the local copilot-api proxy (no auto-detect probe).")
    .option("--yes", "Switch a recorded mode without asking (headless use).")
    .option("--no-auth", "Print the credential step instead of running it; `agent auth` is it.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((opts: Opts) => runDefaultAdd(opts));
}

/** The credential flags `agent auth` and `agent profile [<name>] auth` share, in one wording. */
function addAuthOptions(cmd: Command): Command {
  return cmd
    .option(
      "--provider <provider>",
      `How to authenticate (no flag => interactive choice): ${authProviderChoicesHelp()}.`,
    )
    .option(
      "--set <token>",
      "Non-interactive gh-token: store this token verbatim. Implies --provider gh-token.",
    )
    .option(
      "--gh-user <login>",
      "Pin gh-cli to this logged-in gh account (omit = follow gh's active account). " +
        "Implies --provider gh-cli.",
    )
    .option(
      "--get",
      "Print the resolved token to stdout (provider-driven: gh-cli → `gh auth token`, " +
        "copilot/gh-token/gh-env → the stored token). The resolver the agent files shell into.",
    )
    .option("--del", "Clear the stored token (de-authenticate).")
    .option("--check", "Report auth status and exit (0 authenticated, 1 not).")
    .option(
      "--dry-run",
      `${DRY_RUN_HELP} No login runs: the slot write is planned from --set or --gh-user (a device flow is named, not run), so --provider is required when no credential resolves.`,
    );
}

/** The shared flags as runAuth's arguments; the caller adds `profile`. */
function authArgs(opts: Opts): {
  provider?: string;
  set?: string;
  ghUser?: string;
  get: boolean;
  del: boolean;
  check: boolean;
  dryRun: boolean;
} {
  return {
    provider: opts.provider as string | undefined,
    set: opts.set as string | undefined,
    ghUser: opts.ghUser as string | undefined,
    get: Boolean(opts.get),
    del: Boolean(opts.del),
    check: Boolean(opts.check),
    dryRun: Boolean(opts.dryRun),
  };
}

/** `agent auth`: the default's `agent profile auth`, as its own command. */
export function registerAuthCommand(program: Command): void {
  addAuthOptions(
    program
      .command("auth")
      .helpGroup("Settings:")
      .description(
        "Manage the default profile's GitHub Copilot credential (the single source of truth for " +
          "Direct): the same as `agent profile auth`. A named profile's is `agent profile <name> auth`.",
      ),
  ).action((opts: Opts) => runAuth(authArgs(opts)));
}
