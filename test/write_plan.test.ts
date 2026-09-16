// The plan half of a managed write: the rows a patch yields over a document, and the parity a
// writer owes them (what the apply saves is what the plan said, and a second plan over the result
// is all `same`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { applyPatch, type AttributeRow, planPatch, remove, set } from "../src/agents/write_plan.ts";
import { planClaudeConfig } from "../src/claude/config.ts";
import { planCodexConfig } from "../src/codex/config.ts";
import { isRecord } from "../src/utils/json.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, writeCodexConfigToml } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

const COMMAND = { kind: "command" } as const;

function leaf(doc: unknown, key: string): unknown {
  let cur: unknown = doc;
  for (const seg of key.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Every row's `next` is what the written document holds at that key, and its `current` is what
 *  the original held: the plan described exactly the write. */
function expectParity(rows: AttributeRow[], before: unknown, after: unknown): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect({ key: row.key, value: leaf(after, row.key) }).toEqual({
      key: row.key,
      value: row.next,
    });
    expect({ key: row.key, value: leaf(before, row.key) }).toEqual({
      key: row.key,
      value: row.current,
    });
  }
}

test("planPatch names only what the apply changes: a re-populated table is no removal, a scalar in a table's way is one", () => {
  // A table removed then re-set is no removal (an empty `auth` table would otherwise read as
  // `remove` while the apply keeps it); a TOML datetime where a table goes is replaced, not
  // patched in place.
  const current = { auth: {}, table: new Date("2025-01-01T00:00:00Z") };
  const rows = planPatch(current, [
    remove(["auth"]),
    set(["auth"], { command: "new" }),
    set(["table", "base_url"], "https://x"),
  ]);
  expect(rows.map((r) => [r.key, r.status])).toEqual([
    ["auth.command", "set"],
    ["table", "remove"],
    ["table.base_url", "set"],
  ]);
  const doc = applyPatch(structuredClone(current), [
    remove(["auth"]),
    set(["auth"], { command: "new" }),
    set(["table", "base_url"], "https://x"),
  ]);
  expect(doc).toEqual({ auth: { command: "new" }, table: { base_url: "https://x" } });
});

test("the Codex plan is what its apply writes, and a re-plan over the result is all same", () => {
  const homes = isolateAgentHomes("copilot-plan-codex-");
  dir = homes.dir;
  const configPath = writeCodexConfigToml(homes.codexHome, {
    baseUrl: "https://stale.example",
    envKey: "OPENAI_API_KEY",
  });
  const before = parse(readFileSync(configPath, "utf8"));

  const plan = planCodexConfig(homes.codexHome, { mode: "direct", credential: COMMAND });
  expect(plan.files.map((f) => [f.path, f.verdict])).toEqual([[configPath, "rewrite"]]);
  plan.apply();
  const after = parse(readFileSync(configPath, "utf8"));
  const rows = plan.files[0]?.attributes ?? [];
  expectParity(rows, before, after);
  // The stale proxy key is planned away and the Direct table planned in, by key.
  expect(rows.find((r) => r.key === "model_providers.copilot-env.env_key")?.status).toBe("remove");
  expect(rows.find((r) => r.key === "model_providers.copilot-env.base_url")?.status).toBe("change");

  const again = planCodexConfig(homes.codexHome, { mode: "direct", credential: COMMAND });
  expect(again.files[0]?.verdict).toBe("same");
  expect(new Set(again.files[0]?.attributes.map((r) => r.status))).toEqual(new Set(["same"]));
});

test("the Claude plan is what its apply writes, from a first write to a re-plan", () => {
  const homes = isolateAgentHomes("copilot-plan-claude-");
  dir = homes.dir;
  const settingsPath = join(homes.claudeHome, "settings.json");

  const plan = planClaudeConfig(homes.claudeHome, {
    mode: "direct",
    directIntegrationId: "copilot-developer-cli",
    directBaseUrl: "https://api.githubcopilot.com",
    credential: { kind: "static", token: "ghu_baked_value" },
  });
  const settings = plan.files.find((f) => f.path === settingsPath);
  expect(settings?.verdict).toBe("create");
  expect(new Set(settings?.attributes.map((r) => r.status))).toEqual(new Set(["set"]));
  plan.apply();
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  expectParity(settings?.attributes ?? [], null, after);
  // The baked value is marked for the renderer; the plan itself carries the literal.
  const token = settings?.attributes.find((r) => r.key === "env.ANTHROPIC_AUTH_TOKEN");
  expect(token).toMatchObject({ secret: true, next: "ghu_baked_value" });

  const again = planClaudeConfig(homes.claudeHome, { mode: "proxy", credential: COMMAND });
  const changed = again.files.find((f) => f.path === settingsPath);
  expect(changed?.verdict).toBe("rewrite");
  // A mode switch shows both sides of every changed key and removes the other shape's carrier.
  expect(changed?.attributes.find((r) => r.key === "env.ANTHROPIC_BASE_URL")).toMatchObject({
    status: "change",
    current: "https://api.githubcopilot.com",
  });
  expect(changed?.attributes.find((r) => r.key === "env.ANTHROPIC_AUTH_TOKEN")?.status).toBe(
    "remove",
  );
  expect(changed?.attributes.find((r) => r.key === "apiKeyHelper")?.status).toBe("set");
});
