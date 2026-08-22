// Containerized test runner: one cross-platform implementation for docker and
// podman (replaces a POSIX/PowerShell script pair). The container's throwaway
// HOME is the structural guarantee behind the lifecycle smoke (which rewires
// agent configs and is container-or-CI only); for the unit suite - already
// HOME-safe by its own temp-dir design - it adds defense in depth and a
// Linux-parity run.
//
//   deno task test:docker                     full suite (image CMD)
//   deno task test:docker test/usage.test.ts  selected files
//   deno task test:docker --lifecycle         daemon lifecycle smoke, in-container
//   deno task test:docker --floated-lifecycle the same smoke against the REAL
//                                             floated proxy (needs the network
//                                             and a Copilot credential)
//
// Engine: $CONTAINER_ENGINE picks between "docker" and "podman" (the task's
// --allow-run grants exactly those two); otherwise podman is preferred.
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IMAGE = "copilot-env-test";
const ENGINES = ["podman", "docker"] as const;
type Engine = (typeof ENGINES)[number];

function isEngine(v: string): v is Engine {
  return (ENGINES as readonly string[]).includes(v);
}

async function engineWorks(name: string): Promise<boolean> {
  try {
    const out = await new Deno.Command(name, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

async function resolveEngine(): Promise<string> {
  const override = Deno.env.get("CONTAINER_ENGINE");
  if (override !== undefined) {
    if (!isEngine(override)) {
      console.error(
        `error: CONTAINER_ENGINE must be one of ${ENGINES.join(", ")} (got "${override}")`,
      );
      Deno.exit(1);
    }
    return override;
  }
  for (const candidate of ENGINES) {
    if (await engineWorks(candidate)) {
      return candidate;
    }
  }
  console.error("error: neither podman nor docker on PATH (set CONTAINER_ENGINE)");
  Deno.exit(1);
}

async function run(cmd: string, args: string[], stdout: "inherit" | "piped"): Promise<number> {
  const child = new Deno.Command(cmd, { args, cwd: ROOT, stdout, stderr: "inherit" }).spawn();
  if (stdout === "piped") {
    // Build noise goes to stderr; stdout stays clean for test output.
    await child.stdout.pipeTo(Deno.stderr.writable, { preventClose: true });
  }
  return (await child.status).code;
}

const engine = await resolveEngine();
const denoVersion = Deno.readTextFileSync(join(ROOT, ".dvmrc")).trim();

const buildCode = await run(
  engine,
  ["build", "--build-arg", `DENO_VERSION=${denoVersion}`, "-t", IMAGE, "."],
  "piped",
);
if (buildCode !== 0) {
  Deno.exit(buildCode);
}

// --network=none: the netns keeps loopback, so daemon lifecycle tests work,
// while anything reaching for the real network fails loudly. The floated
// lifecycle is the one mode that opts out - it exists precisely to exercise the
// float against the live registry.
const runArgs = ["run", "--rm"];
const [first, ...rest] = Deno.args;

let command: string[];
if (first === "--lifecycle") {
  runArgs.push("--network=none", "-e", "COPILOT_API_ENTRY=/work/test/copilot-api-fake.mjs");
  command = ["bash", ".github/scripts/lifecycle-smoke.sh", ...rest];
} else if (first === "--floated-lifecycle") {
  // Same smoke, no COPILOT_API_ENTRY: `agent start` resolves and runs the REAL
  // proxy, so this is the only run that covers the float end to end. Needs the
  // network for the registry, and a credential for the daemon to come up.
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]) {
    const value = Deno.env.get(name);
    if (value) runArgs.push("-e", `${name}=${value}`);
  }
  command = ["bash", ".github/scripts/lifecycle-smoke.sh", ...rest];
} else {
  runArgs.push("--network=none");
  if (first !== undefined) {
    command = ["deno", "test", "-P=test", first, ...rest];
  } else {
    command = [];
  }
}

Deno.exit(await run(engine, [...runArgs, IMAGE, ...command], "inherit"));
