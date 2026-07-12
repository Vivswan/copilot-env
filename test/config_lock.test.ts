import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";

// The cross-process lock in CopilotApiConfig.update() must serialize concurrent read-modify-
// writes to the SAME store file so none are lost. Prove it by racing several real bun
// subprocesses, each incrementing a shared counter many times via update(); with the lock the
// final value equals workers * increments (no lost updates). Without the lock, concurrent
// load-mutate-saves would clobber each other and the total would come up short.
const CONFIG_MODULE = join(import.meta.dir, "..", "src", "copilot_api", "config.ts");

test("update() serializes concurrent writers across processes (no lost updates)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-lock-"));
  try {
    const store = join(dir, "counter.json");
    writeFileSync(store, JSON.stringify({ counter: 0 }));

    const WORKERS = 5;
    const INCREMENTS = 40;
    const worker = join(dir, "worker.ts");
    writeFileSync(
      worker,
      [
        `import { CopilotApiConfig } from ${JSON.stringify(CONFIG_MODULE)};`,
        `const cfg = new CopilotApiConfig(${JSON.stringify(store)});`,
        `for (let i = 0; i < ${INCREMENTS}; i++) {`,
        "  cfg.update((d) => {",
        "    d.counter = (typeof d.counter === 'number' ? d.counter : 0) + 1;",
        "  });",
        "}",
      ].join("\n"),
    );

    const procs = Array.from({ length: WORKERS }, () =>
      Bun.spawn(["bun", worker], { stdout: "ignore", stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);

    const final = JSON.parse(readFileSync(store, "utf8")).counter;
    expect(final).toBe(WORKERS * INCREMENTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("update() reclaims a stale lock (dead holder pid) quickly instead of hanging", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-lock-"));
  try {
    const store = join(dir, "s.json");
    writeFileSync(store, JSON.stringify({ v: 0 }));
    // Plant a lock owned by a definitely-dead pid with a fresh timestamp: the pid check (not the
    // age) must reclaim it, so update() completes fast rather than waiting out the timeout.
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

test("concurrent ensureApiKey callers converge on ONE key (no dropped/overwritten key)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-lock-"));
  try {
    const store = join(dir, "config.json");
    const worker = join(dir, "keyworker.ts");
    // Each worker ensures the api + admin key and prints them; with the atomic check-inside-
    // update + lock, every worker must return the SAME persisted keys.
    writeFileSync(
      worker,
      [
        `import { CopilotApiConfig } from ${JSON.stringify(CONFIG_MODULE)};`,
        `const cfg = new CopilotApiConfig(${JSON.stringify(store)});`,
        "console.log(cfg.ensureApiKey() + ' ' + cfg.ensureAdminApiKey());",
      ].join("\n"),
    );

    const procs = Array.from({ length: 6 }, () =>
      Bun.spawn(["bun", worker], { stdout: "pipe", stderr: "pipe" }),
    );
    const outs = await Promise.all(
      procs.map(async (p) => {
        await p.exited;
        return (await new Response(p.stdout).text()).trim();
      }),
    );
    // Every worker saw the same api+admin key pair, and it matches what's on disk.
    const unique = new Set(outs);
    expect(unique.size).toBe(1);
    const doc = JSON.parse(readFileSync(store, "utf8"));
    const apiKey = doc.auth.apiKeys[0];
    const adminKey = doc.auth.adminApiKey;
    expect(outs[0]).toBe(`${apiKey} ${adminKey}`);
    // No duplicate api keys were appended by the concurrent creators.
    expect(doc.auth.apiKeys.length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
