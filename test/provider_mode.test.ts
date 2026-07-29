import { expect, test } from "bun:test";
import { parseModeFlags } from "../src/utils/provider_mode.ts";

// The CLI boundary (src/cli.ts) parses --direct/--proxy ONCE into the
// RequestedMode union via parseModeFlags; the contradictory pair is rejected
// right there, so the internal arg shapes (InitArgs, ModelsArgs, ProfileArgs,
// CodexConfigArgs, ClaudeConfigArgs, CodexHostArgs) cannot represent it at all.
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
