// Human-readable renderer for `agent health`. Side-effect-free except stdout
// (the orchestrator owns process.exitCode), mirroring the builder/printer split
// in src/usage/cost.ts. The `--json` path bypasses this entirely.
import type { ProfileMode } from "../copilot_api/env_state.ts";
import { bold, gray, green, red, yellow } from "../utils/ansi.ts";
import { worstStatus } from "./aggregate.ts";
import type { CheckGroup, CheckResult, CheckStatus, HealthScope } from "./types.ts";

const GROUP_ORDER: CheckGroup[] = [
  "setup",
  "auth",
  "bootstrap",
  "codex",
  "claude",
  "proxy",
  "runtime",
];
const GROUP_LABEL: Record<CheckGroup, string> = {
  setup: "Setup",
  auth: "Authentication",
  bootstrap: "Bootstrap",
  codex: "Codex",
  claude: "Claude",
  proxy: "Proxy",
  runtime: "Runtime",
};

function glyph(status: CheckStatus): string {
  if (status === "ok") return green("✔");
  if (status === "warn") return yellow("!");
  return red("✘");
}

/**
 * Print a grouped, human-readable diagnostic report to stdout. `profileModes`
 * carries each named runtime target's recorded mode (from its store slot, null =
 * none recorded) so a profile's Runtime section header can say which kind of
 * daemon it describes.
 */
export function renderReport(
  scope: HealthScope,
  results: CheckResult[],
  profileModes: ReadonlyMap<string, ProfileMode | null> = new Map(),
): void {
  console.log(bold(`copilot-env health - scope: ${scope}`));
  for (const group of GROUP_ORDER) {
    const inGroup = results.filter((r) => r.group === group);
    // Sections are keyed on (group, profile): default-target (null) checks render
    // under the plain group label -- exactly the historical report -- and each
    // named profile's checks get their own headed section, in evaluation order.
    for (const profile of sectionProfiles(inGroup)) {
      const section = inGroup.filter((r) => r.profile === profile);
      let heading: string;
      if (profile === null) {
        heading = GROUP_LABEL[group];
      } else if (group === "runtime") {
        // The Runtime section names the daemon kind: `Runtime - profile 'p' (proxy)`.
        const mode = profileModes.get(profile) ?? null;
        heading = `${GROUP_LABEL[group]} - profile '${profile}' (${mode ?? "no mode"})`;
      } else {
        heading = `${GROUP_LABEL[group]} - profile '${profile}'`;
      }
      console.log(`\n${bold(heading)}`);
      for (const r of section) {
        const lines = r.detail.split("\n");
        if (lines.length <= 1) {
          // Single fact -> one row: `ok label: value`.
          console.log(`  ${glyph(r.status)} ${r.label}: ${lines[0] ?? ""}`);
        } else {
          // Multiple facts -> a label row, then each fact as a `-` sub-item.
          console.log(`  ${glyph(r.status)} ${r.label}`);
          for (const line of lines) console.log(`      ${gray("•")} ${line}`);
        }
        // The CheckOutcome union: every warn/fail carries a fix, ok never does.
        if (r.status !== "ok") console.log(`      ${gray(`→ fix: ${r.fix}`)}`);
      }
    }
  }
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const r of results) counts[r.status]++;
  const summary = `${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail`;
  const overall = worstStatus(results);
  console.log(`\n${glyph(overall)} ${bold(summary)}`);
}

/** The distinct profiles present in a group, in first-appearance (evaluation)
 *  order -- the default (null) target evaluates first, so it leads naturally. */
function sectionProfiles(results: CheckResult[]): CheckResult["profile"][] {
  const seen: CheckResult["profile"][] = [];
  for (const r of results) {
    if (!seen.includes(r.profile)) seen.push(r.profile);
  }
  return seen;
}
