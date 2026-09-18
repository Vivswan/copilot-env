import { parseModeFlags } from "../src/agents/provider_mode.ts";
import { expect, test } from "./helpers/testing.ts";

// src/cli.ts parses --direct/--proxy once through parseModeFlags, so no internal arg shape can hold
// the contradictory pair. The end-to-end rejection is pinned in cli.smoke.test.ts.

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
