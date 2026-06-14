import { expect, test } from "bun:test";

import { isPatToken, usePatPassthrough } from "../src/commands/start.ts";

// --- isPatToken --------------------------------------------------------------

test("isPatToken: ghp_/github_pat_ are PATs; gho_/ghu_/ghs_/empty are not", () => {
  expect(isPatToken("ghp_classic123")).toBe(true);
  expect(isPatToken("github_pat_finegrained123")).toBe(true);
  expect(isPatToken("  ghp_trimmed  ")).toBe(true); // trims before matching
  expect(isPatToken("gho_oauth123")).toBe(false);
  expect(isPatToken("ghu_user123")).toBe(false);
  expect(isPatToken("ghs_server123")).toBe(false);
  expect(isPatToken("")).toBe(false);
  // Legacy unprefixed classic PAT (40 hex) is intentionally NOT detected.
  expect(isPatToken("0123456789abcdef0123456789abcdef01234567")).toBe(false);
});

// --- usePatPassthrough -------------------------------------------------------

test("usePatPassthrough: an explicit force (config on/off) wins regardless of token/provider", () => {
  expect(usePatPassthrough({ force: true, token: "gho_oauth" })).toBe(true);
  expect(usePatPassthrough({ force: false, token: "ghp_pat" })).toBe(false);
  // force wins even over the gh-cli provider / gho_ auto-on.
  expect(usePatPassthrough({ force: false, token: "gho_x", provider: "gh-cli" })).toBe(false);
  // ...but with NO token resolved there is nothing to shim, so it's off even when forced on.
  expect(usePatPassthrough({ force: true, token: undefined })).toBe(false);
});

test("usePatPassthrough: auto — on for a PAT-shaped OR gho_ OAuth token, off otherwise", () => {
  expect(usePatPassthrough({ force: undefined, token: "ghp_pat" })).toBe(true);
  expect(usePatPassthrough({ force: undefined, token: "github_pat_x" })).toBe(true);
  // A gho_ GitHub-OAuth token can't do the exchange (404) but works directly -> passthrough.
  expect(usePatPassthrough({ force: undefined, token: "gho_oauth" })).toBe(true);
  // A non-PAT, non-gho_ token (e.g. ghu_ user-to-server) defaults to the exchange.
  expect(usePatPassthrough({ force: undefined, token: "ghu_user" })).toBe(false);
  expect(usePatPassthrough({ force: undefined, token: undefined })).toBe(false);
});

test("usePatPassthrough: provider scoping — gh-cli auto-on, copilot never, gh-token by token shape", () => {
  expect(usePatPassthrough({ force: undefined, token: "gho_oauth", provider: "gh-cli" })).toBe(
    true,
  );
  // The copilot device-flow token DOES the exchange (and rotates), so never shim it -- even though
  // it is gho_-shaped. The explicit copilot exclusion protects that rotating path.
  expect(usePatPassthrough({ force: undefined, token: "gho_oauth", provider: "copilot" })).toBe(
    false,
  );
  // gh-token holding a gho_ token (often a pasted gh-cli token) needs the passthrough too.
  expect(usePatPassthrough({ force: undefined, token: "gho_oauth", provider: "gh-token" })).toBe(
    true,
  );
  // gh-token holding a genuinely exchange-capable non-gho_/non-PAT token stays on the exchange.
  expect(usePatPassthrough({ force: undefined, token: "ghu_x", provider: "gh-token" })).toBe(false);
});
