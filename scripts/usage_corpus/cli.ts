// Arguments, the usage contract, the label-only runtime log, and the ledger of every file the
// driver writes or removes (reported in the summary line).
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

interface Args {
  out: string;
  real: boolean;
}

function usage(): string {
  return `Usage: deno task usage:corpus -- --out <dir> [--real]

Runs the installed claude and codex CLIs (both required) through five scripted turns each
against the fake inference backend, under a throwaway HOME kept at <dir>/home, then writes
scrubbed copies to <dir>/claude/projects and <dir>/codex/sessions. The last stdout line is
one JSON object with at least {"files":N,"lines":N,"usageLines":{"claude":N,"codex":N}};
everything else goes to stderr (deno's own task banner echoes the argv; 'deno task --quiet'
silences it). <dir> must not exist yet or must be empty. --real skips the fake and uses the
credentials the environment already has: it SPENDS REAL TOKENS.`;
}

export function die(message: string): never {
  console.error(`usage_corpus: ${message}`);
  console.error(usage());
  Deno.exit(2);
}

export function parseArgs(argv: string[]): Args {
  let out: string | undefined;
  let real = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // `deno task x -- --out d` forwards the separator itself
    if (arg === "--out") {
      out = argv[++i];
      if (out === undefined) die("--out needs a directory");
    } else if (arg === "--real") real = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      Deno.exit(0);
    } else die("unknown argument (only --out <dir>, --real and --help are accepted)");
  }
  if (out === undefined) die("--out is required");
  // Absolute: the children run with cwd inside it and would resolve a relative HOME there.
  return { out: resolve(out), real };
}

/** Labels only: no paths, prompts, ids or child output ever reach the runtime log. */
export function log(label: string): void {
  console.error(`[usage-corpus] ${label}`);
}

/** Every file this driver writes or removes, `<out>`-relative, reported in the summary line. */
export const ledger = { written: [] as string[], removed: [] as string[], out: "" };

export function writeFile(path: string, data: string | Uint8Array): void {
  writeFileSync(path, data);
  ledger.written.push(relative(ledger.out, path).replaceAll("\\", "/"));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
