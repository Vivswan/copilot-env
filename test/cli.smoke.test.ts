import { expect, test } from "bun:test";

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
