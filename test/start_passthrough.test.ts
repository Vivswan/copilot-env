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

test("usePatPassthrough: --passthrough/--no-passthrough force on/off regardless of token", () => {
  expect(usePatPassthrough({ force: true, token: "gho_oauth" })).toBe(true);
  expect(usePatPassthrough({ force: true, token: undefined })).toBe(true);
  expect(usePatPassthrough({ force: false, token: "ghp_pat" })).toBe(false);
});

test("usePatPassthrough: auto — on for a PAT-shaped token, off otherwise", () => {
  expect(usePatPassthrough({ force: undefined, token: "ghp_pat" })).toBe(true);
  expect(usePatPassthrough({ force: undefined, token: "github_pat_x" })).toBe(true);
  expect(usePatPassthrough({ force: undefined, token: "gho_oauth" })).toBe(false);
  expect(usePatPassthrough({ force: undefined, token: undefined })).toBe(false);
});
