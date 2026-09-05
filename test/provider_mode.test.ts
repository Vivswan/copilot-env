import { parseClaudeAction, parseCodexAction } from "../src/agents/configure.ts";
import { parseModeFlags } from "../src/agents/provider_mode.ts";
import { expect, test } from "./helpers/testing.ts";

// The CLI boundary (src/cli.ts) parses --direct/--proxy ONCE into the
// RequestedMode union via parseModeFlags; the contradictory pair is rejected
// right there, so the internal arg shapes (InitArgs, ModelsArgs, ProfileArgs,
// CodexConfigArgs, ClaudeConfigArgs) cannot represent it at all.
// The end-to-end `agent init --direct --proxy` rejection is pinned in
// cli.smoke.test.ts; this pins the parse itself.

test("parseModeFlags: --direct and --proxy are mutually exclusive", () => {
  expect(parseModeFlags({})).toBe("auto");
  expect(parseModeFlags({ direct: true })).toBe("direct");
  expect(parseModeFlags({ proxy: true })).toBe("proxy");
  expect(() => parseModeFlags({ direct: true, proxy: true })).toThrow(
    "--direct and --proxy are mutually exclusive",
  );
});

test("parseModeFlags: a command can keep its own rejection wording (profile)", () => {
  const message = "--direct and --proxy are mutually exclusive (a profile has ONE mode)";
  expect(() => parseModeFlags({ direct: true, proxy: true }, message)).toThrow(message);
  // The message override never changes the valid-input mapping.
  expect(parseModeFlags({ direct: true }, message)).toBe("direct");
});

// The `agent codex`/`agent claude` flag bags parse ONCE into per-command action
// unions (src/agents/configure.ts), so a combination the old if-chain resolved
// by routing order (`--check --direct` ran the check and dropped the mode,
// `--mobile --check` ran mobile) is a rejection instead.

test("parseCodexAction: each single-intent invocation maps to its own arm", () => {
  expect(parseCodexAction({ mode: "auto" })).toEqual({ kind: "configure", mode: "auto" });
  expect(parseCodexAction({ mode: "direct" })).toEqual({ kind: "configure", mode: "direct" });
  expect(parseCodexAction({ mode: "auto", check: true })).toEqual({ kind: "check" });
  expect(parseCodexAction({ mode: "auto", mobile: true })).toEqual({ kind: "mobile" });
});

test("parseCodexAction: --check combinations are rejections, not routing-order picks", () => {
  expect(() => parseCodexAction({ mode: "direct", check: true })).toThrow(
    "--check only reports the configured provider; it does not combine with --direct/--proxy",
  );
  expect(() => parseCodexAction({ mode: "proxy", check: true })).toThrow(
    "does not combine with --direct/--proxy",
  );
});

test("parseCodexAction: --mobile combines with nothing", () => {
  for (
    const flags of [
      { mode: "direct" as const, mobile: true },
      { mode: "proxy" as const, mobile: true },
      { mode: "auto" as const, mobile: true, check: true },
    ]
  ) {
    expect(() => parseCodexAction(flags)).toThrow(
      "--mobile is an interactive pairing flow; it does not combine with --check/--direct/--proxy",
    );
  }
});

test("parseClaudeAction: arms and rejections mirror codex minus the mobile flag", () => {
  expect(parseClaudeAction({ mode: "proxy" })).toEqual({ kind: "configure", mode: "proxy" });
  expect(parseClaudeAction({ mode: "auto", check: true })).toEqual({ kind: "check" });
  expect(() => parseClaudeAction({ mode: "proxy", check: true })).toThrow(
    "--check only reports the configured provider; it does not combine with --direct/--proxy",
  );
});
