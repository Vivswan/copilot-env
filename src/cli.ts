// The entry behind bin/agent, bin/agent.ps1, and the `deno compile` binary. Commander rather than
// citty so unknown flags are rejected (`error: unknown option '--x'`, exit 1) instead of silently
// accepted, and so help wraps to the terminal width natively. Every command registers from
// src/commands/ (profile_verbs.ts, profile_ops.ts, machine.ts); this file owns the program alone.
import "./utils/dotenv.ts";
import { Command } from "commander";
import { consola } from "consola";
import { registerMachineCommands } from "./commands/machine.ts";
import { registerDaemonAliases, registerEverywhereCommands } from "./commands/profile_ops.ts";
import {
  registerAuthCommand,
  registerInitCommand,
  registerListCommand,
  registerProfileCommand,
  registerSyncCommand,
  splitProfileInvocation,
} from "./commands/profile_verbs.ts";
import { bold, cyan, gray } from "./utils/ansi.ts";
import { spawnedByDryRun, withDryRun } from "./utils/dry_run.ts";
import { errMessage } from "./utils/error.ts";
import { configureConsolaOutput } from "./utils/logger.ts";
import { terminalWidth } from "./utils/table.ts";
import { packageVersion } from "./utils/version.ts";

configureConsolaOutput();

// `agent profile <name> <verb>` carries the name in the word position, which Commander has no
// slot for: it is split off here, before the tree is built, and the profile verbs close over it.
const invocation = splitProfileInvocation(process.argv.slice(2));

const program = new Command();

program
  .name("agent")
  .description("Manage the local proxy and wire Codex + Claude.")
  .version(packageVersion(), "--version", "Print the version and exit.")
  .helpOption("--help", "Show this help.")
  // Options are read up to the command word and the rest handed on, so a flag `agent profile` and
  // one of its verbs both spell (`--set`, `--dry-run`) reaches the verb. The root's own flags
  // (`--version`, `--full-help`) then come before the command, as they always have.
  .enablePositionalOptions()
  .option("--full-help", "Print help for `agent` and every subcommand, then exit.");

// The option:full-help listener fires during parse, before any "missing command" handling, so it
// works with no subcommand.
/** Commander's own help wraps at this width, so the divider never runs past it. */
const HELP_DIVIDER_COLUMNS = 72;

program.on("option:full-help", () => {
  const sep = "─".repeat(Math.min(terminalWidth() ?? HELP_DIVIDER_COLUMNS, HELP_DIVIDER_COLUMNS));
  // `helpInformation()` omits `addHelpText('after', ...)` (the `config` key list), which is emitted
  // via help events during outputHelp(); those events are captured into a string instead.
  const renderHelp = (cmd: Command): string => {
    let out = "";
    const saved = cmd.configureOutput();
    cmd.configureOutput({
      writeOut: (s) => {
        out += s;
      },
    });
    cmd.outputHelp();
    cmd.configureOutput(saved);
    return out;
  };
  const parts = [renderHelp(program)];
  for (const cmd of program.commands) {
    if (cmd.name() === "help") continue;
    parts.push(`${sep}\nagent ${cmd.name()}\n${sep}\n${renderHelp(cmd)}`);
    for (const sub of cmd.commands) {
      if (sub.name() === "help") continue;
      parts.push(`${sep}\nagent ${cmd.name()} ${sub.name()}\n${sep}\n${renderHelp(sub)}`);
    }
  }
  process.stdout.write(parts.join("\n"));
  process.exit(0);
});

// The ansi.ts helpers no-op under NO_COLOR / TERM=dumb / CI / test runs, so these hooks degrade to
// plain text on their own; Commander still owns all layout and width-wrapping.
program.configureHelp({
  styleTitle: bold,
  styleCommandText: cyan,
  styleOptionTerm: cyan,
  styleSubcommandTerm: cyan,
  styleDescriptionText: gray,
});

// Commander renders help groups in first-appearance order, so `init` and `profile` come first.
registerInitCommand(program);
registerProfileCommand(program, invocation.profile);
registerAuthCommand(program);
registerListCommand(program);
registerSyncCommand(program);
// The default profile's `start` and `stop`, then the every-profile `health`, `credits`, and
// `settings`.
registerDaemonAliases(program);
registerEverywhereCommands(program);
// config, cost, codex-mobile, update, shell, install, uninstall, migrate.
registerMachineCommands(program);

if (import.meta.main) {
  // A child of a dry run (the Direct probes' agent CLIs run this CLI as their auth helper) is a
  // silent dry run: its bookkeeping lands nothing, and it prints no plan of its own. The marker is
  // the one the spawning dry run minted (DRY_RUN_ENV), so a value that reached the environment any
  // other way changes nothing here.
  const run = (): Promise<unknown> => program.parseAsync(invocation.args, { from: "user" });
  const silent = async (): Promise<void> => {
    const outcome = await withDryRun(run);
    if (outcome.status === "failed") throw outcome.error;
  };
  (spawnedByDryRun() ? silent() : run()).catch((e: unknown) => {
    consola.error(errMessage(e));
    // exitCode, not process.exit, so pending stderr writes flush.
    process.exitCode = 1;
  });
}
