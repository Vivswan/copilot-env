// Human-readable renderer for `agent health`. Side-effect-free except stdout
// (the orchestrator owns process.exitCode), mirroring the builder/printer split
// in src/usage/cost.ts. The `--json` path bypasses this entirely.
import { bold, gray, green, red, yellow } from "../utils/ansi.ts";
import { worstStatus } from "./aggregate.ts";
import type { CheckGroup, CheckResult, CheckStatus, HealthScope } from "./types.ts";

const GROUP_ORDER: CheckGroup[] = ["bootstrap", "gateway", "runtime", "setup", "codex", "claude"];
const GROUP_LABEL: Record<CheckGroup, string> = {
  bootstrap: "Bootstrap",
  gateway: "Gateway",
  runtime: "Runtime",
  setup: "Setup",
  codex: "Codex",
  claude: "Claude",
};

function glyph(status: CheckStatus): string {
  if (status === "ok") return green("✔");
  if (status === "warn") return yellow("!");
  return red("✘");
}

/** Print a grouped, human-readable diagnostic report to stdout. */
export function renderReport(scope: HealthScope, results: CheckResult[]): void {
  console.log(bold(`copilot-env health — scope: ${scope}`));
  for (const group of GROUP_ORDER) {
    const inGroup = results.filter((r) => r.group === group);
    if (inGroup.length === 0) continue;
    console.log(`\n${bold(GROUP_LABEL[group])}`);
    for (const r of inGroup) {
      const lines = r.detail.split("\n");
      if (lines.length <= 1) {
        // Single fact -> one row: `✔ label: value`.
        console.log(`  ${glyph(r.status)} ${r.label}: ${lines[0] ?? ""}`);
      } else {
        // Multiple facts -> a label row, then each fact as a `•` sub-item.
        console.log(`  ${glyph(r.status)} ${r.label}`);
        for (const line of lines) console.log(`      ${gray("•")} ${line}`);
      }
      if (r.fix && r.status !== "ok") console.log(`      ${gray(`→ fix: ${r.fix}`)}`);
    }
  }
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const r of results) counts[r.status]++;
  const summary = `${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail`;
  const overall = worstStatus(results);
  console.log(`\n${glyph(overall)} ${bold(summary)}`);
}
