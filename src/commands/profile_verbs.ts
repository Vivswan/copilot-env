// `agent profile [<name>] <verb> ...`: one tree for everything about one profile, routed onto one
// function per verb in src/commands/profile.ts (add del show sync check list), auth.ts (auth,
// identity), and config.ts (set unset get), each on the Profile it targets: no name is the
// default profile, null. The verbs are reserved words for a NEW profile (src/copilot_api/profile.ts),
// so `agent profile <word>` routes by the word alone. This module validates the flags and asks the
// questions; the bodies write.
import type { Command } from "commander";
import type { ManagedAgentId } from "../agents/configure.ts";
import { parseModeFlags } from "../agents/provider_mode.ts";
import {
  configDelCommand,
  configGetCommand,
  configKeyDef,
  configSetCommand,
} from "../copilot_api/env_config.ts";
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
import { type ConfigView, runConfig } from "./config.ts";
import { runDryRun } from "./dry_run.ts";
import {
  type AddArgs,
  addProfile,
  checkProfile,
  delProfile,
  listProfiles,
  showProfile,
  syncEveryProfile,
  syncProfile,
} from "./profile.ts";
// --- profile ops (src/commands/profile_ops.ts) ---
import { registerProfileOps } from "./profile_ops.ts";
// --- end profile ops ---

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

const ONE_MODE = "--direct and --proxy are mutually exclusive (a profile has ONE mode)";

/** `add`'s question, asked only when an explicit flag moves a recorded mode. */
async function confirmModeChange(opts: Opts, rawProfile: string | null): Promise<void> {
  const mode = parseModeFlags(opts, ONE_MODE);
  if (mode === "auto") return;
  const profile = rawProfile === null ? null : parseProfileName(rawProfile);
  const recorded = new CopilotEnvState().readProfileSlot(profile).mode;
  if (recorded === null || recorded === mode) return;
  const whose = rawProfile === null ? "the default profile" : `profile '${rawProfile}'`;
  await confirmOrRefuse(
    `Switch ${whose} from ${recorded} to ${mode}? Both agents' files are rewritten.`,
    opts,
    "switch the mode",
  );
}

/** The add flags as the body's arguments (Commander stores a `--no-<x>` flag as `<x>: false`). */
function addArgs(opts: Opts): AddArgs {
  return {
    mode: parseModeFlags(opts, ONE_MODE),
    dryRun: Boolean(opts.dryRun),
    noAuth: opts.auth === false,
  };
}

function agentFlag(opts: Opts): ManagedAgentId | null {
  if (opts.claude && opts.codex) throw new Error("--claude and --codex are mutually exclusive");
  if (opts.claude) return "claude";
  if (opts.codex) return "codex";
  return null;
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
      return listProfiles();
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
      if (rawProfile !== null && isReservedProfileWord(rawProfile)) {
        throw reservedWordError(rawProfile);
      }
      await confirmModeChange(opts, rawProfile);
      return addProfile(minted(), addArgs(opts));
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
      return delProfile(parseProfileName(rawProfile), Boolean(opts.dryRun));
    });

  verb("show", `Print the mode, provider, and daemon status of ${forWhom}.`)
    .action((_opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "show", rawProfile);
      return showProfile(minted());
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

  /** The face the preference verbs run as: this profile's view of the store. */
  const view = (): ConfigView => ({ kind: "profile", profile: minted() });

  verb(
    "set",
    `Set a preference of ${forWhom}: a profile key (host, identity, passthrough, static-key) ` +
      "lands in the profile's section; a named profile may also override a profile-default key " +
      "(proxy.*, probe.*), and with no name that key's shared default is written, as `agent " +
      "config set` does. `set identity <id|auto>` probes the id against the hosts before it " +
      "pins (`auto` restores probing).",
  )
    .argument("<key>", "A key of the PROFILE block of `agent profile get`.")
    .argument("<value>", "The value, parsed by the key's type.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((key: string, value: string, opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "set", rawProfile);
      refuseGlobalKey(key);
      if (configKeyDef(key)?.key === "identity") {
        return setIdentity(rawProfile, value, Boolean(opts.dryRun));
      }
      return runConfig({ kind: "set", key, value, view: view(), dryRun: Boolean(opts.dryRun) });
    });

  verb(
    "unset",
    `Drop a preference of ${forWhom}: the value falls back to the shared default, then the ` +
      "built-in one. With no name, a profile-default key's shared default is dropped, as " +
      "`agent config unset` does.",
  )
    .argument("<key>", "A key of the PROFILE block of `agent profile get`.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((key: string, opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "unset", rawProfile);
      refuseGlobalKey(key);
      return runConfig({ kind: "unset", key, view: view(), dryRun: Boolean(opts.dryRun) });
    });

  verb(
    "get",
    `Print a preference of ${forWhom} as it resolves for it: the value (stdout) and its origin ` +
      "(stderr), or with no key every key of the profile with its origin.",
  )
    .argument("[key]", "A key of the PROFILE block of `agent profile get`.")
    .action((key: string | undefined, _opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "get", rawProfile);
      if (key !== undefined) refuseGlobalKey(key);
      return runConfig({ kind: "get", key, view: view() });
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
      if (opts.set !== undefined) return setIdentity(rawProfile, String(opts.set), false);
      if (opts.get) return runConfig({ kind: "get", key: "identity", view: view() });
      if (opts.del) {
        return runConfig({ kind: "unset", key: "identity", view: view(), dryRun: false });
      }
      return runAuth({ identities: true, profile: rawProfile ?? undefined });
    });

  verb(
    "sync",
    `Re-render the agent files of ${forWhom} from its recorded mode; a mode is set by add alone. ` +
      "Both agents, or one with --claude | --codex.",
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
      return checkProfile(minted(), agent);
    });

  // --- profile ops (src/commands/profile_ops.ts): launch env proxy-token mcp start stop health
  // models credits settings, routed onto their command functions with this name ---
  registerProfileOps({
    rawProfile,
    verb,
    refuseStrayWords: (cmd, name) => refuseStrayWords(cmd, name, rawProfile),
    dryRunHelp: DRY_RUN_HELP,
  });
  // --- end profile ops ---
}

/** `agent list`: every profile, one row each (bare `agent profile` prints the same). */
export function registerListCommand(program: Command): void {
  program
    .command("list")
    .helpGroup("Settings:")
    .description(
      "Every profile with its mode, provider, and daemon status (also bare `agent profile`).",
    )
    .action(() => listProfiles());
}

/** `agent sync`: every profile's re-render. */
export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .helpGroup("Settings:")
    .description(
      "Re-render every profile's agent files from the store, the default's included; one " +
        "profile is `agent profile [<name>] sync`.",
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
    .description(
      "Set up both Codex and Claude for the default profile (auto-detect GitHub Copilot Direct " +
        "vs the proxy): the same as `agent profile add`.",
    )
    .option("--direct", "Force both agents to GitHub Copilot Direct (no auto-detect probe).")
    .option("--proxy", "Force both agents to the local copilot-api proxy (no auto-detect probe).")
    .option("--yes", "Switch a recorded mode without asking (headless use).")
    .option("--no-auth", "Print the credential step instead of running it; `agent auth` is it.")
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
