import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A throwaway COPILOT_API_HOME so the runtime probe sees no tracked pid/port and
// falls back to the default port — independent of any real gateway on this host.
function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "copilot-health-"));
  return { ...process.env, CONSOLA_LEVEL: "5", COPILOT_API_HOME: home, ...extra };
}

// End-to-end smoke test: the citty CLI must load its whole import graph and
// print help without a running daemon or any auth. Catches wiring/import
// regressions that unit tests on individual modules would miss.
//
// CONSOLA_LEVEL is forced because citty renders usage via consola, which
// silences itself when it detects a "test" environment (as `bun test` is) --
// that suppression is a harness artifact; a real terminal prints normally.
test("`cli.ts --help` loads the CLI and exits 0", () => {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  const output = proc.stdout.toString() + proc.stderr.toString();

  expect(proc.exitCode).toBe(0);
  expect(output).toContain("start");
  expect(output).toContain("setup-shell");
  // Flat command tree: there is no nested `setup` parent, and the root help
  // surfaces the global --version flag.
  expect(output).toContain("--version");
});

for (const args of [["setup-shell"], ["setup-clis"], ["setup-launchers"]] as const) {
  test(`cli.ts ${args.join(" ")} --help loads command help and exits 0`, () => {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CONSOLA_LEVEL: "5" },
    });
    const output = proc.stdout.toString() + proc.stderr.toString();

    expect(proc.exitCode).toBe(0);
    expect(output).toContain(args[0]);
  });
}

test("the launcher flag lives on setup-clis, not setup-shell", () => {
  const shell = Bun.spawnSync(["bun", "src/cli.ts", "setup-shell", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  const clis = Bun.spawnSync(["bun", "src/cli.ts", "setup-clis", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });

  expect(shell.exitCode).toBe(0);
  expect(clis.exitCode).toBe(0);
  expect(shell.stdout.toString() + shell.stderr.toString()).not.toContain("--launchers");
  expect(clis.stdout.toString() + clis.stderr.toString()).toContain("--launchers");
});

test("setup-clis cooldown is one optional-valued flag", () => {
  const help = Bun.spawnSync(["bun", "src/cli.ts", "setup-clis", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  const helpOutput = help.stdout.toString() + help.stderr.toString();
  expect(help.exitCode).toBe(0);
  expect(helpOutput).toContain("--cooldown");

  for (const args of [["--cooldown"], ["--cooldown=0"], ["--cooldown", "14"]] as const) {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", "setup-clis", ...args, "--no-prereqs"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CONSOLA_LEVEL: "5" },
    });
    expect(proc.exitCode).toBe(0);
  }
}, 20_000);

test("setup-clis supports no-sudo", () => {
  const help = Bun.spawnSync(["bun", "src/cli.ts", "setup-clis", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  const helpOutput = help.stdout.toString() + help.stderr.toString();
  expect(help.exitCode).toBe(0);
  expect(helpOutput).toContain("--no-sudo");
});

test("health --help surfaces --scope and --json", () => {
  const help = Bun.spawnSync(["bun", "src/cli.ts", "health", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  const out = help.stdout.toString() + help.stderr.toString();
  expect(help.exitCode).toBe(0);
  expect(out).toContain("--scope");
  expect(out).toContain("--json");
});

test("health --scope runtime exits 1 when no gateway is running", () => {
  // Default port nothing is listening on + isolated state => probe always fails.
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "health", "--scope", "runtime"], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolatedEnv({ COPILOT_API_PORT_DEFAULT: "4199" }),
  });
  expect(proc.exitCode).toBe(1);
});

test("health --json emits a parseable report with scope/exitCode/checks", () => {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "health", "--scope", "runtime", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolatedEnv({ COPILOT_API_PORT_DEFAULT: "4199" }),
  });
  const parsed = JSON.parse(proc.stdout.toString());
  expect(parsed.scope).toBe("runtime");
  expect(typeof parsed.exitCode).toBe("number");
  expect(Array.isArray(parsed.checks)).toBe(true);
  expect(parsed.checks.map((c: { id: string }) => c.id)).toEqual(["runtime.port", "runtime.pid"]);
});

test("health --scope bogus exits 1 with a helpful message", () => {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "health", "--scope", "bogus"], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolatedEnv(),
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  expect(proc.exitCode).toBe(1);
  expect(out).toContain("--scope must be one of");
});

// End-to-end coverage of the full diagnostic command: running the REAL
// `agent health` exercises the whole import graph plus the live probes (bun,
// node_modules, gateway package, runtime, shell wiring, CLIs, Codex), so it
// cross-validates the rest of the codebase the way the unit tests can't. An
// isolated COPILOT_API_HOME + a dead port make the runtime checks deterministic.
function runHealthJson(scope: string): { exitCode: number | null; json: HealthJson } {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "health", "--scope", scope, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolatedEnv({ COPILOT_API_PORT_DEFAULT: "4199" }),
  });
  return { exitCode: proc.exitCode, json: JSON.parse(proc.stdout.toString()) as HealthJson };
}

interface HealthJson {
  scope: string;
  ok: boolean;
  exitCode: number;
  checks: { id: string; group: string; status: string; detail: string }[];
}

test("health --scope full runs every group end-to-end and fails on a dead gateway", () => {
  const { exitCode, json } = runHealthJson("full");
  const ids = json.checks.map((c) => c.id);
  expect(json.scope).toBe("full");
  // Representative checks from each group are present.
  for (const id of [
    "bootstrap.bun",
    "gateway.package",
    "runtime.port",
    "setup.shell",
    "setup.codex",
    "setup.codex-host",
  ]) {
    expect(ids).toContain(id);
  }
  // No daemon + isolated state => runtime fails => exit 1, ok=false.
  expect(json.exitCode).toBe(1);
  expect(json.ok).toBe(false);
  expect(exitCode).toBe(1);
  // Every check carries the structured fields the report/JSON rely on.
  for (const c of json.checks) {
    expect(typeof c.id).toBe("string");
    expect(typeof c.status).toBe("string");
    expect(typeof c.detail).toBe("string");
  }
});

test("health --scope gateway covers bootstrap+gateway+runtime, not setup", () => {
  const { json } = runHealthJson("gateway");
  const ids = json.checks.map((c) => c.id);
  expect(json.scope).toBe("gateway");
  expect(ids).toContain("gateway.package");
  expect(ids).toContain("runtime.port");
  expect(ids).not.toContain("setup.shell");
  expect(json.exitCode).toBe(1); // runtime unreachable
});

test("health --scope setup covers wiring only and never fails (warnings exit 0)", () => {
  const { exitCode, json } = runHealthJson("setup");
  const ids = json.checks.map((c) => c.id);
  expect(json.scope).toBe("setup");
  expect(ids).toContain("setup.shell");
  expect(ids).toContain("setup.codex");
  expect(ids).toContain("setup.codex-host");
  // Setup-only: no runtime/bootstrap checks can drag the exit code to 1.
  expect(ids).not.toContain("runtime.port");
  expect(ids).not.toContain("bootstrap.bun");
  expect(json.checks.every((c) => c.status !== "fail")).toBe(true);
  expect(json.exitCode).toBe(0);
  expect(exitCode).toBe(0);
});
