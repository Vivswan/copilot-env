import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatTokens, renderModelTable } from "../src/commands/models.ts";
import { type ModelListEntry, parseModelList } from "../src/copilot_api/models.ts";
import { runCli } from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// --- parseModelList (pure) ----------------------------------------------------

const MODEL_LIST_ROWS: (
  | { name: string; body: unknown; entries: ModelListEntry[] }
  | { name: string; body: unknown; throws: string }
)[] = [
  {
    name: "id/name/vendor/type/limits are extracted and the list is sorted by id",
    body: {
      data: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          vendor: "OpenAI",
          preview: false,
          capabilities: {
            type: "chat",
            limits: { max_context_window_tokens: 128000, max_output_tokens: 16384 },
          },
        },
        {
          id: "claude-opus-4.8",
          name: "Claude Opus 4.8",
          vendor: "Anthropic",
          preview: true,
          capabilities: {
            type: "chat",
            limits: { max_context_window_tokens: 200000, max_output_tokens: 32000 },
          },
        },
      ],
    },
    entries: [
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        vendor: "Anthropic",
        type: "chat",
        contextWindow: 200000,
        maxOutput: 32000,
        preview: true,
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        vendor: "OpenAI",
        type: "chat",
        contextWindow: 128000,
        maxOutput: 16384,
        preview: false,
      },
    ],
  },
  {
    name: "ids stay verbatim ([1m] suffix) and duplicates merge field-wise",
    body: {
      data: [
        {
          id: "claude-opus-4.8[1m]",
          capabilities: { limits: { max_context_window_tokens: 1048576 } },
        },
        { id: "claude-opus-4.8[1m]", name: "Claude Opus 4.8 (1M)", vendor: "Anthropic" },
      ],
    },
    entries: [
      {
        id: "claude-opus-4.8[1m]",
        name: "Claude Opus 4.8 (1M)",
        vendor: "Anthropic",
        type: null,
        contextWindow: 1048576,
        maxOutput: null,
        preview: false,
      },
    ],
  },
  {
    name: "preview merges any-true and an empty-string id is skipped",
    body: {
      data: [
        { id: "gpt-6-preview" },
        { id: "gpt-6-preview", preview: true },
        { id: "", name: "unaddressable" },
      ],
    },
    entries: [
      {
        id: "gpt-6-preview",
        name: null,
        vendor: null,
        type: null,
        contextWindow: null,
        maxOutput: null,
        preview: true,
      },
    ],
  },
  {
    name: "junk entries are tolerated",
    body: { data: [{ id: "gpt-5.5" }, "junk", 42, { name: "no id" }, { id: 7 }] },
    entries: [
      {
        id: "gpt-5.5",
        name: null,
        vendor: null,
        type: null,
        contextWindow: null,
        maxOutput: null,
        preview: false,
      },
    ],
  },
  { name: "an empty data array is an empty catalog", body: { data: [] }, entries: [] },
  // No data array is schema drift, not an empty catalog.
  { name: "a null body", body: null, throws: "unexpected /models response shape" },
  { name: "an empty object", body: {}, throws: "unexpected /models response shape" },
  {
    name: "a data field that is not an array",
    body: { data: "nope" },
    throws: "unexpected /models response shape",
  },
  { name: "a bare array", body: [], throws: "unexpected /models response shape" },
];

test("parseModelList: every /models body shape maps to its entries or the schema-drift error", () => {
  for (const row of MODEL_LIST_ROWS) {
    if ("throws" in row) {
      expect(() => parseModelList(row.body), row.name).toThrow(row.throws);
      continue;
    }
    expect({ name: row.name, entries: parseModelList(row.body) }).toEqual({
      name: row.name,
      entries: row.entries,
    });
  }
});

// --- formatting (pure) ---------------------------------------------------------

test("formatTokens humanizes limits", () => {
  expect(formatTokens(500)).toBe("500");
  expect(formatTokens(16384)).toBe("16k");
  expect(formatTokens(128000)).toBe("128k");
  expect(formatTokens(200000)).toBe("200k");
  // Values that would round to 1000k promote to the M tier instead.
  expect(formatTokens(999500)).toBe("1M");
  expect(formatTokens(1048576)).toBe("1M");
  expect(formatTokens(1500000)).toBe("1.5M");
});

test("renderModelTable groups by vendor, chat first, unknown vendor last", () => {
  const entry = (over: Partial<ModelListEntry>): ModelListEntry => ({
    id: "x",
    name: null,
    vendor: null,
    type: "chat",
    contextWindow: null,
    maxOutput: null,
    preview: false,
    ...over,
  });
  const table = renderModelTable([
    entry({ id: "mystery-model" }),
    entry({ id: "text-embedding-3-small", vendor: "OpenAI", type: "embeddings" }),
    entry({
      id: "gpt-5.5",
      name: "GPT-5.5",
      vendor: "OpenAI",
      contextWindow: 128000,
      preview: true,
    }),
    entry({ id: "claude-opus-4.8", vendor: "Anthropic", maxOutput: 32000 }),
  ], null);
  // Strip ANSI styling (the local run may have color enabled) so the
  // plain-text assertions hold everywhere. The escape byte is built with
  // fromCharCode: a literal control character in a regex is a lint error.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
  const lines = table.split("\n").map((l) => l.replace(ansi, ""));
  expect(lines[0]).toBe("   Anthropic");
  expect(lines[1]).toContain("claude-opus-4.8");
  expect(lines[1]).toContain("32k out");
  expect(lines[2]).toBe("   OpenAI");
  expect(lines[3]).toContain("gpt-5.5");
  expect(lines[3]).toContain("128k context, preview");
  expect(lines[4]).toContain("text-embedding-3-small");
  expect(lines[4]).toContain("embeddings");
  expect(lines[5]).toBe("   Other");
  expect(lines[6]).toContain("mystery-model");
});

// --- CLI wiring (offline: isolated home, no credential) -------------------------

// An empty COPILOT_API_HOME keeps every case offline: the proxy reads as down without a port
// probe, and Direct fails on the missing credential before any fetch.
/** `agent profile [<name>] models <args>` in a scratch data home. */
function runModelsCli(
  args: string[],
  seed?: (home: string) => void,
  profile?: string,
): { exitCode: number | null; out: string } {
  return runProfileVerb("models", seed, profile, args);
}

function runProfileVerb(
  verb: string,
  seed?: (home: string) => void,
  profile?: string,
  args: string[] = [],
): { exitCode: number | null; out: string } {
  const home = tempDir("copilot-models-");
  try {
    seed?.(home);
    const proc = runCli(
      ["profile", ...(profile === undefined ? [] : [profile]), verb, ...args],
      {
        env: { ...process.env, CONSOLA_LEVEL: "5", COPILOT_API_HOME: home },
      },
    );
    return { exitCode: proc.exitCode, out: proc.stdout + proc.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** profiles.<name> carries no credential, so `agent profile <name> models` must hard-fail. The root-level pair
 *  is the pre-3.5.6 legacy shape: CopilotEnvState reads the default slot only from profiles.default
 *  (src/copilot_api/env_state.ts), so no resolvable default credential exists here for a fallback
 *  regression to reach. */
function seedDirectProfile(home: string, name: string): void {
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      profiles: {
        default: {
          "githubToken": "gho_default-credential-must-never-be-used",
          "authProvider": "gh-token",
        },
        [name]: { "mode": "direct" },
      },
    }),
  );
}

test("models --proxy fails actionably when the proxy is down", () => {
  const { exitCode, out } = runModelsCli(["--proxy"]);
  expect(exitCode).toBe(1);
  expect(out).toContain("proxy is not running");
  expect(out).toContain("agent start");
});

test("models (auto) falls back to Direct and fails actionably with no credential", () => {
  const { exitCode, out } = runModelsCli([]);
  expect(exitCode).toBe(1);
  expect(out).toContain("GitHub Copilot Direct");
  expect(out).toContain("no GitHub credential");
  expect(out).toContain("agent auth");
});

// --- a named profile ---------------------------------------------------------------

test("profile models and profile health with an unknown name hard-fail naming the known profiles", () => {
  // Two verbs with their own profile lookups (health resolves the target itself); one refusal.
  for (const verb of ["models", "health"]) {
    const none = runProfileVerb(verb, undefined, "nope");
    expect(none.exitCode, verb).toBe(1);
    expect(none.out, verb).toContain("no such profile 'nope' (no profiles exist");

    const known = runProfileVerb(verb, (home) => seedDirectProfile(home, "p1"), "nope");
    expect(known.exitCode, verb).toBe(1);
    expect(known.out, verb).toContain("no such profile 'nope' (known profiles: p1)");
  }
});

test("profile models never falls back: a credential-less direct profile hard-fails", () => {
  const { exitCode, out } = runModelsCli(
    ["--direct"],
    (home) => seedDirectProfile(home, "p1"),
    "p1",
  );
  expect(exitCode).toBe(1);
  expect(out).toContain("no GitHub credential configured for profile 'p1'");
  expect(out).toContain("agent profile p1 auth");
  expect(out).toContain("never falls back");
});
