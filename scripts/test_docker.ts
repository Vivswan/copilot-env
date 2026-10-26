// One cross-platform runner for docker and podman. The container's throwaway HOME is the
// structural guarantee behind the lifecycle smoke; for the unit suite it adds a Linux-parity run.
//
//   bun run test:docker                              full suite (image CMD)
//   bun run test:docker test/usage/usage.test.ts     selected files
//   bun run test:docker --lifecycle                  daemon lifecycle smoke, in-container
//   bun run test:docker --floated-lifecycle          the REAL floated proxy, asserted as far as auth
//                                                    (needs the network; no credential required)
//
// $CONTAINER_ENGINE picks "docker" or "podman".
//
// Every run has --init: a reaping pid 1, as a developer machine has. Without it the suite's own
// entry is pid 1, and a killed child's orphans stay zombies that a signal-0 probe reads as alive.
// Every run but the floated lifecycle has --network=none: the netns keeps loopback, so daemon
// lifecycle tests work, while anything reaching for the real network fails loudly; the floated
// lifecycle exists precisely to exercise the float against the live registry.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout: the build context, and the cwd of the build and run calls. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The local tag the build writes and every run launches. */
const IMAGE = "copilot-env-test";

/** The image's bun: the platform sync writes this file, and the Dockerfile has no default. */
const BUN_VERSION_FILE = ".bun-version";

/** Tried in this order when CONTAINER_ENGINE is unset; the override must name one of them. */
const ENGINES = ["podman", "docker"] as const;

type Engine = (typeof ENGINES)[number];

function isEngine(v: string): v is Engine {
  return (ENGINES as readonly string[]).includes(v);
}

// A spawn that never ran and an engine whose `--version` failed both read "not usable", so a
// failed look can surface as the "neither on PATH" hint. Accepted: CONTAINER_ENGINE overrides.
function engineWorks(name: string): boolean {
  const out = spawnSync(name, ["--version"], { stdio: "ignore" });
  return out.error === undefined && out.status === 0;
}

function resolveEngine(): string {
  const override = process.env.CONTAINER_ENGINE;
  if (override !== undefined) {
    if (!isEngine(override)) {
      console.error(
        `error: CONTAINER_ENGINE must be one of ${ENGINES.join(", ")} (got "${override}")`,
      );
      process.exit(1);
    }
    return override;
  }
  for (const candidate of ENGINES) {
    if (engineWorks(candidate)) {
      return candidate;
    }
  }
  console.error("error: neither podman nor docker on PATH (set CONTAINER_ENGINE)");
  process.exit(1);
}

function bunVersion(): string {
  try {
    return readFileSync(join(ROOT, BUN_VERSION_FILE), "utf8").trim();
  } catch {
    console.error(`error: ${BUN_VERSION_FILE} is missing or unreadable; it pins the image's bun`);
    process.exit(1);
  }
}

function run(cmd: string, args: string[], stdout: "inherit" | "piped"): Promise<number> {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: ["inherit", stdout === "piped" ? "pipe" : "inherit", "inherit"],
  });
  // Build noise goes to stderr; stdout stays clean for test output.
  child.stdout?.pipe(process.stderr);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

const engine = resolveEngine();

const buildCode = await run(
  engine,
  ["build", "--build-arg", `BUN_VERSION=${bunVersion()}`, "-t", IMAGE, "."],
  "piped",
);
if (buildCode !== 0) {
  process.exit(buildCode);
}

// Every mode's flags; the header says why --init, and when --network=none joins below.
const runArgs = ["run", "--rm", "--init"];

// The mode flag or the first test file, then what the mode forwards.
const [first, ...rest] = process.argv.slice(2);

let command: string[];
if (first === "--lifecycle") {
  runArgs.push("--network=none", "-e", "COPILOT_API_ENTRY=/work/test/copilot-api-fake.mjs");
  command = ["bun", ".github/scripts/lifecycle-smoke.ts", ...rest];
} else if (first === "--floated-lifecycle") {
  // No COPILOT_API_ENTRY: `agent start` runs the REAL proxy, so this is the only run covering
  // the float and the daemon's production permission set end to end.
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]) {
    const value = process.env[name];
    if (value) runArgs.push("-e", `${name}=${value}`);
  }
  command = ["bun", ".github/scripts/floated-smoke.ts", ...rest];
} else {
  runArgs.push("--network=none");
  // The container's HOME is the throwaway one, so the *.e2e.test.ts files run here as in CI; the
  // image's CMD carries the same opt-in for the whole suite.
  if (first !== undefined) {
    command = ["bun", "run", "test", "--e2e", first, ...rest];
  } else {
    command = [];
  }
}

process.exit(await run(engine, [...runArgs, IMAGE, ...command], "inherit"));
