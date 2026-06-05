import { expect, test } from "bun:test";

// End-to-end smoke test: the citty CLI must load its whole import graph and
// print help without a running daemon or any auth. Catches wiring/import
// regressions that unit tests on individual modules would miss.
//
// CONSOLA_LEVEL is forced because citty renders usage via consola, which
// silences itself when it detects a "test" environment (as `bun test` is) --
// that suppression is a harness artifact; a real terminal prints normally.
test("`server.ts --help` loads the CLI and exits 0", () => {
  const proc = Bun.spawnSync(["bun", "src/server.ts", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  const output = proc.stdout.toString() + proc.stderr.toString();

  expect(proc.exitCode).toBe(0);
  expect(output).toContain("start");
});
