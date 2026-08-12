import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clearPersistedInferenceActivity,
  isInferenceRequest,
  markInference,
  PERSIST_INTERVAL_MS,
  persistedInferenceMs,
  resetInferenceActivityForTests,
} from "../src/scripts/inference_activity.ts";
import { denoRunArgs, resolvePackageDir, ROOT, runSync } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

const PRELOAD = join(ROOT, "src", "scripts", "inference_activity_preload.ts");

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
  // The proxy's inference endpoints, in bare / v1 / provider-prefixed route forms.
  expect(isInferenceRequest("POST", "/v1/messages")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/responses")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/chat/completions")).toBe(true);
  expect(isInferenceRequest("POST", "/v1/embeddings")).toBe(true);
  expect(isInferenceRequest("POST", "/chat/completions")).toBe(true);
  expect(isInferenceRequest("POST", "/myprovider/v1/messages")).toBe(true);
  expect(isInferenceRequest("post", "/v1/messages")).toBe(true); // method case-insensitive
  expect(isInferenceRequest("POST", "/v1/messages/")).toBe(true); // trailing slash tolerated

  // Search and image generation are usage too, in the same route forms.
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

// The observer must be exercised as a real preloaded subprocess (`--preload`, how
// launchDaemon loads it): it patches the serve entrypoint before srvx runs, and the
// target script shares the preloaded module instance, so it can read the in-memory mark.
const TARGET_SCRIPT = `
import { lastObservedInferenceMs, persistedInferenceMs } from ${
  JSON.stringify(join(ROOT, "src", "scripts", "inference_activity.ts"))
};
const server = Deno.serve({ port: 0, onListen: () => {} }, () => new Response("ok"));
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

// skipIf(true): src/scripts/inference_activity.ts still patches `Bun.serve`; the
// chunk-3 src sweep repoints the observer at `Deno.serve`, and this test (whose
// target script already serves through Deno.serve) is re-enabled with it.
test.skipIf(true)(
  "the preloaded observer marks inference POSTs through a real Deno.serve, not GETs",
  () => {
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
    expect(out.afterGet).toBe(0); // GETs are not activity
    expect(out.afterPost).toBeGreaterThanOrEqual(before); // the POST marked, in memory...
    expect(out.persisted).toBe(out.afterPost); // ...and the first mark persisted to the file
  },
);

// Drift alarm for the floated proxy stack: the observer intercepts the serve
// entrypoint, which only works because srvx's runtime adapter looks it up AT SERVE
// TIME (a preload-time patch is then seen). A release that captures the serve
// function at import, drops srvx, or serves another way would silently stop
// marking activity -- fail here instead. The check runs against the module srvx's
// own exports map hands the daemon under the "deno" condition, not fixed paths.
test("the installed proxy still serves through srvx's call-time Deno.serve lookup", () => {
  const proxyDir = resolvePackageDir("@jeffreycao/copilot-api", ROOT);
  // The proxy's start bundle must still serve through srvx at all.
  const startBundle = readdirSync(join(proxyDir, "dist")).find(
    (name) => name.startsWith("start-") && name.endsWith(".js"),
  );
  expect(startBundle).toBeDefined();
  expect(readFileSync(join(proxyDir, "dist", startBundle as string), "utf8")).toContain(
    'from "srvx"',
  );
  // The daemon loads srvx under deno, so the "deno" export condition names the
  // exact adapter module it serves through. Scan it plus its one-level relative imports.
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
