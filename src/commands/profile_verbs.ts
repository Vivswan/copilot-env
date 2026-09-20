// `agent profile [<name>] <verb> ...`: one tree for everything about one profile, routed onto one
// function per verb in src/commands/profile.ts (add del show sync check list), auth.ts (auth,
// identity), and config.ts (set unset get), each on the Profile it targets: no name is the
// default profile, null. The verbs are reserved words for a NEW profile (src/copilot_api/profile.ts),
// so `agent profile <word>` routes by the word alone. This module validates the flags and asks the
// questions; the bodies write.
import type { Command } from "commander";
import type { ManagedAgentId } from "../agents/configure.ts";
import { parseModeFlags } from "../agents/provider_mode.ts";
import { configKeyDef } from "../copilot_api/config_registry.ts";
import { configDelCommand, configGetCommand, configSetCommand } from "../copilot_api/env_config.ts";
import {
  assertKnownProfile,
  AUTH_PROVIDERS,
  type AuthProvider,
  CopilotEnvState,
} from "../copilot_api/env_state.ts";
import { ghTokenEnvVarsLabel } from "../copilot_api/gh_cli.ts";
import {
  isReservedProfileWord,
  parseProfileName,
  type Profile,
  PROFILE_VERBS,
  type ProfileVerb,
} from "../copilot_api/profile.ts";
import { prompt } from "../utils/logger.ts";
import { runAuth } from "./auth.ts";
import { type ConfigView, resolveSetPair, runConfig } from "./config.ts";
import { runDryRun } from "./dry_run.ts";
import {
  type AddArgs,
  type AddMode,
  addProfile,
  checkProfile,
  delProfile,
  listProfiles,
  modeSwitchQuestion,
  showProfile,
  syncEveryProfile,
  syncProfile,
} from "./profile.ts";
import { registerProfileOps } from "./profile_ops.ts";
import { DRY_RUN_HELP, type Opts, valueList } from "./registration.ts";

/** The `--auto` option line `add` and `init` share. */
const AUTO_HELP = "Probe Direct vs the proxy and record the verdict.";

// Keyed exhaustively on AuthProvider so a membership change in env_state.ts fails the compile here
// instead of drifting the help.
const AUTH_PROVIDER_HELP: Record<AuthProvider, string> = {
  "copilot": "device flow in the browser",
  "gh-cli": "the machine's gh login",
  "gh-token": "paste a GitHub token (or --set <token>)",
  "gh-env": ghTokenEnvVarsLabel(),
};

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

const ONE_MODE = "--direct, --proxy, and --auto are mutually exclusive (a profile has ONE mode)";

/** The three mode flags as the body's AddMode: `auto` for --auto, `unflagged` for none. */
function parseAddMode(opts: Opts): AddMode {
  if ([opts.direct, opts.proxy, opts.auto].filter(Boolean).length > 1) throw new Error(ONE_MODE);
  if (opts.auto) return "auto";
  const mode = parseModeFlags(opts, ONE_MODE);
  return mode === "auto" ? "unflagged" : mode;
}

/** `add`'s question, asked here only when an explicit flag moves a recorded mode; a probe's
 *  verdict that differs from the record is asked by the landing, after the probe. */
async function confirmModeChange(opts: Opts, rawProfile: string | null): Promise<void> {
  const mode = parseAddMode(opts);
  if (mode === "auto" || mode === "unflagged") return;
  const profile = rawProfile === null ? null : parseProfileName(rawProfile);
  const recorded = new CopilotEnvState().readProfileSlot(profile).mode;
  if (recorded === null || recorded === mode) return;
  await confirmOrRefuse(modeSwitchQuestion(profile, recorded, mode), opts, "switch the mode");
}

/** The add flags as the body's arguments (Commander stores a `--no-<x>` flag as `<x>: false`). */
function addArgs(opts: Opts): AddArgs {
  return {
    mode: parseAddMode(opts),
    dryRun: Boolean(opts.dryRun),
    noAuth: opts.auth === false,
    yes: Boolean(opts.yes),
  };
}

function agentFlag(opts: Opts): ManagedAgentId | null {
  if (opts.claude && opts.codex) throw new Error("--claude and --codex are mutually exclusive");
  if (opts.claude) return "claude";
  if (opts.codex) return "codex";
  return null;
}

/** The help group every profile verb is listed under: `agent profile --help` and, one row per
 *  verb as `profile [<name>] <verb>`, the root `agent --help` (src/cli.ts). */
const PROFILE_VERB_GROUP = "Profile:";

/** The name from the word position is passed on as the string the owning function takes, so both
 *  it and the verb validate the name in one order; a verb that owns its own read mints it.
 *  Returns the `profile` command, whose subcommands are the verbs. */
export function registerProfileCommand(program: Command, rawProfile: string | null): Command {
  const minted = (): Profile => rawProfile === null ? null : parseProfileName(rawProfile);

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
    .summary("Manage one profile; its verbs are listed below")
    .description(
      "Manage one profile, `agent profile [<name>] <verb>`: one Copilot credential and one mode, " +
        "wired into both Codex and Claude. No name is the default profile; bare `agent profile` " +
        "lists them all.",
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
      return listProfiles();
    });

  // The summary is the one-line row of the verb listings; the description is the verb's own help.
  const verb = (name: ProfileVerb, summary: string, description: string): Command =>
    profile
      .command(name)
      .helpGroup(PROFILE_VERB_GROUP)
      .summary(summary)
      .description(description)
      .allowExcessArguments();

  verb(
    "add",
    "Create or re-wire the profile, both agents",
    "Create or re-wire this profile: one mode for both Codex and Claude, plus the sign-in step " +
      "if needed (a mode change asks first). A fresh named profile needs --direct, --proxy, or --auto; " +
      "with no flag a named profile keeps its recorded mode and the default profile probes.",
  )
    .option("--direct", "Wire to GitHub Copilot Direct.")
    .option("--proxy", "Wire to the local proxy (a named profile: its own daemon).")
    .option("--auto", AUTO_HELP)
    .option("--yes", "Switch a recorded mode without asking.")
    .option("--no-auth", "Skip the sign-in; with no credential pass --direct or --proxy.")
    .option("--dry-run", DRY_RUN_HELP)
    .action(async (opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "add", rawProfile);
      if (rawProfile !== null && isReservedProfileWord(rawProfile)) {
        throw reservedWordError(rawProfile);
      }
      await confirmModeChange(opts, rawProfile);
      return addProfile(minted(), addArgs(opts));
    });

  verb(
    "del",
    "Delete the named profile everywhere",
    "Delete the named profile everywhere: its daemon, credential, both agents' wiring, and " +
      "daemon home. Asks first; the default profile cannot be deleted.",
  )
    .option("--yes", "Delete without asking.")
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
      return delProfile(parseProfileName(rawProfile), Boolean(opts.dryRun));
    });

  verb(
    "show",
    "Show its mode, provider, and daemon status",
    "Show this profile's mode, provider, and daemon status.",
  )
    .action((_opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "show", rawProfile);
      return showProfile(minted());
    });

  addAuthOptions(
    verb(
      "auth",
      "Sign in, or manage its Copilot credential",
      "Sign this profile in to GitHub Copilot, or manage its credential; both agents use it. " +
        "Default profile: `agent auth`.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "auth", rawProfile);
    return runAuth({ ...authArgs(opts), profile: rawProfile ?? undefined });
  });

  /** The face the preference verbs run as: this profile's view of the store. */
  const view = (): ConfigView => ({ kind: "profile", profile: minted() });

  verb(
    "set",
    "Set one of its preferences",
    "Set one of this profile's preferences: a profile key, or a named profile's override of a " +
      "proxy.* / probe.* key. With no name a proxy.* / probe.* key sets the shared default, as " +
      "`agent config set` does.",
  )
    .argument("<key>", "A key of `agent profile get`, or `<key>=<value>`.")
    .argument("[value]", "The value; omit it with `<key>=<value>`.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((rawKey: string, rawValue: string | undefined, opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "set", rawProfile);
      const { key, value } = resolveSetPair(
        rawKey,
        rawValue,
        `agent profile${rawProfile === null ? "" : ` ${rawProfile}`} set`,
      );
      refuseGlobalKey(key);
      if (configKeyDef(key)?.key === "identity") {
        return setIdentity(rawProfile, value, Boolean(opts.dryRun));
      }
      return runConfig({ kind: "set", key, value, view: view(), dryRun: Boolean(opts.dryRun) });
    });

  verb(
    "unset",
    "Drop one of its preferences",
    "Drop one of this profile's preferences, back to the shared or built-in default. " +
      "With no name a proxy.* / probe.* key's shared default is dropped.",
  )
    .argument("<key>", "A key of `agent profile get`.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((key: string, opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "unset", rawProfile);
      refuseGlobalKey(key);
      return runConfig({ kind: "unset", key, view: view(), dryRun: Boolean(opts.dryRun) });
    });

  verb(
    "get",
    "Show a preference in effect, and its origin",
    "Show a preference as it resolves: the value on stdout, its origin on stderr. " +
      "No key: every key of the profile.",
  )
    .argument("[key]", "A key of the profile.")
    .action((key: string | undefined, _opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "get", rawProfile);
      if (key !== undefined) refuseGlobalKey(key);
      return runConfig({ kind: "get", key, view: view() });
    });

  verb(
    "identity",
    "Show or pin the Copilot client identity",
    "Show the Copilot client identities this profile's credential is accepted under (* marks " +
      "the one in effect). A read, unless a flag pins, prints, or drops the pin.",
  )
    .option("--set <id|auto>", "Pin the identity (probed first); `auto` restores probing.")
    .option("--get", "Print the pin (`auto` when probing).")
    .option("--del", "Drop the pin (back to auto).")
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "identity", rawProfile);
      const flags = [opts.set !== undefined, Boolean(opts.get), Boolean(opts.del)].filter(Boolean);
      if (flags.length > 1) throw new Error("--set, --get, and --del are mutually exclusive");
      if (opts.set !== undefined) return setIdentity(rawProfile, String(opts.set), false);
      if (opts.get) return runConfig({ kind: "get", key: "identity", view: view() });
      if (opts.del) {
        return runConfig({ kind: "unset", key: "identity", view: view(), dryRun: false });
      }
      return runAuth({ identities: true, profile: rawProfile ?? undefined });
    });

  verb(
    "sync",
    "Rewrite its Codex and Claude config files",
    "Rewrite this profile's Codex and Claude files from its recorded mode, both agents or one. " +
      "Every profile: `agent sync`.",
  )
    .option("--claude", "Re-render Claude Code alone.")
    .option("--codex", "Re-render Codex alone.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "sync", rawProfile);
      const profile = minted();
      return syncProfile(profile, agentFlag(opts), Boolean(opts.dryRun));
    });

  verb(
    "check",
    "Report its recorded mode by exit code",
    "Report this profile's recorded mode by exit code: 0 Direct, 2 proxy, 1 none or partial.",
  )
    .option("--claude", "Claude Code's settings file: 0 Direct, 2 proxy or none, 1 other.")
    .option("--codex", "Codex's config: 0 Direct, 2 proxy or none, 1 other.")
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "check", rawProfile);
      const agent = agentFlag(opts);
      return checkProfile(minted(), agent);
    });

  // The runtime verbs (launch env proxy-token mcp start stop health models credits settings),
  // routed onto their command functions with this name.
  registerProfileOps({
    rawProfile,
    verb,
    refuseStrayWords: (cmd, name) => refuseStrayWords(cmd, name, rawProfile),
  });
  return profile;
}

/** `agent list`: every profile, one row each (bare `agent profile` prints the same). */
export function registerListCommand(program: Command): void {
  program
    .command("list")
    .helpGroup("Settings:")
    .summary("List profiles: mode, provider, daemon status")
    .description(
      "List every profile: mode, provider, daemon status. Bare `agent profile` prints the same.",
    )
    .action(() => listProfiles());
}

/** `agent sync`: every profile's re-render. */
export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .helpGroup("Settings:")
    .summary("Rewrite every profile's Codex and Claude files")
    .description(
      "Rewrite every profile's Codex and Claude config files from the recorded modes. " +
        "One profile: `agent profile [<name>] sync`.",
    )
    .option("--dry-run", DRY_RUN_HELP)
    .action((opts: Opts) => syncEveryProfile(Boolean(opts.dryRun)));
}

/** `set identity <id|auto>` and its `identity --set` alias: the credential command's pin arm
 *  (`auto` stores without a probe). A named profile must exist, as for every other key; a dry run
 *  plans the store write (the probe is a read and may run) and prints the plan. */
function setIdentity(rawProfile: string | null, value: string, dryRun: boolean): Promise<void> {
  if (rawProfile !== null) assertKnownProfile(parseProfileName(rawProfile));
  const pin = () => runAuth({ identity: value, profile: rawProfile ?? undefined });
  return dryRun ? runDryRun(pin) : pin();
}

/** `agent init`: the default's `agent profile add`, as its own command. */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .helpGroup("Setup:")
    .summary("Set up Codex and Claude for the default profile")
    .description(
      "Set up Codex and Claude for the default profile: sign in if needed, probe whether Direct " +
        "or the local proxy works, and wire both agents (a mode change asks first). " +
        "Any profile: `agent profile [<name>] add`.",
    )
    .option("--direct", "Wire both agents to GitHub Copilot Direct; no probe.")
    .option("--proxy", "Wire both agents to the local proxy; no probe.")
    .option("--auto", AUTO_HELP)
    .option("--yes", "Switch a recorded mode without asking.")
    .option("--no-auth", "Skip the sign-in; with no credential pass --direct or --proxy.")
    .option("--dry-run", DRY_RUN_HELP)
    .action(async (opts: Opts) => {
      await confirmModeChange(opts, null);
      return addProfile(null, addArgs(opts));
    });
}

/** The credential flags `agent auth` and `agent profile [<name>] auth` share, in one wording. */
function addAuthOptions(cmd: Command): Command {
  return cmd
    .option(
      "--provider <name>",
      valueList(
        "How to sign in (no flag: you choose interactively):",
        AUTH_PROVIDERS.map((p) => [p, AUTH_PROVIDER_HELP[p]] as const),
      ),
    )
    .option("--set <token>", "Store this token (implies --provider gh-token).")
    .option("--gh-user <login>", "Use this gh account (implies --provider gh-cli).")
    .option("--get", "Print the resolved GitHub token.")
    .option("--del", "Clear the stored token.")
    .option("--check", "Exit 0 if a credential resolves, else 1.")
    .option("--dry-run", "Show what would change; no login runs.");
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
      .summary("Manage the default profile's Copilot credential")
      .description(
        "Sign the default profile in to GitHub Copilot, or manage its credential; both agents " +
          "use it. Named profile: `agent profile <name> auth`.",
      ),
  ).action((opts: Opts) => runAuth(authArgs(opts)));
}
