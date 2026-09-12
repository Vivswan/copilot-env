import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import {
  CHILD_VALUES,
  childValuesEnv,
  denoRunArgs,
  importSpecifier,
  ROOT,
  spawnChild,
} from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// Without the cross-process lock in CopilotApiConfig.update(), the racing load-mutate-saves clobber
// each other and the counter comes up short of workers * increments.
const CONFIG_MODULE = join(ROOT, "src", "copilot_api", "config.ts");

function spawnWorker(worker: string, store: string): Promise<{ code: number; stdout: string }> {
  const child = spawnChild(Deno.execPath(), {
    args: [...denoRunArgs(), worker],
    env: childValuesEnv({ store }),
    stdout: "piped",
    stderr: "piped",
  });
  return child.output().then((o) => ({
    code: o.code,
    stdout: new TextDecoder().decode(o.stdout),
  }));
}

test("update() serializes concurrent writers across processes (no lost updates)", async () => {
  const dir = tempDir("copilot-lock-");
  try {
    const store = join(dir, "counter.json");
    writeFileSync(store, JSON.stringify({ counter: 0 }));

    const WORKERS = 5;
    const INCREMENTS = 40;
    const worker = join(dir, "worker.ts");
    writeFileSync(
      worker,
      [
        `import { CopilotApiConfig } from ${importSpecifier(CONFIG_MODULE)};`,
        `const cfg = new CopilotApiConfig(${CHILD_VALUES}.store);`,
        `for (let i = 0; i < ${INCREMENTS}; i++) {`,
        "  cfg.update((d) => {",
        "    d.counter = (typeof d.counter === 'number' ? d.counter : 0) + 1;",
        "  });",
        "}",
      ].join("\n"),
    );

    const procs = Array.from({ length: WORKERS }, () => spawnWorker(worker, store));
    const codes = (await Promise.all(procs)).map((p) => p.code);
    expect(codes.every((c) => c === 0)).toBe(true);

    const final = JSON.parse(readFileSync(store, "utf8")).counter;
    expect(final).toBe(WORKERS * INCREMENTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("update() reclaims a stale lock (dead holder pid) quickly instead of hanging", () => {
  const dir = tempDir("copilot-lock-");
  try {
    const store = join(dir, "s.json");
    writeFileSync(store, JSON.stringify({ v: 0 }));
    // A fresh timestamp under a dead pid: the pid check, not the age, must reclaim the lock.
    writeFileSync(`${store}.lock`, `2147480000\n${Date.now()}\n`);

    const cfg = new CopilotApiConfig(store);
    const t0 = Date.now();
    cfg.update((d) => {
      d.v = 1;
    });
    expect(Date.now() - t0).toBeLessThan(2000); // reclaimed, not a ~4s timeout wait
    expect(JSON.parse(readFileSync(store, "utf8")).v).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "concurrent ensureApiKey callers converge on ONE key (no dropped/overwritten key)",
  async () => {
    const dir = tempDir("copilot-lock-");
    try {
      const store = join(dir, "config.json");
      const worker = join(dir, "keyworker.ts");
      writeFileSync(
        worker,
        [
          `import { CopilotApiConfig } from ${importSpecifier(CONFIG_MODULE)};`,
          `const cfg = new CopilotApiConfig(${CHILD_VALUES}.store);`,
          "console.log(cfg.ensureApiKey() + ' ' + cfg.ensureAdminApiKey());",
        ].join("\n"),
      );

      const procs = Array.from({ length: 6 }, () => spawnWorker(worker, store));
      const outs = (await Promise.all(procs)).map((p) => p.stdout.trim());
      const unique = new Set(outs);
      expect(unique.size).toBe(1);
      const doc = JSON.parse(readFileSync(store, "utf8"));
      const apiKey = doc.auth.apiKeys[0];
      const adminKey = doc.auth.adminApiKey;
      expect(outs[0]).toBe(`${apiKey} ${adminKey}`);
      // Racing creators would each append their own api key.
      expect(doc.auth.apiKeys.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
