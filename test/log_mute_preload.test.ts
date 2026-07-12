import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The preload shim swaps the daemon's `fs.createWriteStream` for a discarding sink on paths
// under <home>/logs (the proxy's handler-log directory), touching the files' mtimes instead
// of growing them. Patching the `node:fs` default export must be exercised as a real
// preloaded subprocess (`bun --preload`), which is how launchDaemon loads it.
const ROOT = join(import.meta.dir, "..");
const SHIM = join(ROOT, "src", "scripts", "log_mute_preload.ts");

/** Run a target script under the shim with COPILOT_API_HOME pointed at `home`. */
function runPreloaded(home: string, script: string): string {
  const target = join(home, "target.ts");
  writeFileSync(target, script);
  const res = Bun.spawnSync(["bun", "--preload", SHIM, target], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, COPILOT_API_HOME: home },
  });
  if (res.exitCode !== 0) {
    throw new Error(`preloaded target failed: ${res.stderr.toString()}`);
  }
  return res.stdout.toString().trim();
}

// Mirrors the proxy logger's own usage: append-mode stream, write(content, cb), end().
// The handler log is SEEDED by the test with an old mtime before this runs, so the fresh
// mtime assertion proves the sink's utimes touch, not just file creation.
const TARGET_SCRIPT = `
import fs from "node:fs";
import { join } from "node:path";
const home = process.env.COPILOT_API_HOME;
const logsDir = join(home, "logs");
const muted = fs.createWriteStream(join(logsDir, "responses-handler-2026-01-01.log"), {
  flags: "a",
});
await new Promise((r) => muted.write("HUGE PAYLOAD DUMP\\n", r));
await new Promise((r) => muted.end(r));
const real = fs.createWriteStream(join(home, "outside.log"), { flags: "a" });
await new Promise((r) => real.write("real content\\n", r));
await new Promise((r) => real.end(r));
console.log("DONE");
`;

test("writes under <home>/logs are discarded but the file's mtime is bumped", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-logmute-"));
  try {
    // Seed the handler log EMPTY with an hour-old mtime: if the sink's touch were a no-op,
    // file creation alone could not satisfy the freshness assertion below.
    const handlerLog = join(home, "logs", "responses-handler-2026-01-01.log");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(handlerLog, "");
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(handlerLog, hourAgo, hourAgo);

    const before = Date.now();
    expect(runPreloaded(home, TARGET_SCRIPT)).toBe("DONE");

    // The handler log was "written" through the sink: still EMPTY, mtime bumped -- the idle
    // watchdog / `agent health` activity signal survives with zero disk growth.
    expect(statSync(handlerLog).size).toBe(0);
    // Allow one second of filesystem timestamp granularity.
    expect(statSync(handlerLog).mtimeMs).toBeGreaterThanOrEqual(before - 1000);

    // A stream OUTSIDE the logs dir goes through the real fs.createWriteStream untouched.
    expect(readFileSync(join(home, "outside.log"), "utf8")).toBe("real content\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Drift alarm for the floated proxy: the shim (and the idle watchdog's mtime signal) depend
// on the proxy's logger opening append streams via the `node:fs` DEFAULT export's
// createWriteStream, under an APP_DIR-rooted "logs" directory. The package floats to the
// newest release on install, so assert those internals against whatever is INSTALLED -- a
// release that reworks its logger fails here instead of silently logging payloads again.
test("the installed proxy's logger still matches the shim's assumptions", () => {
  const pkgDir = dirname(Bun.resolveSync("@jeffreycao/copilot-api/package.json", ROOT));
  const distDir = join(pkgDir, "dist");
  const serverBundle = readdirSync(distDir).find(
    (name) => name.startsWith("server-") && name.endsWith(".js"),
  );
  expect(serverBundle).toBeDefined();
  const source = readFileSync(join(distDir, serverBundle as string), "utf8");
  expect(source).toContain('path.join(PATHS.APP_DIR, "logs")');
  expect(source).toContain('fs.createWriteStream(filePath, { flags: "a" })');
  // The patch mutates the node:fs DEFAULT export, which a namespace/named import would
  // bypass (ESM bindings are captured at init) -- so the import shape matters too.
  expect(source).toMatch(/import fs[,\s][^\n]*from "node:fs"/);
});
