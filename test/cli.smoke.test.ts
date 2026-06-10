import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A throwaway COPILOT_API_HOME so the runtime probe sees no tracked pid/port and
// falls back to the default port — independent of any real gateway on this host.
function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "copilot-health-"));
  return { ...process.env, CONSOLA_LEVEL: "5", COPILOT_API_HOME: home, ...extra };
}

function isolatedProxyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "copilot-health-proxy-"));
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "copilot-env"',
      "",
      "[model_providers.copilot-env]",
      'base_url = "http://localhost:4199/v1"',
      'env_key = "OPENAI_API_KEY"',
      "",
    ].join("\n"),
  );
  writeFileSync(join(codexHome, ".env"), "OPENAI_API_KEY=test-key\n");
  return isolatedEnv({ CODEX_HOME: codexHome, ...extra });
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

for (const args of [["setup-codex-config"], ["setup-codex-host"]] as const) {
  test(`cli.ts ${args.join(" ")} --help exposes provider modes`, () => {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CONSOLA_LEVEL: "5" },
    });
    const output = proc.stdout.toString() + proc.stderr.toString();

    expect(proc.exitCode).toBe(0);
    expect(output).toContain("--proxy");
    expect(output).toContain("--direct");
  });
}

test("setup-codex-config exposes and runs check mode", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-codex-check-"));
  const codexHome = join(root, ".codex");
  const directHome = join(root, "direct-codex");
  const otherHome = join(root, "other-codex");
  const noneHome = join(root, "none-codex");
  const unsetHome = join(root, "unset-codex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(directHome, { recursive: true });
  mkdirSync(otherHome, { recursive: true });
  mkdirSync(noneHome, { recursive: true });
  mkdirSync(unsetHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "copilot-env"',
      "",
      "[model_providers.copilot-env]",
      'base_url = "http://localhost:4199/v1"',
      'env_key = "OPENAI_API_KEY"',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(directHome, "config.toml"),
    [
      'model_provider = "github-copilot-direct"',
      "",
      "[model_providers.github-copilot-direct]",
      'base_url = "https://api.githubcopilot.com"',
      "",
    ].join("\n"),
  );
  writeFileSync(join(otherHome, "config.toml"), 'model_provider = "openai"\n');
  writeFileSync(join(unsetHome, "config.toml"), "[analytics]\nenabled = false\n");

  const help = Bun.spawnSync(["bun", "src/cli.ts", "setup-codex-config", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  expect(help.stdout.toString() + help.stderr.toString()).toContain("--check");

  const hostHelp = Bun.spawnSync(["bun", "src/cli.ts", "setup-codex-host", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  expect(hostHelp.stdout.toString() + hostHelp.stderr.toString()).not.toContain("--check");

  const runCheck = (home: string) =>
    Bun.spawnSync(["bun", "src/cli.ts", "setup-codex-config", "--check"], {
      stdout: "pipe",
      stderr: "pipe",
      env: isolatedEnv({ CODEX_HOME: home, COPILOT_API_PORT_DEFAULT: "4199" }),
    });

  const proxy = runCheck(codexHome);
  expect(proxy.exitCode).toBe(2);
  expect(proxy.stdout.toString()).toContain("Codex provider mode: proxy");
  expect(proxy.stdout.toString()).toContain("local copilot-api proxy");
  expect(proxy.stdout.toString()).toContain(`config.toml: ${join(codexHome, "config.toml")}`);

  const direct = runCheck(directHome);
  expect(direct.exitCode).toBe(0);
  expect(direct.stdout.toString()).toContain("Codex provider mode: direct");
  expect(direct.stdout.toString()).toContain("GitHub Copilot Direct");
  expect(direct.stdout.toString()).toContain(`config.toml: ${join(directHome, "config.toml")}`);

  const other = runCheck(otherHome);
  expect(other.exitCode).toBe(1);
  expect(other.stdout.toString()).toContain("Codex provider mode: other");
  expect(other.stdout.toString()).toContain(`config.toml: ${join(otherHome, "config.toml")}`);

  const missing = runCheck(noneHome);
  expect(missing.exitCode).toBe(1);
  expect(missing.stdout.toString()).toContain("Codex provider mode: none");
  expect(missing.stdout.toString()).toContain("no config.toml found");

  const unset = runCheck(unsetHome);
  expect(unset.exitCode).toBe(1);
  expect(unset.stdout.toString()).toContain("Codex provider mode: none");
  expect(unset.stdout.toString()).toContain("no model_provider configured");

  const conflicting = Bun.spawnSync(
    ["bun", "src/cli.ts", "setup-codex-config", "--proxy", "--direct"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: isolatedEnv({ CODEX_HOME: codexHome, COPILOT_API_PORT_DEFAULT: "4199" }),
    },
  );
  expect(conflicting.exitCode).toBe(1);
  expect(conflicting.stderr.toString()).toContain("--proxy and --direct are mutually exclusive");

  const conflictingCheck = Bun.spawnSync(
    ["bun", "src/cli.ts", "setup-codex-config", "--check", "--proxy", "--direct"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: isolatedEnv({ CODEX_HOME: codexHome, COPILOT_API_PORT_DEFAULT: "4199" }),
    },
  );
  expect(conflictingCheck.exitCode).toBe(1);
  expect(conflictingCheck.stderr.toString()).toContain(
    "--proxy and --direct are mutually exclusive",
  );
});

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
    env: isolatedProxyEnv({ COPILOT_API_PORT_DEFAULT: "4199" }),
  });
  return { exitCode: proc.exitCode, json: JSON.parse(proc.stdout.toString()) as HealthJson };
}

interface HealthJson {
  scope: string;
  ok: boolean;
  exitCode: number;
  checks: {
    id: string;
    group: string;
    status: string;
    detail: string;
    value?: Record<string, unknown>;
  }[];
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
  const codex = json.checks.find((c) => c.id === "setup.codex");
  expect(codex?.value?.providerMode).toBe("proxy");
  expect(typeof codex?.value?.configFile).toBe("string");
  expect(codex?.detail).toContain("provider: proxy");
  expect(codex?.detail).toContain("config.toml:");
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
  const codexHost = json.checks.find((c) => c.id === "setup.codex-host");
  // Unbuilt farm: optional on Linux/macOS (POSIX symlinks), unsupported on Windows.
  const expectedHostDetail =
    process.platform === "win32" ? "not built (unsupported on Windows)" : "not built (optional)";
  expect(codexHost?.detail).toBe(expectedHostDetail);
  expect(codexHost?.detail).not.toContain(String(codexHost?.value?.hostHome));
  expect(codexHost?.detail).not.toContain("config.toml:");
  expect(typeof codexHost?.value?.configFile).toBe("string");
  // Setup-only: no runtime/bootstrap checks can drag the exit code to 1.
  expect(ids).not.toContain("runtime.port");
  expect(ids).not.toContain("bootstrap.bun");
  expect(json.checks.every((c) => c.status !== "fail")).toBe(true);
  expect(json.exitCode).toBe(0);
  expect(exitCode).toBe(0);
});

test("health --scope codex covers only Codex wiring", () => {
  const { exitCode, json } = runHealthJson("codex");
  const ids = json.checks.map((c) => c.id);
  expect(json.scope).toBe("codex");
  expect(ids).toEqual(["setup.codex"]);
  expect(json.checks[0]?.value?.providerMode).toBe("proxy");
  expect(json.exitCode).toBe(0);
  expect(exitCode).toBe(0);
});

// --- autoupdate management flags --------------------------------------------

test("update --help documents the autoupdate flags alongside the manual ones", () => {
  const help = Bun.spawnSync(["bun", "src/cli.ts", "update", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  const out = help.stdout.toString() + help.stderr.toString();
  expect(help.exitCode).toBe(0);
  for (const flag of ["--auto", "--no-auto", "--auto-status", "--check", "--cooldown", "--force"]) {
    expect(out).toContain(flag);
  }
});

test("update --auto-status reports status and exits 0 (offline, read-only)", () => {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "update", "--auto-status"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain("autoupdate:");
});
