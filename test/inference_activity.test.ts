import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clearPersistedInferenceActivity,
  isInferenceRequest,
  lastObservedInferenceMs,
  markInference,
  observeServeArgs,
  PERSIST_INTERVAL_MS,
  persistedInferenceMs,
  resetInferenceActivityForTests,
} from "../src/scripts/inference_activity.ts";
import { denoRunArgs, importSpecifier, resolvePackageDir, ROOT, runSync } from "./helpers/run.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

const PRELOAD = join(ROOT, "src", "scripts", "daemon_runtime_preload.ts");

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  resetInferenceActivityForTests();
  restoreEnv();
  dir = removeDir(dir);
});

function tmpHome(): void {
  dir = isolateProxyHome("copilot-inference-");
}

test("isInferenceRequest: inference POSTs only -- never GETs, pings, or model/count routes", () => {
  expect(isInferenceRequest("POST", "/v1/messages")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/responses")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/chat/completions")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/embeddings")).toBe(true);
  expect(isInferenceRequest("POST", "/chat/completions")).toBe(true);
  expect(isInferenceRequest("POST", "/myprovider/v1/messages")).toBe(true);
  expect(isInferenceRequest("post", "/v1/messages")).toBe(true); // method case-insensitive
  expect(isInferenceRequest("POST", "/v1/messages/")).toBe(true); // trailing slash tolerated

  // Search and image generation count as usage too.
  expect(isInferenceRequest("POST", "/alpha/search")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/alpha/search")).toBe(true);
  expect(isInferenceRequest("POST", "/myprovider/alpha/search")).toBe(true);
  expect(isInferenceRequest("POST", "/alpha/search/")).toBe(true);
  expect(isInferenceRequest("POST", "/images/generations")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/images/generations")).toBe(true);
  expect(isInferenceRequest("POST", "/myprovider/v1/images/generations")).toBe(true);
  expect(isInferenceRequest("POST", "/images/generations/")).toBe(true);
  expect(isInferenceRequest("POST", "/images/edits")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/images/edits")).toBe(true);
  expect(isInferenceRequest("POST", "/myprovider/images/edits")).toBe(true);
  expect(isInferenceRequest("POST", "/images/edits/")).toBe(true);

  // Observation must not read as activity: liveness, model lists, token counting.
  expect(isInferenceRequest("GET", "/")).toBe(false);
  expect(isInferenceRequest("GET", "/v1/models")).toBe(false);
  expect(isInferenceRequest("POST", "/v1/models")).toBe(false);
  expect(isInferenceRequest("POST", "/v1/messages/count_tokens")).toBe(false);
  expect(isInferenceRequest("GET", "/v1/messages")).toBe(false); // wrong method
  expect(isInferenceRequest("GET", "/alpha/search")).toBe(false); // wrong method
  expect(isInferenceRequest("GET", "/images/generations")).toBe(false); // wrong method
  expect(isInferenceRequest("POST", "/usage")).toBe(false);
  // Suffixes are segment-bounded: no slash before "messages" -> no match.
  expect(isInferenceRequest("POST", "/v1/notmessages")).toBe(false);
  // Two-segment suffixes stay segment-bounded on both edges.
  expect(isInferenceRequest("POST", "/v1/myimages/generations")).toBe(false);
  expect(isInferenceRequest("POST", "/v1/images/generations/foo")).toBe(false);
});

test("markInference: memory always moves; the activity-file persist is throttled", () => {
  tmpHome();
  const t0 = 1_700_000_000_000;

  // First mark persists immediately (out-of-process readers should not wait a minute).
  markInference(t0);
  expect(persistedInferenceMs()).toBe(t0);

  markInference(t0 + 1000);
  expect(persistedInferenceMs()).toBe(t0);

  markInference(t0 + PERSIST_INTERVAL_MS);
  expect(persistedInferenceMs()).toBe(t0 + PERSIST_INTERVAL_MS);

  // `agent stop` teardown removes the persisted mark entirely.
  clearPersistedInferenceActivity();
  expect(persistedInferenceMs()).toBe(0);
});

// srvx's deno adapter uses the (options, handler) form today; the other two shapes are covered so
// a proxy stack move cannot silently stop marking. An argument list matching none of them must
// reach the real serve untouched, arity included.
test("observeServeArgs substitutes the handler in every Deno.serve calling shape", async () => {
  tmpHome(); // marking persists to the activity file -- keep it out of the real home
  const seen: string[] = [];
  const handler = (request: Request): Response => {
    seen.push(new URL(request.url).pathname);
    return new Response("ok");
  };
  const post = (path: string): Request =>
    new Request(`http://127.0.0.1${path}`, { method: "POST" });

  const [wrappedOnly, ...noTail] = observeServeArgs([handler]);
  expect(noTail).toEqual([]); // arity preserved
  await (wrappedOnly as typeof handler)(post("/v1/messages"));
  expect(lastObservedInferenceMs()).toBeGreaterThan(0);

  resetInferenceActivityForTests();
  const twoArg = observeServeArgs([{ port: 0 }, handler]);
  expect(twoArg[0]).toEqual({ port: 0 }); // options relayed untouched
  await (twoArg[1] as typeof handler)(post("/v1/responses"));
  expect(lastObservedInferenceMs()).toBeGreaterThan(0);

  resetInferenceActivityForTests();
  const [options] = observeServeArgs([{ port: 0, handler }]);
  const wrapped = (options as { handler: typeof handler }).handler;
  expect(wrapped).not.toBe(handler);
  await wrapped(post("/v1/chat/completions"));
  expect(lastObservedInferenceMs()).toBeGreaterThan(0);

  expect(seen).toEqual(["/v1/messages", "/v1/responses", "/v1/chat/completions"]);

  expect(observeServeArgs([42, "x"])).toEqual([42, "x"]);
  expect(observeServeArgs([])).toEqual([]);
});

// A real `--preload` subprocess, as launchDaemon loads it: the patch must land before srvx runs.
// The target shares the preloaded module instance, so it can read the in-memory mark.
const TARGET_SCRIPT = `
import { lastObservedInferenceMs, persistedInferenceMs } from ${
  importSpecifier(join(ROOT, "src", "scripts", "inference_activity.ts"))
};
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, () => new Response("ok"));
const base = "http://127.0.0.1:" + server.addr.port;
const out = {};
await fetch(base + "/v1/models"); // liveness/model-list: must NOT mark
out.afterGet = lastObservedInferenceMs();
const res = await fetch(base + "/v1/messages", { method: "POST", body: "{}" });
out.body = await res.text(); // the wrapped handler must still serve normally
out.afterPost = lastObservedInferenceMs();
out.persisted = persistedInferenceMs();
await server.shutdown();
console.log(JSON.stringify(out));
`;

test("the preloaded observer marks inference POSTs through a real Deno.serve, not GETs", () => {
  tmpHome();
  const target = join(dir, "target.ts");
  writeFileSync(target, TARGET_SCRIPT);
  const before = Date.now();
  const res = runSync(Deno.execPath(), [...denoRunArgs("--preload", PRELOAD), target], {
    env: { ...process.env, COPILOT_API_HOME: dir },
  });
  if (res.exitCode !== 0) throw new Error(`preloaded target failed: ${res.stderr}`);
  const out = JSON.parse(res.stdout.trim()) as {
    afterGet: number;
    afterPost: number;
    body: string;
    persisted: number;
  };
  expect(out.body).toBe("ok"); // observation never broke serving
  expect(out.afterGet).toBe(0);
  expect(out.afterPost).toBeGreaterThanOrEqual(before);
  expect(out.persisted).toBe(out.afterPost); // the first mark persists immediately
});

// Drift alarm: the observer wraps Deno.serve from a preload, and srvx's Deno adapter looks
// Deno.serve up at serve time, so the wrapper is what serves. A release that drops srvx or
// serves without Deno.serve would silently stop marking, so the check follows srvx's own
// "deno" export condition, not fixed paths.
test("the installed proxy still serves through srvx's call-time Deno.serve lookup", () => {
  const proxyDir = resolvePackageDir("@jeffreycao/copilot-api", ROOT);
  const startBundle = readdirSync(join(proxyDir, "dist")).find(
    (name) => name.startsWith("start-") && name.endsWith(".js"),
  );
  expect(startBundle).toBeDefined();
  expect(readFileSync(join(proxyDir, "dist", startBundle as string), "utf8")).toContain(
    'from "srvx"',
  );
  const srvxDir = resolvePackageDir("srvx", proxyDir);
  const srvxPkg = JSON.parse(readFileSync(join(srvxDir, "package.json"), "utf8")) as {
    exports?: Record<string, { deno?: unknown }>;
  };
  const denoEntry = srvxPkg.exports?.["."]?.deno;
  if (typeof denoEntry !== "string") {
    throw new Error('srvx no longer exports a deno adapter under its "." deno condition');
  }
  const entry = join(srvxDir, denoEntry);
  const entrySource = readFileSync(entry, "utf8");
  const sources = [entrySource];
  for (const match of entrySource.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const spec = match[1] as string;
    const path = join(dirname(entry), spec);
    if (existsSync(path)) sources.push(readFileSync(path, "utf8"));
  }
  expect(sources.some((s) => s.includes("Deno.serve("))).toBe(true);
});
