import { expect, test } from "bun:test";

import {
  COPILOT_API_OAUTH_APP_ENV,
  isPatToken,
  passthroughOauthApp,
} from "../src/commands/start.ts";

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

// --- passthroughOauthApp -----------------------------------------------------

const NO_ENV = {} as NodeJS.ProcessEnv;
const ENV_SET = { [COPILOT_API_OAUTH_APP_ENV]: "opencode" } as NodeJS.ProcessEnv;

test("passthroughOauthApp: --passthrough forces opencode regardless of token/env", () => {
  expect(passthroughOauthApp({ force: true, token: "gho_x", env: NO_ENV })).toBe("opencode");
  expect(passthroughOauthApp({ force: true, token: undefined, env: ENV_SET })).toBe("opencode");
});

test("passthroughOauthApp: --no-passthrough forces the editor exchange (empty string)", () => {
  // "" is distinct from null: it is passed as `--oauth-app ""` to override an
  // inherited COPILOT_API_OAUTH_APP, forcing the standard exchange even for a PAT.
  expect(passthroughOauthApp({ force: false, token: "ghp_pat", env: ENV_SET })).toBe("");
});

test("passthroughOauthApp: auto — env set is honored (inherit), so pass nothing", () => {
  expect(passthroughOauthApp({ force: undefined, token: "ghp_pat", env: ENV_SET })).toBeNull();
});

test("passthroughOauthApp: auto — PAT enables passthrough, other tokens do not", () => {
  expect(passthroughOauthApp({ force: undefined, token: "ghp_pat", env: NO_ENV })).toBe("opencode");
  expect(passthroughOauthApp({ force: undefined, token: "github_pat_x", env: NO_ENV })).toBe(
    "opencode",
  );
  expect(passthroughOauthApp({ force: undefined, token: "gho_oauth", env: NO_ENV })).toBeNull();
  expect(passthroughOauthApp({ force: undefined, token: undefined, env: NO_ENV })).toBeNull();
});
