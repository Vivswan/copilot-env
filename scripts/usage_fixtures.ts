// CLI over generateUsageTree (test/helpers/usage_fixtures.ts); prints one JSON summary line.
// `firstDay`/`lastDay` are the UTC calendar days the tree's events span, inclusive, so a
// consumer can size `agent cost --days` (a host west of UTC allows one extra day).
import { localDayKey } from "../src/utils/time.ts";
import { DEFAULT_DAYS, DEFAULT_END, generateUsageTree } from "../test/helpers/usage_fixtures.ts";

function usage(): string {
  return `Usage: deno run -P=test scripts/usage_fixtures.ts --out DIR --mb N --seed N [--days N] [--end ISO] [--no-adversarial]

Writes <DIR>/.codex/sessions/... and <DIR>/.claude/projects/... totalling about
N MiB, deterministic for a given seed. Point agent cost at the tree with
HOME=<DIR> CODEX_HOME=<DIR>/.codex CLAUDE_CONFIG_DIR=<DIR>/.claude
COPILOT_API_HOME=<DIR>/.copilot-env.

  --days N          calendar days the sessions spread over (default ${DEFAULT_DAYS})
  --end ISO         the instant the window ends at (default ${DEFAULT_END})
  --no-adversarial  plain trees: no torn tail, needles, archives, forks, repeated counts,
                    or cross-file resumes (long in-session gaps still occur)`;
}

function die(message: string): never {
  console.error(message);
  Deno.exit(1);
}

interface Args {
  out: string;
  mb: number;
  seed: number;
  days: number;
  end: string;
  adversarial: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { days: DEFAULT_DAYS, end: DEFAULT_END, adversarial: true };
  const number = (flag: string, value: string | undefined, integer: boolean): number => {
    const n = Number(value);
    if (value === undefined || !Number.isFinite(n) || (integer && !Number.isInteger(n))) {
      die(`${flag} needs ${integer ? "an integer" : "a number"}, got '${value ?? ""}'`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        Deno.exit(0);
        break;
      case "--out":
        if (value === undefined) die("--out needs a directory");
        args.out = value;
        i++;
        break;
      case "--mb":
        args.mb = number(arg, value, false);
        i++;
        break;
      case "--seed":
        args.seed = number(arg, value, true);
        i++;
        break;
      case "--days":
        args.days = number(arg, value, true);
        i++;
        break;
      case "--end":
        if (value === undefined) die("--end needs an ISO instant");
        args.end = value;
        i++;
        break;
      case "--no-adversarial":
        args.adversarial = false;
        break;
      default:
        die(`unknown argument '${arg}'\n\n${usage()}`);
    }
  }
  if (args.out === undefined || args.mb === undefined || args.seed === undefined) {
    die(`--out, --mb and --seed are required\n\n${usage()}`);
  }
  return args as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  const startedAt = performance.now();
  const tree = await generateUsageTree({
    root: args.out,
    mb: args.mb,
    seed: args.seed,
    days: args.days,
    end: args.end,
    adversarial: args.adversarial,
  });
  const bytes = tree.files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(JSON.stringify({
    root: tree.root,
    files: tree.files.length,
    bytes,
    mb: args.mb,
    seed: args.seed,
    firstDay: localDayKey(tree.firstEventMs, "UTC"),
    lastDay: localDayKey(tree.lastEventMs, "UTC"),
    seconds: Math.round((performance.now() - startedAt) / 10) / 100,
  }));
}

await main();
