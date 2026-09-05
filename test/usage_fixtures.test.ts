import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { discoverClaudeSessionRoots, readClaudeSessions } from "../src/usage/claude_sessions.ts";
import { discoverCodexSessionRoots, readCodexSessions } from "../src/usage/codex_sessions.ts";
import type { UsageReport } from "../src/usage/usage.ts";
import { localDayKey, MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { tmpDir } from "./helpers.ts";
import { denoRunArgs, ROOT, runSync } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";
import {
  claudeLineType,
  codexLineType,
  filenameShape,
  type GeneratedTree,
  generateUsageTree,
  LINE_SPLITTING_CODE_POINTS,
  loadProfile,
  MEGABYTE,
  modelLabel,
  mulberry32,
  parseProfile,
  type Profile,
  PROFILE_PATH,
  quantiles,
  sampleQuantile,
  templates,
} from "./helpers/usage_fixtures.ts";

/** Tree size for the shared fixtures; CI may raise it through the env knob. */
const FIXTURE_MB = Number(process.env.COPILOT_ENV_USAGE_FIXTURE_MB ?? "5");
const SEED = 20260904;

const roots: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = tmpDir("usage-fixtures-");
  roots.push(root);
  return root;
}

let shared: Promise<GeneratedTree> | undefined;
let plain: Promise<GeneratedTree> | undefined;

/** One adversarial tree per test run, generated on first use. */
function sharedTree(): Promise<GeneratedTree> {
  shared ??= generateUsageTree({ root: freshRoot(), mb: FIXTURE_MB, seed: SEED });
  return shared;
}

/** One plain tree (no repeats, forks, resumes, torn tail, or needles), generated on first use. */
function plainTree(): Promise<GeneratedTree> {
  plain ??= generateUsageTree({ root: freshRoot(), mb: 2, seed: 11, adversarial: false });
  return plain;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** The decoded text of a generated log file, `.jsonl.zst` included. */
function textOf(file: string): string {
  const raw = readFileSync(file);
  return file.endsWith(".zst") ? zstdDecompressSync(raw).toString("utf8") : raw.toString("utf8");
}

/** Every file's content keyed by its root-relative path with forward slashes. */
function snapshot(tree: GeneratedTree): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const file of walk(tree.root)) {
    out.set(relative(tree.root, file).replaceAll("\\", "/"), readFileSync(file));
  }
  return out;
}

interface ReadBack {
  codex: Map<string, UsageReport>;
  claude: UsageReport;
}

/** The readers' view of a tree, days cut in UTC to match the generator's ledger. */
async function readBack(tree: GeneratedTree): Promise<ReadBack> {
  return {
    codex: await readCodexSessions(discoverCodexSessionRoots([tree.codexRoot]), undefined, "UTC"),
    claude: await readClaudeSessions(
      discoverClaudeSessionRoots([tree.claudeRoot]),
      undefined,
      "UTC",
    ),
  };
}

/** A report's roll-up as a plain sorted object, so a mismatch prints legibly. */
function byModel(report: UsageReport): Record<string, unknown> {
  return Object.fromEntries([...report.byModel].sort(([a], [b]) => a.localeCompare(b)));
}

function perDay(report: UsageReport): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    [...report.perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, models]) => [
      day,
      Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b))),
    ]),
  );
}

const PROFILER_ARGS = [
  "run",
  "--config",
  join(ROOT, "deno.json"),
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-sys=homedir,hostname",
  join(ROOT, "scripts", "usage_profile.ts"),
];

test("the committed profile parses, and a malformed one is rejected without echoing values", () => {
  const profile = loadProfile();
  expect(profile.version).toBe(1);
  expect(Object.keys(profile.codex.models).length).toBeGreaterThan(0);
  expect(Object.keys(profile.claude.models).length).toBeGreaterThan(0);
  const doc = JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as Record<string, unknown>;
  const codex = doc.codex as Record<string, unknown>;
  expect(() => parseProfile({ ...doc, codex: { ...codex, usageLineShare: 1.5 } })).toThrow(
    /codex\.usageLineShare/,
  );
  const { fileBytes: _dropped, ...withoutFileBytes } = codex;
  expect(() => parseProfile({ ...doc, codex: withoutFileBytes })).toThrow(/codex\.fileBytes/);
  expect(() => parseProfile({ ...doc, version: 2 })).toThrow(/version/);
  // Quantiles must be ordered and counts whole.
  const unordered = { ...(codex.fileBytes as Record<string, number>), p50: 1, p25: 2 };
  expect(() => parseProfile({ ...doc, codex: { ...codex, fileBytes: unordered } })).toThrow(
    /non-decreasing/,
  );
  const fractional = { ...(codex.fileBytes as Record<string, number>), count: 1.5 };
  expect(() => parseProfile({ ...doc, codex: { ...codex, fileBytes: fractional } })).toThrow(
    /fileBytes\.count/,
  );
  // A source with no usable model is refused at the boundary, so the generator never has to.
  expect(() => parseProfile({ ...doc, codex: { ...codex, models: {} } })).toThrow(
    /codex\.models.*positive share/,
  );
  // The message names the path and the expectation, never the value it saw.
  let message = "";
  try {
    parseProfile({ ...doc, version: "PRIVATE_SENTINEL" });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).toContain("version");
  expect(message).not.toContain("PRIVATE_SENTINEL");
  // A record key is data too: an invalid model entry is reported as <entry>, never by name.
  let keyed = "";
  try {
    parseProfile({ ...doc, codex: { ...codex, models: { PRIVATE_SENTINEL: { share: 2 } } } });
  } catch (e) {
    keyed = e instanceof Error ? e.message : String(e);
  }
  expect(keyed).toContain("codex.models.<entry>");
  expect(keyed).not.toContain("PRIVATE_SENTINEL");
  // Record keys are checked at the boundary too: an unreviewed line type or a model id off
  // the vendor pattern is refused even with a perfectly valid value under it.
  const claude = doc.claude as Record<string, Record<string, unknown>>;
  const quantile = Object.values(claude.bytesPerLine!)[0]!;
  const model = Object.values(claude.models!)[0]!;
  const withKey = (field: string, key: string, value: unknown): unknown => ({
    ...doc,
    claude: { ...claude, [field]: { ...claude[field], [key]: value } },
  });
  expect(() => parseProfile(withKey("bytesPerLine", "customer-acme", quantile))).toThrow(
    /claude\.bytesPerLine\.<entry>.*reviewed set/,
  );
  expect(() => parseProfile(withKey("lineTypeShare", "note from vivs", 0.1))).toThrow(
    /claude\.lineTypeShare\.<entry>.*reviewed set/,
  );
  expect(() => parseProfile(withKey("models", "my company finetune", model))).toThrow(
    /claude\.models\.<entry>.*vendor-id/,
  );
  // A Codex line type is not a Claude one: the sets are per source.
  expect(() => parseProfile(withKey("bytesPerLine", "event_msg/token_count", quantile))).toThrow(
    /claude\.bytesPerLine\.<entry>/,
  );
  expect(parseProfile(withKey("bytesPerLine", "other", quantile)).claude.bytesPerLine.other)
    .toEqual(quantile);
  // Unknown fields are refused, not stripped, and neither their name nor value is echoed.
  for (
    const bad of [
      { ...doc, PRIVATE_SENTINEL: "clientname" },
      { ...doc, codex: { ...codex, PRIVATE_SENTINEL: "clientname" } },
      {
        ...doc,
        codex: { ...codex, fileBytes: { ...(codex.fileBytes as object), PRIVATE_SENTINEL: 1 } },
      },
    ]
  ) {
    let unknown = "";
    try {
      parseProfile(bad);
    } catch (e) {
      unknown = e instanceof Error ? e.message : String(e);
    }
    expect(unknown).toContain("invalid usage profile");
    expect(unknown).not.toContain("PRIVATE_SENTINEL");
    expect(unknown).not.toContain("clientname");
  }
  // Malformed JSON gets a fixed message; the runtime's own would quote the input.
  const broken = join(freshRoot(), "profile.json");
  writeFileSync(broken, '{ "PRIVATE_SENTINEL": clientname');
  let malformed = "";
  try {
    loadProfile(broken);
  } catch (e) {
    malformed = e instanceof Error ? e.message : String(e);
  }
  expect(malformed).toBe("usage profile is not valid JSON");
});

test("line types and model ids fold onto closed sets, so a type word cannot carry content", () => {
  expect(codexLineType({ type: "event_msg", payload: { type: "token_count" } })).toBe(
    "event_msg/token_count",
  );
  expect(codexLineType({ type: "response_item", payload: { type: "message", role: "user" } }))
    .toBe("response_item/message/user");
  expect(claudeLineType({ type: "system", subtype: "turn_duration" })).toBe(
    "system/turn_duration",
  );
  expect(claudeLineType({ type: "user", message: { content: "hi" } })).toBe("user/prompt");
  // Negative controls: schema-shaped words that are not in the reviewed sets.
  expect(codexLineType({ type: "PRIVATE_SENTINEL" })).toBe("other");
  expect(codexLineType({ type: "event_msg", payload: { type: "customer-acme" } })).toBe("other");
  expect(codexLineType({ type: "response_item", payload: { type: "message", role: "Vivs" } }))
    .toBe("other");
  expect(claudeLineType({ type: "system", subtype: "call me at 555" })).toBe("other");
  expect(claudeLineType({ type: "note from vivs" })).toBe("other");
  expect(modelLabel("claude-opus-4-8")).toBe("claude-opus-4-8");
  expect(modelLabel("gpt-5.6")).toBe("gpt-5.6");
  expect(modelLabel("openai/gpt-5.6")).toBe("openai/gpt-5.6");
  expect(modelLabel("my company finetune")).toBe("other");
  expect(modelLabel("/Users/someone/model")).toBe("other");
  expect(modelLabel(42)).toBe("other");
});

/** Every key and string value of a JSON document. */
function jsonWords(text: string): string[] {
  const words: string[] = [];
  JSON.parse(text, (key, value: unknown) => {
    if (key !== "") words.push(key);
    if (typeof value === "string") words.push(value);
    return value;
  });
  return words;
}

/** The pattern every profile word must fit: an identifier with a small punctuation set. */
const SCHEMA_WORD = /^[a-z0-9_./<>:\-]+$/i;

test("the committed profile carries only schema words: line types, model ids, filename shapes", () => {
  const text = readFileSync(PROFILE_PATH, "utf8");
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  expect(text).not.toMatch(/\/Users\/|\/home\/|C:\\\\|https?:\/\/|@/);
  // The words a profile holds (its keys: line types, model ids, filename shapes) are the
  // writers' schema words. The control below is what proves the pattern can fail.
  const words = jsonWords(text);
  expect(words.length).toBeGreaterThan(50);
  for (const word of words) expect(word).toMatch(SCHEMA_WORD);
  const leaked = jsonWords(JSON.stringify({ "models": { "please fix /Users/someone/x": 1 } }));
  expect(leaked.some((word) => !SCHEMA_WORD.test(word))).toBe(true);
  const profile = loadProfile();
  const closed = new Set([
    "rollout-9999-99-99T99-99-99-UUID.jsonl",
    "rollout-9999-99-99T99-99-99-UUID_UUID.jsonl",
    "rollout-9999-99-99T99-99-99-ID.jsonl",
    "rollout-9999-99-99T99-99-99-UUID.jsonl.zst",
    "UUID.jsonl",
    "agent-ID.jsonl",
    "journal.jsonl",
    "other.jsonl",
  ]);
  for (const shape of Object.keys(profile.codex.filenameShapes)) {
    expect(closed.has(shape)).toBe(true);
  }
  for (const shape of Object.keys(profile.claude.filenameShapes)) {
    expect(closed.has(shape)).toBe(true);
  }
});

test("filenameShape maps every basename into a closed set, so a private name cannot leak", () => {
  expect(filenameShape("rollout-2026-08-07T08-02-41-4952e073-d751-4434-aabd-817d5406526a.jsonl"))
    .toBe("rollout-9999-99-99T99-99-99-UUID.jsonl");
  expect(
    filenameShape("rollout-2026-08-07T08-02-41-4952e073-d751-4434-aabd-817d5406526a.jsonl.zst"),
  ).toBe("rollout-9999-99-99T99-99-99-UUID.jsonl.zst");
  expect(filenameShape("435e03ba-37d7-4f1e-a358-767170ac07d5.jsonl")).toBe("UUID.jsonl");
  expect(filenameShape("agent-aopus-reviewer-0579f37904602ce3.jsonl")).toBe("agent-ID.jsonl");
  expect(filenameShape("journal.jsonl")).toBe("journal.jsonl");
  // Negative controls: names that would carry a person's or machine's words.
  expect(filenameShape("vivs-laptop-notes.jsonl")).toBe("other.jsonl");
  expect(filenameShape("rollout-2026-08-07T08-02-41-secret-project.jsonl"))
    .toBe("rollout-9999-99-99T99-99-99-ID.jsonl");
  expect(filenameShape("customer-acme.jsonl")).toBe("other.jsonl");
});

test("the generator reads nothing from the environment or the real home", () => {
  const source = readFileSync(join(ROOT, "test", "helpers", "usage_fixtures.ts"), "utf8");
  for (const forbidden of ["homedir", "Deno.env", "process.env", "Date.now", "Math.random"]) {
    expect(source).not.toContain(forbidden);
  }
  const fixtures = [
    join(ROOT, "test", "fixtures", "usage", "templates", "codex.json"),
    join(ROOT, "test", "fixtures", "usage", "templates", "claude.json"),
    PROFILE_PATH,
    join(ROOT, "test", "helpers", "usage_fixtures.ts"),
    join(ROOT, "scripts", "usage_fixtures.ts"),
    join(ROOT, "scripts", "usage_profile.ts"),
  ];
  // Committed files stay ASCII; the non-ASCII filler is written at runtime from escapes.
  for (const file of fixtures) expect(readFileSync(file, "latin1")).toMatch(/^[\t\n -~]*$/);
});

test("mulberry32 and the quantile sampler are pinned, so every OS draws the same stream", () => {
  const rng = mulberry32(1);
  // The first three draws of seed 1; a platform whose integer ops differed would move these.
  expect([rng(), rng(), rng()].map((x) => Math.round(x * 1e9))).toEqual([
    627073941,
    2735721,
    527447040,
  ]);
  const q = quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(q).toEqual({ count: 10, p5: 1, p25: 3, p50: 6, p75: 8, p95: 10, p99: 10 });
  const draw = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const x = sampleQuantile(draw, q);
    expect(x).toBeGreaterThanOrEqual(q.p5);
    expect(x).toBeLessThanOrEqual(q.p99);
  }
  expect(quantiles([])).toEqual({ count: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 });
});

test("the same seed yields identical bytes and a different seed does not", async () => {
  const a = await generateUsageTree({ root: freshRoot(), mb: 2, seed: 42 });
  const b = await generateUsageTree({ root: freshRoot(), mb: 2, seed: 42 });
  const c = await generateUsageTree({ root: freshRoot(), mb: 2, seed: 43 });
  const sa = snapshot(a);
  const sb = snapshot(b);
  expect([...sa.keys()]).toEqual([...sb.keys()]);
  for (const [path, bytes] of sa) expect(bytes.equals(sb.get(path)!)).toBe(true);
  expect(a.markers).toEqual(b.markers);
  expect(byModel(a.expected.claude)).toEqual(byModel(b.expected.claude));
  const sc = snapshot(c);
  expect([...sc.keys()]).not.toEqual([...sa.keys()]);
  expect(c.markers).not.toEqual(a.markers);
}, 60_000);

/**
 * SHA-256 over a fixed small corpus (seed 7, 1 MiB, 5 days): sorted root-relative paths with
 * forward slashes, each followed by the file's raw bytes. CI runs this on Linux, macOS, and
 * Windows, so a platform-dependent byte anywhere in the generator moves it. Any deliberate
 * change to the generator or the committed profile re-pins it.
 */
const PINNED_CORPUS_DIGEST = "c690363809f606f6f680264f49d9aba0fac771ee171a38f848d613eea6694a16";

test("a fixed corpus digests to the pinned value, so every OS writes the same bytes", async () => {
  const root = freshRoot();
  const tree = await generateUsageTree({ root, mb: 1, seed: 7, days: 5 });
  const entries = tree.files
    .map((f) => ({ rel: relative(root, f.path).replaceAll("\\", "/"), path: f.path }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.rel}\n`);
    hash.update(readFileSync(entry.path));
  }
  expect(hash.digest("hex")).toBe(PINNED_CORPUS_DIGEST);
}, 60_000);

test(
  "the tree lands within 10% of the requested size and reports every file it wrote",
  async () => {
    const tree = await sharedTree();
    const total = tree.files.reduce((sum, f) => sum + f.bytes, 0);
    expect(Math.abs(total - FIXTURE_MB * MEGABYTE)).toBeLessThanOrEqual(
      0.1 * FIXTURE_MB * MEGABYTE,
    );
    // The reported span bounds every timestamp any line carries, tightly at both ends.
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    for (const f of tree.files) {
      for (const m of textOf(f.path).matchAll(/"timestamp":"([^"]+)"/g)) {
        const ms = Date.parse(m[1]!);
        earliest = Math.min(earliest, ms);
        latest = Math.max(latest, ms);
      }
    }
    expect(tree.firstEventMs).toBe(earliest);
    expect(tree.lastEventMs).toBe(latest);
    expect(latest - earliest).toBeGreaterThan(MILLISECONDS_PER_DAY);
    // Small adversarial trees across seeds: the scripted ghost parent (built, resumed, never
    // written), the popped truncated line, and the timestamp-free headers must never be an
    // endpoint. Each tree is checked to hold the parentless fork, so the claim is not idle.
    for (const seed of [1, 2, 3, 4, 5]) {
      const small = await generateUsageTree({ root: freshRoot(), mb: 2, seed });
      const stamps = small.files.flatMap((f) =>
        [...textOf(f.path).matchAll(/"timestamp":"([^"]+)"/g)].map((m) => Date.parse(m[1]!))
      );
      expect(small.firstEventMs).toBe(Math.min(...stamps));
      expect(small.lastEventMs).toBe(Math.max(...stamps));
      const metas = small.files.filter((f) => f.source === "codex").map((f) =>
        JSON.parse(textOf(f.path).split("\n")[0]!) as { payload: Record<string, string> }
      );
      const ids = new Set(metas.map((m) => m.payload["id"]));
      const parentless = metas.some((m) =>
        m.payload["forked_from_id"] !== undefined && !ids.has(m.payload["forked_from_id"])
      );
      expect(parentless).toBe(true);
    }
    const onDisk = walk(tree.root).filter((f) => !f.includes(".copilot-env"));
    expect(tree.files.map((f) => f.path).sort()).toEqual(onDisk.sort());
    for (const file of tree.files) expect(statSync(file.path).size).toBe(file.bytes);
    expect(tree.files.some((f) => f.source === "codex")).toBe(true);
    expect(tree.files.some((f) => f.source === "claude")).toBe(true);
  },
  60_000,
);

test("every line is valid JSON and LF-terminated, except exactly one torn tail", async () => {
  const tree = await sharedTree();
  const profile = loadProfile();
  let torn = 0;
  const codexTypes = new Set<string>();
  const claudeTypes = new Set<string>();
  for (const file of tree.files) {
    const text = textOf(file.path);
    const terminated = text.endsWith("\n");
    const lines = text.split("\n");
    const tail = lines.pop();
    if (!terminated) {
      torn++;
      expect(() => JSON.parse(tail!)).toThrow();
    } else {
      expect(tail).toBe("");
    }
    for (const line of lines) {
      expect(line).not.toContain("\r");
      const parsed = JSON.parse(line) as Record<string, unknown>;
      (file.source === "codex" ? codexTypes : claudeTypes).add(
        file.source === "codex" ? codexLineType(parsed) : claudeLineType(parsed),
      );
    }
  }
  expect(torn).toBe(1);
  // The core of each format is exercised, every emitted type has a template, and each is one
  // the profile measured on real logs (an unmeasured type would be an invented shape).
  for (
    const type of [
      "session_meta",
      "turn_context",
      "event_msg/token_count",
      "response_item/reasoning",
      "response_item/custom_tool_call_output",
      "response_item/message/assistant",
      "response_item/message/user",
    ]
  ) {
    expect(codexTypes.has(type)).toBe(true);
  }
  for (
    const type of [
      "assistant",
      "user/prompt",
      "user/tool_result",
      "attachment",
      "system/turn_duration",
      "last-prompt",
    ]
  ) {
    expect(claudeTypes.has(type)).toBe(true);
  }
  for (const type of codexTypes) {
    expect(templates.codex.lines[type]).toBeDefined();
    expect(profile.codex.bytesPerLine[type]).toBeDefined();
  }
  for (const type of claudeTypes) {
    // The workflow journal is not a transcript: its lines fold to "other", the readers' to skip.
    if (type === "other") continue;
    expect(templates.claude.lines[type]).toBeDefined();
    expect(profile.claude.bytesPerLine[type]).toBeDefined();
  }
  expect(codexTypes.has("other")).toBe(false);
}, 60_000);

test(
  "the layout matches the real trees: paths, shapes, archives, subagents, forks, resumes",
  async () => {
    const tree = await sharedTree();
    const profile = loadProfile();
    const rel = tree.files.map((f) => relative(tree.root, f.path).replaceAll("\\", "/"));
    for (const path of rel.filter((p) => p.startsWith(".codex/"))) {
      expect(path).toMatch(
        /^\.codex\/(sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl|archived_sessions\/rollout-.*\.jsonl\.zst)$/,
      );
    }
    for (const path of rel.filter((p) => p.startsWith(".claude/"))) {
      expect(path).toMatch(/^\.claude\/projects\/-[a-z-]+\/.+\.jsonl$/);
      const shape = filenameShape(path.split("/").pop()!);
      expect(Object.keys(profile.claude.filenameShapes)).toContain(shape);
    }
    expect(rel.some((p) => p.endsWith(".jsonl.zst"))).toBe(true);
    expect(rel.some((p) => /\/subagents\/agent-[0-9a-f]+\.jsonl$/.test(p))).toBe(true);
    expect(rel.some((p) => /\/subagents\/workflows\/wf_[0-9a-f-]+\/journal\.jsonl$/.test(p))).toBe(
      true,
    );
    // A live rollout and its archived copy share a basename; the archive-only one has none.
    const live = new Set(
      rel.filter((p) => p.includes("/sessions/")).map((p) => p.split("/").pop()!),
    );
    const archived = rel.filter((p) => p.endsWith(".zst")).map((p) =>
      p.split("/").pop()!.replace(/\.zst$/, "")
    );
    expect(archived.some((name) => live.has(name))).toBe(true);
    expect(archived.some((name) => !live.has(name))).toBe(true);

    // Forks: one session_meta of their own carrying forked_from_id as the first line, the
    // parent's items copied under monotonic timestamps inside the two-second batch window;
    // one fork's parent is on disk and one is not.
    const codexFiles = tree.files.filter((f) => f.source === "codex");
    const sessionIds = new Set<string>();
    const parsedByFile = new Map<string, Record<string, unknown>[]>();
    const forks: { parent: string; lines: Record<string, unknown>[] }[] = [];
    let multiMeta = 0;
    for (const f of codexFiles) {
      const lines = textOf(f.path).split("\n").filter((l) => l.length > 0).flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      const metas = lines.filter((l) => l.type === "session_meta");
      if (metas.length > 1) multiMeta++;
      expect(lines[0]!.type).toBe("session_meta");
      // The rollout filename carries the session start to the second; so does the first line.
      const stamp = /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(
        f.path.split(/[\\/]/).pop()!,
      )!;
      expect((lines[0]!.timestamp as string).slice(0, 19)).toBe(
        `${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}`,
      );
      const first = metas[0]!.payload as Record<string, unknown>;
      sessionIds.add(first.id as string);
      parsedByFile.set(first.id as string, lines);
      if (typeof first.forked_from_id === "string") {
        forks.push({ parent: first.forked_from_id, lines });
      }
    }
    expect(forks.length).toBeGreaterThanOrEqual(2);
    expect(forks.some((f) => sessionIds.has(f.parent))).toBe(true);
    expect(forks.some((f) => !sessionIds.has(f.parent))).toBe(true);
    // With the parent on disk, the copy holds EVERY parent item (all lines but its
    // session_meta ones), a pasted "session_meta" needle notwithstanding.
    // The control for the copy filter: at least one on-disk parent carries a NON-meta line with
    // the pasted word "session_meta" (the scripted fork parent does), so a copy that filtered by
    // substring rather than by type would come up short below.
    const parentsWithNeedle = forks.filter((f) => sessionIds.has(f.parent)).filter((f) =>
      parsedByFile.get(f.parent)!.some((l) =>
        l.type !== "session_meta" && JSON.stringify(l).includes("session_meta")
      )
    );
    expect(parentsWithNeedle.length).toBeGreaterThan(0);
    for (const fork of forks.filter((f) => sessionIds.has(f.parent))) {
      const parentItems = parsedByFile.get(fork.parent)!.filter((l) => l.type !== "session_meta");
      const metaMs = Date.parse(fork.lines[0]!.timestamp as string);
      const copied = fork.lines.slice(1).filter((l) =>
        Date.parse(l.timestamp as string) - metaMs <= 2_000
      );
      expect(copied.length).toBe(parentItems.length);
      expect(copied.map((l) => l.type)).toEqual(parentItems.map((l) => l.type));
    }
    for (const fork of forks) {
      const metaMs = Date.parse(fork.lines[0]!.timestamp as string);
      let prev = metaMs;
      let copiedCounts = 0;
      let ownLines = 0;
      for (const line of fork.lines.slice(1)) {
        const ms = Date.parse(line.timestamp as string);
        if (ms - metaMs > 2_000) {
          ownLines++;
          continue;
        }
        // Nothing of the fork's own may sit inside the readers' two-second fallback window:
        // the copies end within 800 ms and the first own line waits past the window.
        expect(ms - metaMs).toBeLessThanOrEqual(800);
        // Copies are items only: a parent's re-emitted session_meta is never among them.
        expect(line.type).not.toBe("session_meta");
        expect(ms).toBeGreaterThanOrEqual(prev);
        prev = ms;
        if ((line.payload as Record<string, unknown>).type === "token_count") copiedCounts++;
      }
      expect(copiedCounts).toBeGreaterThan(0);
      expect(ownLines).toBeGreaterThan(0);
    }
    // A resumed Codex session re-emits its session_meta (the scripted midnight session does),
    // and some file carries the same token_count info twice, which the readers book once
    // (the exact oracle proves the once).
    expect(multiMeta).toBeGreaterThanOrEqual(1);
    const repeatedInfo = codexFiles.some((f) => {
      const infos = textOf(f.path).split("\n").filter((l) => l.includes('"token_count"')).flatMap(
        (l) => {
          try {
            return [JSON.stringify((JSON.parse(l) as { payload: { info: unknown } }).payload.info)];
          } catch {
            return [];
          }
        },
      );
      return new Set(infos).size < infos.length;
    });
    expect(repeatedInfo).toBe(true);

    // A Claude resume repeats a message id across two transcripts.
    const idsByFile = tree.files.filter((f) => f.source === "claude").map((f) =>
      new Set(textOf(f.path).match(/"id":"msg_[0-9a-f]+"/g) ?? [])
    );
    const seen = new Set<string>();
    let repeated = false;
    for (const ids of idsByFile) {
      for (const id of ids) {
        if (seen.has(id)) repeated = true;
        seen.add(id);
      }
    }
    expect(repeated).toBe(true);
  },
  60_000,
);

test(
  "planted markers and pasted needles are present, and the content is synthetic prose",
  async () => {
    const tree = await sharedTree();
    const texts = tree.files.map((f) => textOf(f.path));
    expect(tree.markers.length).toBeGreaterThan(0);
    for (const marker of tree.markers) {
      expect(texts.some((text) => text.includes(marker))).toBe(true);
    }
    const all = texts.join("\n");
    // Escaped needles inside prompt text, plus an unescaped one nested in a tool input.
    expect(all).toContain('pasted: \\"token_count\\"');
    expect(all).toContain('pasted: \\"type\\":\\"assistant\\"');
    expect(all).toContain('"filter":{"type":"assistant","token_count":1}');
    // Non-ASCII filler and escaped quotes reach the files.
    expect(all).toMatch(/[^\t\n -~]/);
    expect(all).toContain('\\"quoted\\"');
    expect(all).toContain("back\\\\slash");
    // Never the code points node:readline also splits on (the goldens' reader would lose the
    // line); the control proves the check sees them when present.
    for (const cp of LINE_SPLITTING_CODE_POINTS) expect(all.includes(cp)).toBe(false);
    expect(LINE_SPLITTING_CODE_POINTS.every((cp) => `a${cp}b`.includes(cp))).toBe(true);
    expect(LINE_SPLITTING_CODE_POINTS).toEqual(["\u2028", "\u2029", "\u0085"]);
  },
  60_000,
);

test("the readers return exactly the usage the generator planted (the drift canary)", async () => {
  const tree = await sharedTree();
  expect(discoverCodexSessionRoots([tree.codexRoot]).length).toBe(2);
  expect(discoverClaudeSessionRoots([tree.claudeRoot]).length).toBe(1);
  const got = await readBack(tree);

  // Codex: per provider, per canonical model, per UTC day, all exact. Forks, the archived
  // duplicate, the repeated counts, and the torn tail add nothing beyond the ledger.
  expect([...got.codex.keys()].sort()).toEqual([...tree.expected.codex.keys()].sort());
  for (const [provider, expected] of tree.expected.codex) {
    const report = got.codex.get(provider)!;
    expect(byModel(report)).toEqual(byModel(expected));
    expect(perDay(report)).toEqual(perDay(expected));
  }
  expect([...got.codex.values()].some((r) => r.perDay.size > 1)).toBe(true);
  // No day carries an all-zero row on either side: an exact streaming repeat touches no day.
  const zeroDay = (report: UsageReport): boolean =>
    [...report.perDay.values()].some((models) =>
      [...models.values()].some((u) => u.input + u.output + u.cacheRead + u.cacheCreation === 0)
    );
  expect(zeroDay(tree.expected.claude)).toBe(false);
  expect(zeroDay(got.claude)).toBe(false);
  // Claude: the roll-up is exact. The per-day split of a resumed message's streaming delta
  // follows the readers' file order, which readdir does not fix across OSes, so the days
  // are compared exactly on the resume-free tree below.
  expect(byModel(got.claude)).toEqual(byModel(tree.expected.claude));
  expect(got.claude.perDay.size).toBeGreaterThan(1);

  const plainRead = await readBack(await plainTree());
  const plainExpected = (await plainTree()).expected;
  expect([...plainRead.codex.keys()].sort()).toEqual([...plainExpected.codex.keys()].sort());
  for (const [provider, expected] of plainExpected.codex) {
    expect(perDay(plainRead.codex.get(provider)!)).toEqual(perDay(expected));
  }
  expect(byModel(plainRead.claude)).toEqual(byModel(plainExpected.claude));
  expect(perDay(plainRead.claude)).toEqual(perDay(plainExpected.claude));
}, 90_000);

test("the exact-usage oracle bites: a raised snapshot or an extra count is detected", async () => {
  // A private plain tree, then one Claude message's snapshot raised by an appended line
  // the readers book as a positive delta, and one Codex token_count appended with a fresh
  // total (a distinct info, so dedup keeps it). Both must move the reports off the ledger,
  // or the comparison the previous test rests on would be decorative.
  const tree = await generateUsageTree({ root: freshRoot(), mb: 2, seed: 11, adversarial: false });
  const before = await readBack(tree);
  expect(byModel(before.claude)).toEqual(byModel(tree.expected.claude));
  for (const [provider, expected] of tree.expected.codex) {
    expect(byModel(before.codex.get(provider)!)).toEqual(byModel(expected));
  }

  const claudeFile = tree.files.find((f) =>
    f.source === "claude" && textOf(f.path).includes('"type":"assistant"')
  )!;
  const claudeLines = readFileSync(claudeFile.path, "utf8").split("\n").filter((l) => l !== "");
  const assistant = claudeLines.find((l) => l.includes('"type":"assistant"'))!;
  const raised = JSON.parse(assistant) as { "message": { "usage": { "output_tokens": number } } };
  raised.message.usage.output_tokens += 1_000;
  writeFileSync(claudeFile.path, `${[...claudeLines, JSON.stringify(raised)].join("\n")}\n`);

  const codexFile = tree.files.find((f) => f.source === "codex")!;
  const codexLines = readFileSync(codexFile.path, "utf8").split("\n").filter((l) => l !== "");
  const count = codexLines.find((l) => l.includes('"token_count"'))!;
  const extra = JSON.parse(count) as {
    "payload": { "info": { "total_token_usage": { "total_tokens": number } } };
  };
  extra.payload.info.total_token_usage.total_tokens += 1;
  writeFileSync(codexFile.path, `${[...codexLines, JSON.stringify(extra)].join("\n")}\n`);

  const after = await readBack(tree);
  expect(byModel(after.claude)).not.toEqual(byModel(tree.expected.claude));
  const codexMoved = [...tree.expected.codex].some(([provider, expected]) =>
    JSON.stringify(byModel(after.codex.get(provider)!)) !== JSON.stringify(byModel(expected))
  );
  expect(codexMoved).toBe(true);
}, 60_000);

test("a non-adversarial tree has no torn tail, archive, fork, or needle", async () => {
  const tree = await plainTree();
  for (const file of tree.files) {
    const text = textOf(file.path);
    expect(text.endsWith("\n")).toBe(true);
    expect(file.path.endsWith(".zst")).toBe(false);
    expect(text).not.toContain("pasted:");
    expect(text).not.toContain('"forked_from_id"');
  }
}, 60_000);

test(
  "a plain tree never repeats ids across files, even when the profile says it should",
  async () => {
    // forkShare 1 would resume or fork every session; adversarial:false must still win.
    const base = loadProfile();
    const flat = { count: 1, p5: 2, p25: 2, p50: 2, p75: 2, p95: 2, p99: 2 };
    const profile: Profile = {
      ...base,
      codex: { ...base.codex, forkShare: 1 },
      claude: { ...base.claude, forkShare: 1, directoryDepth: flat },
    };
    const tree = await generateUsageTree({
      root: freshRoot(),
      mb: 2,
      seed: 13,
      adversarial: false,
      profile,
    });
    const seen = new Set<string>();
    for (const f of tree.files) {
      const text = textOf(f.path);
      expect(text).not.toContain('"forked_from_id"');
      // Streaming repeats an id within one file; only a repeat ACROSS files is a resume.
      for (const id of new Set(text.match(/"id":"msg_[0-9a-f]+"/g) ?? [])) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  },
  60_000,
);

test("options are validated up front, and a zone-less end is refused", async () => {
  const profile: Profile = loadProfile();
  const root = freshRoot();
  await expect(generateUsageTree({ root, mb: 0, seed: 1, profile })).rejects.toThrow(/mb/);
  // Below the floor no file would be written and the span would be undefined; at the floor one
  // session is, and the span is real.
  await expect(generateUsageTree({ root, mb: 0.001, seed: 1, profile })).rejects.toThrow(/mb/);
  const floor = await generateUsageTree({ root: freshRoot(), mb: 0.01, seed: 1, profile });
  expect(floor.files.length).toBeGreaterThan(0);
  expect(Number.isFinite(floor.firstEventMs) && floor.firstEventMs <= floor.lastEventMs).toBe(true);
  expect(localDayKey(floor.firstEventMs)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(generateUsageTree({ root, mb: Infinity, seed: 1, profile })).rejects.toThrow(/mb/);
  // Finite but astronomically large would still overflow the byte budget or the day table.
  await expect(generateUsageTree({ root, mb: Number.MAX_VALUE, seed: 1, profile })).rejects
    .toThrow(/mb/);
  await expect(generateUsageTree({ root, mb: 1, seed: 1, days: 1e20, profile })).rejects.toThrow(
    /days/,
  );
  await expect(generateUsageTree({ root, mb: -Infinity, seed: 1, profile })).rejects.toThrow(/mb/);
  await expect(generateUsageTree({ root, mb: 1, seed: 1.5, profile })).rejects.toThrow(/seed/);
  await expect(generateUsageTree({ root, mb: 1, seed: 1, days: 0, profile })).rejects.toThrow(
    /days/,
  );
  await expect(generateUsageTree({ root, mb: 1, seed: 1, end: "yesterday", profile })).rejects
    .toThrow(/end/);
  // Without a zone the same text is a different instant on every host.
  await expect(generateUsageTree({ root, mb: 1, seed: 1, end: "2026-09-01T00:00:00", profile }))
    .rejects.toThrow(/zone/);
  const offset = await generateUsageTree({
    root: freshRoot(),
    mb: 1,
    seed: 1,
    days: 2,
    end: "2026-09-01T02:00:00+02:00",
    profile,
  });
  expect(offset.files.length).toBeGreaterThan(0);
}, 60_000);

test("the CLI wrapper writes the tree and prints one JSON summary line", () => {
  const root = freshRoot();
  const result = runSync("deno", [
    ...denoRunArgs(),
    join(ROOT, "scripts", "usage_fixtures.ts"),
    "--out",
    root,
    "--mb",
    "1",
    "--seed",
    "9",
    "--days",
    "3",
  ], { cwd: ROOT, timeoutMs: 60_000 });
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines.length).toBe(1);
  const summary = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(summary.root).toBe(root);
  expect(summary.files).toBeGreaterThan(0);
  expect(summary.bytes).toBeGreaterThan(0.9 * MEGABYTE);
  expect(typeof summary.seconds).toBe("number");
  expect(summary.mb).toBe(1);
  expect(summary.seed).toBe(9);
  // The span is reported as this host's local calendar days, inclusive, and holds every
  // timestamp in the tree; it comes from the seed, never the clock.
  const days = walk(root).filter((f) => !f.includes(".copilot-env")).flatMap((f) =>
    [...textOf(f).matchAll(/"timestamp":"([^"]+)"/g)].map((m) => localDayKey(Date.parse(m[1]!)))
  ).sort();
  expect(summary.firstDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(summary.lastDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(summary.firstDay).toBe(days[0]);
  expect(summary.lastDay).toBe(days[days.length - 1]);
  expect((summary.lastDay as string) <= "2026-09-01").toBe(true);
  expect(walk(join(root, ".codex")).length + walk(join(root, ".claude")).length).toBe(
    summary.files,
  );

  const bad = runSync("deno", [
    ...denoRunArgs(),
    join(ROOT, "scripts", "usage_fixtures.ts"),
    "--out",
    root,
  ], { cwd: ROOT, timeoutMs: 60_000 });
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr).toContain("--seed");
}, 90_000);

test("the profiler books a resumed message once, at the maximum across files", async () => {
  // Two transcripts share msg_1: the original stopped at a small snapshot, the resume carries
  // the final one with three buckets raised. One sample, at the maxima, three lines total.
  const home = freshRoot();
  const claude = join(home, ".claude", "projects", "-home-user-proj");
  const codex = join(home, ".codex", "sessions", "2026", "08", "01");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  const assistant = (ts: string, usage: Record<string, number>): string =>
    JSON.stringify({
      "type": "assistant",
      "timestamp": ts,
      "message": { "id": "msg_1", "model": "claude-opus-4-8", "role": "assistant", usage },
    });
  const low = { "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0 };
  const high = { "input_tokens": 10, "output_tokens": 50, "cache_read_input_tokens": 700 };
  writeFileSync(
    join(claude, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl"),
    `${assistant("2026-08-01T10:00:00.000Z", low)}\n`,
  );
  writeFileSync(
    join(claude, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl"),
    `${assistant("2026-08-01T10:00:00.000Z", low)}\n${
      assistant("2026-08-01T12:00:00.000Z", high)
    }\n`,
  );
  // Files the readers skip must not shape the profile: a foreign .jsonl beside the rollouts,
  // a compressed Claude transcript (the Claude reader takes plain .jsonl only), a stray file
  // at the projects root (not a project slug), and a symlinked directory holding a rollout
  // (the readers' Dirent walk never descends a symlink).
  writeFileSync(join(codex, "notes.jsonl"), `${JSON.stringify({ "type": "note" })}\n`);
  writeFileSync(join(claude, "cccccccc-cccc-4ccc-cccc-cccccccccccc.jsonl.zst"), "not a transcript");
  writeFileSync(join(home, ".claude", "projects", "stray-notes.txt"), "not a slug\n");
  const aside = join(home, "aside");
  mkdirSync(aside, { recursive: true });
  writeFileSync(
    join(aside, "rollout-2026-08-01T12-00-00-abababab-abab-4bab-abab-abababababab.jsonl"),
    `${
      JSON.stringify({
        "timestamp": "2026-08-01T12:00:00.000Z",
        "type": "session_meta",
        "payload": { "id": "s9" },
      })
    }\n`,
  );
  if (Deno.build.os !== "windows") symlinkSync(aside, join(codex, "linked"), "dir");
  // Codex: one rollout with a single count, a fork that copies that count and adds its own,
  // and a compressed archive duplicating the rollout. The readers book two counts in all,
  // and so must the profiler; every file still counts physically.
  const count = (ts: string, input: number): Record<string, unknown> => ({
    "timestamp": ts,
    "type": "event_msg",
    "payload": {
      "type": "token_count",
      "info": {
        "total_token_usage": { "input_tokens": input, "output_tokens": 1 },
        "last_token_usage": { "input_tokens": input, "output_tokens": 1, "cached_input_tokens": 2 },
      },
    },
  });
  const rollout = [
    { "timestamp": "2026-08-01T09:00:00.000Z", "type": "session_meta", "payload": { "id": "s1" } },
    {
      "timestamp": "2026-08-01T09:00:01.000Z",
      "type": "turn_context",
      "payload": { "model": "gpt-5.6" },
    },
    count("2026-08-01T09:00:02.000Z", 3),
  ].map((line) => JSON.stringify(line)).join("\n");
  const parentName = "rollout-2026-08-01T09-00-00-cccccccc-cccc-4ccc-cccc-cccccccccccc.jsonl";
  writeFileSync(join(codex, parentName), `${rollout}\n`);
  const fork = [
    {
      "timestamp": "2026-08-01T09:30:00.000Z",
      "type": "session_meta",
      "payload": { "id": "s2", "forked_from_id": "s1" },
    },
    {
      "timestamp": "2026-08-01T09:30:00.100Z",
      "type": "turn_context",
      "payload": { "model": "gpt-5.6" },
    },
    // The copied count sits five seconds after the fork's meta, OUTSIDE the fallback window:
    // only the parent's ledger can tell it apart. (The generator's parentless fork is the
    // in-window case.)
    count("2026-08-01T09:30:05.000Z", 3),
    count("2026-08-01T09:31:00.000Z", 9),
  ].map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(
    join(codex, "rollout-2026-08-01T09-30-00-dddddddd-dddd-4ddd-dddd-dddddddddddd.jsonl"),
    `${fork}\n`,
  );
  mkdirSync(join(home, ".codex", "archived_sessions"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "archived_sessions", `${parentName}.zst`),
    zstdCompressSync(Buffer.from(`${rollout}\n`, "utf8")),
  );
  // An UNRELATED session whose single count happens to equal the first one's: not a copy,
  // so it counts (the readers key their dedup by session and parent, not by content).
  const twin = [
    { "timestamp": "2026-08-01T11:00:00.000Z", "type": "session_meta", "payload": { "id": "s3" } },
    {
      "timestamp": "2026-08-01T11:00:01.000Z",
      "type": "turn_context",
      "payload": { "model": "gpt-5.6" },
    },
    count("2026-08-01T11:00:02.000Z", 3),
  ].map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(
    join(codex, "rollout-2026-08-01T11-00-00-eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee.jsonl"),
    `${twin}\n`,
  );
  // A second file under a DIFFERENT name but the same session id and the same count: the
  // readers dedupe live/archive pairs by rollout name only, so this one counts as well.
  writeFileSync(
    join(codex, "rollout-2026-08-01T09-05-00-ffffffff-ffff-4fff-ffff-ffffffffffff.jsonl"),
    `${rollout}\n`,
  );
  const out = join(freshRoot(), "profile.json");
  const result = runSync("deno", [...PROFILER_ARGS, "--out", out], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      COPILOT_API_HOME: join(home, ".copilot-env"),
    },
    timeoutMs: 120_000,
  });
  expect(result.exitCode).toBe(0);
  const profile = parseProfile(JSON.parse(readFileSync(out, "utf8")));
  const model = profile.claude.models["claude-opus-4-8"]!;
  expect(model.output).toEqual({ count: 1, p5: 50, p25: 50, p50: 50, p75: 50, p95: 50, p99: 50 });
  expect(model.cacheRead.p50).toBe(700);
  expect(model.input.p50).toBe(10);
  expect(profile.claude.repeatsPerUsageKey).toEqual({
    count: 1,
    p5: 3,
    p25: 3,
    p50: 3,
    p75: 3,
    p95: 3,
    p99: 3,
  });
  // The later file repeats an id first seen earlier: one of two files is a resume.
  expect(profile.claude.forkShare).toBe(0.5);
  const codexModel = profile.codex.models["gpt-5.6"]!;
  expect(codexModel.cacheRead.p50).toBe(2);
  // Four counts: the fork's copy adds nothing, the twin and the same-session file under
  // another name both do, and the archive duplicate is never opened (four files profiled,
  // five on disk). The readers over the same tree must agree event for event.
  expect(codexModel.input).toEqual({ count: 4, p5: 3, p25: 3, p50: 3, p75: 9, p95: 9, p99: 9 });
  expect(profile.codex.fileBytes.count).toBe(4);
  expect(profile.codex.forkShare).toBeCloseTo(1 / 4, 10);
  expect(profile.claude.slugSegments).toEqual({
    count: 1,
    p5: 3,
    p25: 3,
    p50: 3,
    p75: 3,
    p95: 3,
    p99: 3,
  });
  const readerEvents = [
    ...(await readCodexSessions(discoverCodexSessionRoots([join(home, ".codex")]))).values(),
  ]
    .reduce((n, r) => n + [...r.byModel.values()].reduce((m, u) => m + u.events, 0), 0);
  expect(readerEvents).toBe(4);
  const readerClaude = await readClaudeSessions(
    discoverClaudeSessionRoots([join(home, ".claude")]),
  );
  expect([...readerClaude.byModel.values()].reduce((m, u) => m + u.events, 0)).toBe(1);
  expect(profile.claude.fileBytes.count).toBe(2);
}, 60_000);

test(
  "the profiler round-trips a generated tree and refuses to write over an unreadable one",
  async () => {
    const tree = await sharedTree();
    const out = join(freshRoot(), "profile.json");
    const env = {
      ...process.env,
      HOME: tree.root,
      USERPROFILE: tree.root,
      CODEX_HOME: tree.codexRoot,
      CLAUDE_CONFIG_DIR: tree.claudeRoot,
      COPILOT_API_HOME: join(tree.root, ".copilot-env"),
    };
    const result = runSync("deno", [...PROFILER_ARGS, "--out", out], {
      cwd: ROOT,
      env,
      timeoutMs: 120_000,
    });
    expect(result.exitCode).toBe(0);
    const profile = parseProfile(JSON.parse(readFileSync(out, "utf8")));
    // The profiler opens the files the readers open: an archive whose live twin exists is
    // skipped, an archive-only rollout is not.
    const codexFiles = tree.files.filter((f) => f.source === "codex");
    const liveNames = new Set(
      codexFiles.filter((f) => !f.path.endsWith(".zst")).map((f) => f.path.split(/[\\/]/).pop()!),
    );
    const opened = codexFiles.filter((f) =>
      !f.path.endsWith(".zst") || !liveNames.has(f.path.split(/[\\/]/).pop()!.replace(/\.zst$/, ""))
    );
    expect(opened.length).toBe(codexFiles.length - 1);
    expect(profile.codex.fileBytes.count).toBe(opened.length);
    expect(profile.claude.fileBytes.count).toBe(
      tree.files.filter((f) => f.source === "claude").length,
    );
    expect(profile.codex.forkShare).toBeGreaterThan(0);
    expect(profile.claude.forkShare).toBeGreaterThan(0);
    expect(profile.codex.midnightCrossingShare).toBeGreaterThan(0);
    // One Claude usage sample per message id across the whole tree (a resume's copies and
    // a stream's repeats collapse onto one id), so the sample count is the distinct-id count.
    const ids = new Set<string>();
    for (const f of tree.files.filter((f) => f.source === "claude")) {
      for (const id of textOf(f.path).match(/"id":"msg_[0-9a-f]+"/g) ?? []) ids.add(id);
    }
    const sampled = Object.values(profile.claude.models).reduce((n, m) => n + m.output.count, 0);
    expect(sampled).toBe(ids.size);
    expect(Object.keys(profile.codex.filenameShapes).sort()).toEqual([
      "rollout-9999-99-99T99-99-99-UUID.jsonl",
      "rollout-9999-99-99T99-99-99-UUID.jsonl.zst",
    ]);
    expect(readFileSync(out, "latin1")).toMatch(/^[\t\n -~]*$/);
    // The synthetic user's zone is UTC, and the profiler cuts days in the host zone; a shared
    // scripted session still spans 26 hours, so it crosses midnight in every zone.

    // Negative control: a home with no logs at all yields nothing to sample from, and the
    // profiler refuses to write rather than emit an unusable profile.
    const emptyHome = freshRoot();
    const emptyOut = join(freshRoot(), "profile.json");
    const empty = runSync("deno", [...PROFILER_ARGS, "--out", emptyOut], {
      cwd: ROOT,
      env: {
        ...env,
        HOME: emptyHome,
        USERPROFILE: emptyHome,
        CODEX_HOME: join(emptyHome, ".codex"),
        CLAUDE_CONFIG_DIR: join(emptyHome, ".claude"),
        COPILOT_API_HOME: join(emptyHome, ".copilot-env"),
      },
      timeoutMs: 120_000,
    });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("refusing to write");
    expect(() => statSync(emptyOut)).toThrow();

    // Negative controls: an unreadable log file, then an unreadable session directory, each
    // make the profiler refuse to write anything. Root reads through any mode bits and
    // Windows has none, so these two run elsewhere.
    if (Deno.build.os === "windows" || Deno.uid() === 0) return;
    const victims = [
      tree.files.find((f) => f.source === "claude")!.path,
      join(tree.codexRoot, "archived_sessions"),
    ];
    for (const victim of victims) {
      const refusedOut = join(freshRoot(), "profile.json");
      const mode = statSync(victim).mode;
      try {
        Deno.chmodSync(victim, 0o000);
        const refused = runSync("deno", [...PROFILER_ARGS, "--out", refusedOut], {
          cwd: ROOT,
          env,
          timeoutMs: 120_000,
        });
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr).toContain("refusing to write");
        expect(() => statSync(refusedOut)).toThrow();
      } finally {
        Deno.chmodSync(victim, mode);
      }
    }
  },
  240_000,
);
