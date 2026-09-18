// The configuration page's key tables are hand-written, so a new registry key needs its row
// added by hand and a changed default needs its Default cell moved; this is where either
// omission fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_REGISTRY,
  configDefaultValue,
  type ConfigValue,
  formatConfigValue,
} from "../src/copilot_api/env_config.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, test } from "./helpers/testing.ts";

/** Rows whose Default cell is prose instead of a value, with the reason. Allowed ONLY for a key
 *  with no built-in default: the registry has nothing to render there, and the page says what
 *  unset means. A key that gains a default leaves this list and gets the value in its cell. */
const PROSE_DEFAULT_CELLS: Readonly<Record<string, string>> = {
  "cost.credits-target": "unset paces against the plan's entitlement alone",
  "daemon.version": "unset floats the proxy to the latest release",
  "probe.claude-model": "unset runs the haiku alias, then the newest catalog model",
  "probe.codex-model": "unset prefers a reduced GPT tier, else the first codex-servable model",
  "proxy.claude-auto-model": "unset disables the security-monitor model override",
  "update.cooldown": "unset is no cooldown by hand and 7 days for update.auto",
};

interface DocsRow {
  key: string;
  /** The row's Default cell, or this key's share of a combined cell (`1024` / `65535`). */
  defaultCell: string;
}

function cells(line: string): string[] {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

/** Every row of every `| Key | ... | Default | ... |` table on the page. Only a row's FIRST cell
 *  names keys (a key echoed in a description cell is not a row); a combined first cell
 *  (`min-port` / `max-port`) is one row per key, with the Default cell split the same way. */
function configTableRows(page: string): DocsRow[] {
  const rows: DocsRow[] = [];
  const lines = page.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = cells(lines[i] ?? "");
    if (header[0] !== "Key") continue;
    const defaultColumn = header.indexOf("Default");
    expect(defaultColumn, `table at line ${i + 1} has no Default column`).toBeGreaterThan(0);
    for (let j = i + 2; j < lines.length && lines[j]?.startsWith("|"); j++) {
      const row = cells(lines[j] ?? "");
      const keyCell = row[0] ?? "";
      const defaultCell = row[defaultColumn] ?? "";
      const keys = [...keyCell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
      const defaults = keys.length > 1 ? defaultCell.split(" / ") : [defaultCell];
      expect(defaults.length, `row for ${keyCell} has ${defaults.length} default cells`)
        .toBe(keys.length);
      keys.forEach((key, n) => rows.push({ key, defaultCell: defaults[n] ?? "" }));
    }
  }
  return rows;
}

const page = readFileSync(join(PROJECT_ROOT, "docs", "configuration.md"), "utf8");
const docsRows = configTableRows(page);

test("the docs/configuration.md key rows are exactly the CONFIG_REGISTRY keys", () => {
  const rowKeys = docsRows.map((row) => row.key).sort();
  const registryKeys = CONFIG_REGISTRY.map((def) => def.key).sort();
  expect(rowKeys).toEqual(registryKeys);
});

test("every Default cell is the registry's default as `agent config` renders it", () => {
  const defaults = new Map<string, ConfigValue | undefined>(
    CONFIG_REGISTRY.map((def) => [def.key, configDefaultValue(def)]),
  );
  const unsetKeys = [...defaults].filter(([, value]) => value === undefined).map(([key]) => key);
  // Prose is allowed exactly where the registry has no value to render.
  expect(Object.keys(PROSE_DEFAULT_CELLS).sort()).toEqual(unsetKeys.sort());

  const drift: string[] = [];
  for (const { key, defaultCell } of docsRows) {
    const value = defaults.get(key);
    if (value === undefined) continue;
    // The cell is the rendered value in backticks, optionally followed by ONE parenthetical gloss
    // that names no value: `604800` (7 days). A second backticked value anywhere is drift.
    const expected = `\`${formatConfigValue(value)}\``;
    if (defaultCell.replace(/ \([^`()]*\)$/, "") !== expected) {
      drift.push(`${key}: docs cell ${defaultCell}, registry default ${expected}`);
    }
  }
  expect(drift).toEqual([]);
});
