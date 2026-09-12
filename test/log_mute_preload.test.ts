import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { denoRunArgs, resolvePackageDir, ROOT, runSync } from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// The shim patches `node:fs` at import, so any import would show it; the subprocess proves it
// loads the way production does, through `--preload` (src/copilot_api/process.ts).
const SHIM = join(ROOT, "src", "scripts", "log_mute_preload.ts");

function runPreloaded(home: string, script: string): string {
  const target = join(home, "target.ts");
  writeFileSync(target, script);
  const res = runSync(Deno.execPath(), [...denoRunArgs("--preload", SHIM), target], {
    env: { ...process.env, COPILOT_API_HOME: home },
  });
  if (res.exitCode !== 0) {
    throw new Error(`preloaded target failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

// Mirrors the proxy logger's own usage: append-mode stream, write(content, cb), end().
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
const fresh = fs.createWriteStream(join(logsDir, "messages-handler-2026-01-01.log"), {
  flags: "a",
});
await new Promise((r) => fresh.write("ANOTHER DUMP\\n", r));
await new Promise((r) => fresh.end(r));
const real = fs.createWriteStream(join(home, "outside.log"), { flags: "a" });
await new Promise((r) => real.write("real content\\n", r));
await new Promise((r) => real.end(r));
console.log("DONE");
`;

test("writes under <home>/logs are discarded outright (no growth, no file creation)", () => {
  const home = tempDir("copilot-logmute-");
  try {
    // An hour-old mtime on the seeded log pins that discard never touches the file, not even its
    // mtime.
    const seeded = join(home, "logs", "responses-handler-2026-01-01.log");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(seeded, "");
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(seeded, hourAgo, hourAgo);
    const seededMtime = statSync(seeded).mtimeMs;

    expect(runPreloaded(home, TARGET_SCRIPT)).toBe("DONE");

    expect(statSync(seeded).size).toBe(0);
    expect(statSync(seeded).mtimeMs).toBe(seededMtime);
    expect(existsSync(join(home, "logs", "messages-handler-2026-01-01.log"))).toBe(false);

    expect(readFileSync(join(home, "outside.log"), "utf8")).toBe("real content\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Drift alarm: the shim assumes the proxy's logger opens append streams through the `node:fs`
// DEFAULT export under an APP_DIR-rooted "logs" dir. The proxy floats, so a release that reworks
// its logger fails here instead of silently logging payloads again.
test("the installed proxy's logger still matches the shim's assumptions", () => {
  const pkgDir = resolvePackageDir("@jeffreycao/copilot-api", ROOT);
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
