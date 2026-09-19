import type { AuthProvider } from "../src/copilot_api/env_state.ts";
import { isPatShapedToken, usePatPassthrough } from "../src/copilot_api/integration_identity.ts";
import { expect, test } from "./helpers/testing.ts";

// --- isPatShapedToken --------------------------------------------------------

test("isPatShapedToken: ghp_/github_pat_ are PATs; gho_/ghu_/ghs_/empty are not", () => {
  expect(isPatShapedToken("ghp_classic123")).toBe(true);
  expect(isPatShapedToken("github_pat_finegrained123")).toBe(true);
  expect(isPatShapedToken("  ghp_trimmed  ")).toBe(true); // trims before matching
  expect(isPatShapedToken("gho_oauth123")).toBe(false);
  expect(isPatShapedToken("ghu_user123")).toBe(false);
  expect(isPatShapedToken("ghs_server123")).toBe(false);
  expect(isPatShapedToken("")).toBe(false);
  // Legacy unprefixed classic PAT (40 hex) is intentionally NOT detected.
  expect(isPatShapedToken("0123456789abcdef0123456789abcdef01234567")).toBe(false);
});

// --- usePatPassthrough -------------------------------------------------------

test("usePatPassthrough: an explicit force wins; auto is on for a PAT-shaped or gho_ token and for the gh-cli provider, never for copilot", () => {
  const rows: {
    force: boolean | undefined;
    token: string;
    provider?: AuthProvider;
    on: boolean;
  }[] = [
    // An explicit force (config on/off) wins regardless of token or provider, even over the
    // gh-cli provider / gho_ auto-on.
    { force: true, token: "gho_oauth", on: true },
    { force: false, token: "ghp_pat", on: false },
    { force: false, token: "gho_x", provider: "gh-cli", on: false },
    // Auto: on for a PAT-shaped token.
    { force: undefined, token: "ghp_pat", on: true },
    { force: undefined, token: "github_pat_x", on: true },
    // A gho_ GitHub-OAuth token can't do the exchange (404) but works directly -> passthrough.
    { force: undefined, token: "gho_oauth", on: true },
    // A non-PAT, non-gho_ token (e.g. ghu_ user-to-server) defaults to the exchange.
    { force: undefined, token: "ghu_user", on: false },
    // Provider scoping: gh-cli auto-on.
    { force: undefined, token: "gho_oauth", provider: "gh-cli", on: true },
    // The copilot device-flow token is gho_-shaped but does the exchange and rotates, so it is
    // never shimmed.
    { force: undefined, token: "gho_oauth", provider: "copilot", on: false },
    // gh-token holding a gho_ token (often a pasted gh-cli token) needs the passthrough too;
    // otherwise gh-token follows the token shape.
    { force: undefined, token: "gho_oauth", provider: "gh-token", on: true },
    { force: undefined, token: "ghu_x", provider: "gh-token", on: false },
  ];
  for (const row of rows) {
    const { on: _on, ...input } = row;
    expect({ ...row, on: usePatPassthrough(input) }).toEqual(row);
  }
});
