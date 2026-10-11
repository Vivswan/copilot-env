import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotApiConfig } from "../../src/copilot_api/config.ts";
import {
  bunRunArgs,
  CHILD_VALUES,
  childValuesEnv,
  importSpecifier,
  ROOT,
  spawnChild,
} from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

// Without the cross-process lock in CopilotApiConfig.update(), the racing load-mutate-saves clobber
// each other and the counter comes up short of workers * increments.
const CONFIG_MODULE = join(ROOT, "src", "copilot_api", "config.ts");

interface WorkerExit {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawnWorker(worker: string, store: string): Promise<WorkerExit> {
  const child = spawnChild(process.execPath, {
      args: [...bunRunArgs(), worker],
    env: childValuesEnv({ store }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** A red names the worker's own error (its stderr, with the exit code) instead of a bare exit
 *  code list. */
function failures(exits: WorkerExit[]): { code: number; stderr: string }[] {
  return exits.filter((p) => p.code !== 0).map(({ code, stderr }) => ({ code, stderr }));
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
    expect(failures(await Promise.all(procs))).toEqual([]);

    const final = JSON.parse(readFileSync(store, "utf8")).counter;
    expect(final).toBe(WORKERS * INCREMENTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// The Windows incident: a scanner's open handle refused the release's marker delete, leaving a
// fresh marker naming a live pid, this process's own. Nothing in this process holds it, so it is a
// leftover the next update() takes over at once, whatever its age.
test("update() lands at once over a fresh leftover marker of its own pid", () => {
  const dir = tempDir("copilot-lock-");
  try {
    const store = join(dir, "s.json");
    writeFileSync(store, JSON.stringify({ v: 0 }));
    writeFileSync(`${store}.lock`, `${process.pid}\n${Date.now()}\n`);

    const cfg = new CopilotApiConfig(store);
    const t0 = Date.now();
    cfg.update((d) => {
      d.v = 1;
    });
    expect(Date.now() - t0).toBeLessThan(2000); // neither the 4 s wait nor the 10 s age-out
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
