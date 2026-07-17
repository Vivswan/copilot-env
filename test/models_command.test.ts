import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatTokens,
  type ModelListEntry,
  parseModelList,
  renderModelTable,
} from "../src/commands/models.ts";

// --- parseModelList (pure) ----------------------------------------------------

test("parseModelList extracts id/name/vendor/type/limits, sorted by id", () => {
  const body = {
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
  };
  expect(parseModelList(body)).toEqual([
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
  ]);
});

test("parseModelList keeps ids verbatim ([1m] suffix) and merges duplicates field-wise", () => {
  const body = {
    data: [
      {
        id: "claude-opus-4.8[1m]",
        capabilities: { limits: { max_context_window_tokens: 1048576 } },
      },
      { id: "claude-opus-4.8[1m]", name: "Claude Opus 4.8 (1M)", vendor: "Anthropic" },
    ],
  };
  const [entry] = parseModelList(body);
  // The later duplicate backfills the missing name/vendor; the first entry's
  // context window survives.
  expect(entry?.id).toBe("claude-opus-4.8[1m]");
  expect(entry?.name).toBe("Claude Opus 4.8 (1M)");
  expect(entry?.vendor).toBe("Anthropic");
  expect(entry?.contextWindow).toBe(1048576);
});

test("parseModelList merges preview any-true and skips empty-string ids", () => {
  const body = {
    data: [
      { id: "gpt-6-preview" },
      { id: "gpt-6-preview", preview: true },
      { id: "", name: "unaddressable" },
    ],
  };
  const models = parseModelList(body);
  expect(models).toHaveLength(1);
  expect(models[0]?.preview).toBe(true);
});

test("parseModelList tolerates junk entries but rejects a malformed envelope", () => {
  const body = {
    data: [{ id: "gpt-5.5" }, "junk", 42, { name: "no id" }, { id: 7 }],
  };
  expect(parseModelList(body)).toEqual([
    {
      id: "gpt-5.5",
      name: null,
      vendor: null,
      type: null,
      contextWindow: null,
      maxOutput: null,
      preview: false,
    },
  ]);
  expect(parseModelList({ data: [] })).toEqual([]);
  // No data array is schema drift, not an empty catalog.
  for (const malformed of [null, {}, { data: "nope" }, []]) {
    expect(() => parseModelList(malformed)).toThrow("unexpected /models response shape");
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
  ]);
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
  // Non-chat models trail their vendor's chat models and carry their type tag.
  expect(lines[4]).toContain("text-embedding-3-small");
  expect(lines[4]).toContain("embeddings");
  // Unknown vendor groups under "Other", after the named vendors.
  expect(lines[5]).toBe("   Other");
  expect(lines[6]).toContain("mystery-model");
});

// --- CLI wiring (offline: isolated home, no credential) -------------------------

// A throwaway COPILOT_API_HOME (no tracked pid, no credential): the proxy reads
// as down without probing any port, and the direct path fails on the missing
// credential BEFORE any network fetch.
function runModelsCli(args: string[]): { exitCode: number | null; out: string } {
  const home = mkdtempSync(join(tmpdir(), "copilot-models-"));
  try {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", "models", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CONSOLA_LEVEL: "5", COPILOT_API_HOME: home },
    });
    return { exitCode: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("models --help surfaces --proxy / --direct / --json", () => {
  const { exitCode, out } = runModelsCli(["--help"]);
  expect(exitCode).toBe(0);
  for (const flag of ["--proxy", "--direct", "--json"]) {
    expect(out).toContain(flag);
  }
});

test("models rejects --proxy + --direct", () => {
  const { exitCode, out } = runModelsCli(["--proxy", "--direct"]);
  expect(exitCode).toBe(1);
  expect(out).toContain("--direct and --proxy are mutually exclusive");
});

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
