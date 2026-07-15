import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearPersistedInferenceActivity,
  isInferenceRequest,
  markInference,
  PERSIST_INTERVAL_MS,
  persistedInferenceMs,
  resetInferenceActivityForTests,
} from "../src/scripts/inference_activity.ts";

const ROOT = join(import.meta.dir, "..");
const PRELOAD = join(ROOT, "src", "scripts", "inference_activity_preload.ts");

const SAVED_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  resetInferenceActivityForTests();
  if (SAVED_HOME === undefined) delete process.env.COPILOT_API_HOME;
  else process.env.COPILOT_API_HOME = SAVED_HOME;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpHome(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-inference-"));
  process.env.COPILOT_API_HOME = dir;
}

test("isInferenceRequest: inference POSTs only -- never GETs, pings, or model/count routes", () => {
  // The proxy's inference endpoints, in bare / v1 / provider-prefixed route forms.
  expect(isInferenceRequest("POST", "/v1/messages")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/responses")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/chat/completions")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/embeddings")).toBe(true);
  expect(isInferenceRequest("POST", "/chat/completions")).toBe(true);
  expect(isInferenceRequest("POST", "/myprovider/v1/messages")).toBe(true);
  expect(isInferenceRequest("post", "/v1/messages")).toBe(true); // method case-insensitive
  expect(isInferenceRequest("POST", "/v1/messages/")).toBe(true); // trailing slash tolerated

  // Observation must not read as activity: liveness, model lists, token counting.
  expect(isInferenceRequest("GET", "/")).toBe(false);
  expect(isInferenceRequest("GET", "/v1/models")).toBe(false);
  expect(isInferenceRequest("POST", "/v1/models")).toBe(false);
  expect(isInferenceRequest("POST", "/v1/messages/count_tokens")).toBe(false);
  expect(isInferenceRequest("GET", "/v1/messages")).toBe(false); // wrong method
  expect(isInferenceRequest("POST", "/usage")).toBe(false);
  // Suffixes are segment-bounded: no slash before "messages" -> no match.
  expect(isInferenceRequest("POST", "/v1/notmessages")).toBe(false);
});

test("markInference: memory always moves; the activity-file persist is throttled", () => {
  tmpHome();
  const t0 = 1_700_000_000_000;

  // First mark persists immediately (out-of-process readers should not wait a minute).
  markInference(t0);
  expect(persistedInferenceMs()).toBe(t0);

  // A mark inside the persist window updates memory only -- the file keeps the old value.
  markInference(t0 + 1000);
  expect(persistedInferenceMs()).toBe(t0);

  // Past the window, the next mark persists again.
  markInference(t0 + PERSIST_INTERVAL_MS);
  expect(persistedInferenceMs()).toBe(t0 + PERSIST_INTERVAL_MS);

  // `agent stop` teardown removes the persisted mark entirely.
  clearPersistedInferenceActivity();
  expect(persistedInferenceMs()).toBe(0);
});

// The observer must be exercised as a real preloaded subprocess (`bun --preload`, how
// launchDaemon loads it): it patches the `Bun` global before srvx/Bun.serve run, and the
// target script shares the preloaded module instance, so it can read the in-memory mark.
const TARGET_SCRIPT = `
import { lastObservedInferenceMs, persistedInferenceMs } from ${JSON.stringify(join(ROOT, "src", "scripts", "inference_activity.ts"))};
const server = Bun.serve({
  port: 0,
  fetch: () => new Response("ok"),
});
const base = "http://127.0.0.1:" + server.port;
const out = {};
await fetch(base + "/v1/models"); // liveness/model-list: must NOT mark
out.afterGet = lastObservedInferenceMs();
const res = await fetch(base + "/v1/messages", { method: "POST", body: "{}" });
out.body = await res.text(); // the wrapped handler must still serve normally
out.afterPost = lastObservedInferenceMs();
out.persisted = persistedInferenceMs();
server.stop(true);
console.log(JSON.stringify(out));
`;

test("the preloaded observer marks inference POSTs through a real Bun.serve, not GETs", () => {
  tmpHome();
  const target = join(dir, "target.ts");
  writeFileSync(target, TARGET_SCRIPT);
  const before = Date.now();
  const res = Bun.spawnSync(["bun", "--preload", PRELOAD, target], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, COPILOT_API_HOME: dir },
  });
  if (res.exitCode !== 0) throw new Error(`preloaded target failed: ${res.stderr.toString()}`);
  const out = JSON.parse(res.stdout.toString().trim()) as {
    afterGet: number;
    afterPost: number;
    body: string;
    persisted: number;
  };
  expect(out.body).toBe("ok"); // observation never broke serving
  expect(out.afterGet).toBe(0); // GETs are not activity
  expect(out.afterPost).toBeGreaterThanOrEqual(before); // the POST marked, in memory...
  expect(out.persisted).toBe(out.afterPost); // ...and the first mark persisted to the file
});

// Drift alarm for the floated proxy stack: the observer intercepts `Bun.serve`, which only
// works because srvx's bun adapter looks it up on the global AT SERVE TIME (a preload-time
// patch is then seen). A release that captures Bun.serve at import, drops srvx, or serves
// another way would silently stop marking activity -- fail here instead. The check runs
// against the modules bun ACTUALLY resolves (export conditions honored), not fixed paths.
test("the installed proxy still serves through srvx's call-time Bun.serve lookup", () => {
  const proxyDir = dirname(Bun.resolveSync("@jeffreycao/copilot-api/package.json", ROOT));
  // The proxy's start bundle must still serve through srvx at all.
  const startBundle = readdirSync(join(proxyDir, "dist")).find(
    (name) => name.startsWith("start-") && name.endsWith(".js"),
  );
  expect(startBundle).toBeDefined();
  expect(readFileSync(join(proxyDir, "dist", startBundle as string), "utf8")).toContain(
    'from "srvx"',
  );
  // Bun.resolveSync("srvx", proxyDir) under bun honors srvx's "bun" export condition -- the
  // exact module the daemon loads. Scan it plus its one-level relative imports.
  const entry = Bun.resolveSync("srvx", proxyDir);
  const entrySource = readFileSync(entry, "utf8");
  const sources = [entrySource];
  for (const match of entrySource.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const spec = match[1] as string;
    const path = join(dirname(entry), spec);
    if (existsSync(path)) sources.push(readFileSync(path, "utf8"));
  }
  expect(sources.some((s) => s.includes("Bun.serve("))).toBe(true);
});
