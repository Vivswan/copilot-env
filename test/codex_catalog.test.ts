import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CopilotModelLimits,
  generateCodexModelCatalog,
  isCatalogFileUsable,
  parseCopilotLimits,
  patchModelCatalog,
  refreshCodexModelCatalogIfStale,
} from "../src/codex/catalog.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";

const SAVED_COPILOT_API_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  if (SAVED_COPILOT_API_HOME === undefined) {
    delete process.env.COPILOT_API_HOME;
  } else {
    process.env.COPILOT_API_HOME = SAVED_COPILOT_API_HOME;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function isolate(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-catalog-"));
  process.env.COPILOT_API_HOME = dir;
  // The catalog is opt-in (default false); these tests exercise the enabled
  // machinery, so flip it on in the isolated home. The disabled-gate tests
  // below undo this per-test.
  new CopilotEnvConfig().set({ codexModelCatalog: true });
}

function limitsOf(entries: [string, CopilotModelLimits][]): Map<string, CopilotModelLimits> {
  return new Map(entries);
}

// The worked example from the live catalogs: Codex bundles gpt-5.5 at 272k/95%
// while Copilot serves a 1.05M window with a 922k prompt cap.
const GPT55_LIMITS: CopilotModelLimits = {
  maxContextWindowTokens: 1_050_000,
  maxPromptTokens: 922_000,
};

// --- parseCopilotLimits ------------------------------------------------------

test("parseCopilotLimits reads capabilities.limits, skipping incomplete entries", () => {
  const limits = parseCopilotLimits({
    data: [
      {
        id: "gpt-5.5",
        capabilities: {
          limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 922_000 },
        },
      },
      // Missing prompt cap: skipped (both numbers are required for the patch).
      { id: "gpt-5.4-mini", capabilities: { limits: { max_context_window_tokens: 400_000 } } },
      // Ill-typed / degenerate values: skipped.
      {
        id: "bad-types",
        capabilities: { limits: { max_context_window_tokens: "1m", max_prompt_tokens: 1 } },
      },
      {
        id: "zero",
        capabilities: { limits: { max_context_window_tokens: 0, max_prompt_tokens: 0 } },
      },
      { id: "no-capabilities" },
      "not-a-record",
    ],
  });
  expect([...limits.keys()]).toEqual(["gpt-5.5"]);
  expect(limits.get("gpt-5.5")).toEqual(GPT55_LIMITS);
});

test("parseCopilotLimits strips the [1m] suffix and keeps the larger window on duplicates", () => {
  const limits = parseCopilotLimits({
    data: [
      {
        id: "claude-x",
        capabilities: {
          limits: { max_context_window_tokens: 200_000, max_prompt_tokens: 180_000 },
        },
      },
      {
        id: "claude-x[1m]",
        capabilities: {
          limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 900_000 },
        },
      },
    ],
  });
  expect(limits.get("claude-x")).toEqual({
    maxContextWindowTokens: 1_000_000,
    maxPromptTokens: 900_000,
  });
});

test("parseCopilotLimits returns empty on a shapeless body", () => {
  expect(parseCopilotLimits(null).size).toBe(0);
  expect(parseCopilotLimits({ data: "nope" }).size).toBe(0);
  expect(parseCopilotLimits({}).size).toBe(0);
});

// --- patchModelCatalog -------------------------------------------------------

test("patchModelCatalog patches matching slugs and preserves everything else verbatim", () => {
  const bundled = JSON.stringify({
    schema_version: 3,
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        context_window: 272_000,
        max_context_window: 272_000,
        effective_context_window_percent: 95,
        nested: { keep: ["me", 1] },
      },
      { slug: "gpt-5.2", context_window: 272_000, effective_context_window_percent: 95 },
      { no_slug: true },
    ],
  });
  const doc = patchModelCatalog(bundled, limitsOf([["gpt-5.5", GPT55_LIMITS]]));
  expect(doc).not.toBeNull();
  const models = (doc as { models: Record<string, unknown>[] }).models;

  // Patched: Copilot's window, and the percent floored to the prompt cap
  // (922000 / 1050000 => 87; the bundled 95% would 413 upstream before compact).
  expect(models[0]?.context_window).toBe(1_050_000);
  expect(models[0]?.max_context_window).toBe(1_050_000);
  expect(models[0]?.effective_context_window_percent).toBe(87);
  // Untouched fields survive verbatim.
  expect(models[0]?.display_name).toBe("GPT-5.5");
  expect(models[0]?.nested).toEqual({ keep: ["me", 1] });
  // A non-matching sibling and a slug-less entry are untouched.
  expect(models[1]).toEqual({
    slug: "gpt-5.2",
    context_window: 272_000,
    effective_context_window_percent: 95,
  });
  expect(models[2]).toEqual({ no_slug: true });
  // Top-level extras survive.
  expect((doc as Record<string, unknown>).schema_version).toBe(3);
});

test("patchModelCatalog returns null on bad input (never a catalog Codex would reject)", () => {
  const limits = limitsOf([["gpt-5.5", GPT55_LIMITS]]);
  expect(patchModelCatalog("{ not json", limits)).toBeNull();
  expect(patchModelCatalog(JSON.stringify({ models: [] }), limits)).toBeNull();
  expect(patchModelCatalog(JSON.stringify({ nope: true }), limits)).toBeNull();
  expect(patchModelCatalog(JSON.stringify([1, 2]), limits)).toBeNull();
});

// --- generateCodexModelCatalog -----------------------------------------------

const BUNDLED = JSON.stringify({
  models: [{ slug: "gpt-5.5", context_window: 272_000, effective_context_window_percent: 95 }],
});

test("generateCodexModelCatalog writes the patched catalog file", async () => {
  isolate();
  const ok = await generateCodexModelCatalog("direct", {
    bundledCatalog: () => BUNDLED,
    fetchLimits: async () => limitsOf([["gpt-5.5", GPT55_LIMITS]]),
  });
  expect(ok).toBe(true);
  const written = JSON.parse(readFileSync(new CopilotApiPaths().codexModelCatalogFile, "utf8"));
  expect(written.models[0].context_window).toBe(1_050_000);
  expect(written.models[0].effective_context_window_percent).toBe(87);
});

test("generateCodexModelCatalog fetches limits FIRST (cheap fail skips the codex spawn)", async () => {
  isolate();
  let bundledCalled = false;
  const ok = await generateCodexModelCatalog("direct", {
    bundledCatalog: () => {
      bundledCalled = true;
      return BUNDLED;
    },
    fetchLimits: async () => null,
  });
  expect(ok).toBe(false);
  expect(bundledCalled).toBe(false);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(false);
});

test("a failed regeneration never touches an existing (stale but valid) catalog", async () => {
  isolate();
  const limits = limitsOf([["gpt-5.5", GPT55_LIMITS]]);
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchLimits: async () => limits,
    }),
  ).toBe(true);
  const before = readFileSync(new CopilotApiPaths().codexModelCatalogFile, "utf8");

  // Bundled dump fails; a throwing fetch is also swallowed.
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => null,
      fetchLimits: async () => limits,
    }),
  ).toBe(false);
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchLimits: async () => {
        throw new Error("boom");
      },
    }),
  ).toBe(false);
  expect(readFileSync(new CopilotApiPaths().codexModelCatalogFile, "utf8")).toBe(before);
});

// --- refreshCodexModelCatalogIfStale -----------------------------------------

test("refresh is attempt-throttled: a fresh timestamp skips deps entirely", async () => {
  isolate();
  const now = 1_700_000_000_000;
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: now - 1000 });
  let called = false;
  await refreshCodexModelCatalogIfStale("direct", {
    nowMs: () => now,
    codexVersion: () => null,
    fetchLimits: async () => {
      called = true;
      return null;
    },
  });
  expect(called).toBe(false);
});

test("refresh records the ATTEMPT timestamp even when generation fails", async () => {
  isolate();
  const now = 1_700_000_000_000;
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: now - MILLISECONDS_PER_DAY - 1 });
  const regenerated = await refreshCodexModelCatalogIfStale("proxy", {
    nowMs: () => now,
    codexVersion: () => null,
    bundledCatalog: () => null,
    fetchLimits: async () => limitsOf([["gpt-5.5", GPT55_LIMITS]]),
  });
  expect(regenerated).toBe(false);
  // Attempt recorded BEFORE the (failed) generation: no retry storm on the
  // 300s Codex auth refresh cadence.
  expect(new CopilotEnvState().read().codexCatalogLastAttemptMs).toBe(now);
});

test("refresh regenerates when due and reports it", async () => {
  isolate();
  const now = 1_700_000_000_000;
  const regenerated = await refreshCodexModelCatalogIfStale("direct", {
    nowMs: () => now, // lastAttemptMs defaults to 0 => due
    bundledCatalog: () => BUNDLED,
    fetchLimits: async () => limitsOf([["gpt-5.5", GPT55_LIMITS]]),
  });
  expect(regenerated).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogLastAttemptMs).toBe(now);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(true);
});

// --- isCatalogFileUsable -------------------------------------------------------

test("isCatalogFileUsable requires an existing, parseable, non-empty catalog", async () => {
  isolate();
  const file = new CopilotApiPaths().codexModelCatalogFile;
  expect(isCatalogFileUsable(file)).toBe(false); // absent

  await generateCodexModelCatalog("direct", {
    bundledCatalog: () => BUNDLED,
    fetchLimits: async () => limitsOf([["gpt-5.5", GPT55_LIMITS]]),
  });
  expect(isCatalogFileUsable(file)).toBe(true);

  writeFileSync(file, "{ corrupt");
  expect(isCatalogFileUsable(file)).toBe(false);
  writeFileSync(file, '{"models":[]}');
  expect(isCatalogFileUsable(file)).toBe(false);
});

test("a codex version change bypasses the daily throttle (new bundled catalog within one cycle)", async () => {
  isolate();
  const now = 1_700_000_000_000;
  // A refresh just ran (fresh timestamp) against codex 0.144.0.
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: now - 1000,
    codexCatalogCodexVersion: "0.144.0",
  });

  // Same version + fresh timestamp: throttled.
  let called = false;
  const deps = {
    nowMs: () => now,
    bundledCatalog: () => BUNDLED,
    fetchLimits: async () => {
      called = true;
      return limitsOf([["gpt-5.5", GPT55_LIMITS]]);
    },
  };
  expect(
    await refreshCodexModelCatalogIfStale("direct", { ...deps, codexVersion: () => "0.144.0" }),
  ).toBe(false);
  expect(called).toBe(false);

  // Upgraded codex: the file REPLACES the bundled catalog, so the new binary's
  // models would stay hidden behind the throttle -- a version change regenerates now.
  expect(
    await refreshCodexModelCatalogIfStale("direct", { ...deps, codexVersion: () => "0.145.0" }),
  ).toBe(true);
  expect(called).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogCodexVersion).toBe("0.145.0");

  // An unresolvable version (codex missing) is NOT a change -- still throttled.
  called = false;
  expect(
    await refreshCodexModelCatalogIfStale("direct", { ...deps, codexVersion: () => null }),
  ).toBe(false);
  expect(called).toBe(false);
});

test("a failed post-upgrade regeneration does not retry on the next same-version call", async () => {
  isolate();
  const now = 1_700_000_000_000;
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: now - 1000,
    codexCatalogCodexVersion: "0.144.0",
  });

  // Upgrade detected, but generation fails: the attempt AND new version are
  // recorded up front, so the failure is not retried on every 300s auth cycle.
  let calls = 0;
  const deps = {
    nowMs: () => now,
    codexVersion: () => "0.145.0",
    bundledCatalog: () => null,
    fetchLimits: async () => {
      calls++;
      return limitsOf([["gpt-5.5", GPT55_LIMITS]]);
    },
  };
  expect(await refreshCodexModelCatalogIfStale("direct", deps)).toBe(false);
  expect(calls).toBe(1);
  expect(new CopilotEnvState().read().codexCatalogCodexVersion).toBe("0.145.0");

  expect(await refreshCodexModelCatalogIfStale("direct", deps)).toBe(false);
  expect(calls).toBe(1); // throttled: same version, fresh attempt timestamp
});

// --- the opt-in gate ----------------------------------------------------------

test("generate is a no-op when the catalog is not opted in", async () => {
  isolate();
  new CopilotEnvConfig().del("codexModelCatalog");
  const ok = await generateCodexModelCatalog("direct", {
    bundledCatalog: () => {
      throw new Error("must not be called");
    },
    fetchLimits: async () => {
      throw new Error("must not be called");
    },
  });
  expect(ok).toBe(false);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(false);
});

test("refresh is a no-op when disabled: no throttle state write", async () => {
  isolate();
  new CopilotEnvConfig().set({ codexModelCatalog: false });
  const ok = await refreshCodexModelCatalogIfStale("direct", {
    nowMs: () => 1_000_000,
    codexVersion: () => "1.0.0",
    bundledCatalog: () => {
      throw new Error("must not be called");
    },
    fetchLimits: async () => {
      throw new Error("must not be called");
    },
  });
  expect(ok).toBe(false);
  // The gate sits BEFORE the attempt recording: a disabled install must never
  // re-create the throttle fields the cleanup deleted.
  const state = new CopilotEnvState().read();
  expect(state.codexCatalogLastAttemptMs).toBe(0);
  expect(state.codexCatalogCodexVersion).toBeNull();
});
