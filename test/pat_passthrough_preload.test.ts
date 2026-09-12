import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHILD_VALUES, childValuesEnv, denoRunArgs, ROOT, runSync } from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// The shim reads its token from argv and wraps globalThis.fetch, so it is exercised as a real
// `--preload` subprocess, the way launchDaemon loads it.
const SHIM = join(ROOT, "src", "scripts", "pat_passthrough_preload.ts");

// Port 1 is refused, so the outcome is decided without a server:
//   intercepted    -> synthetic body, socket untouched
//   passed through -> connection refused, the target prints PASSTHROUGH
const EXCHANGE_URL = "http://127.0.0.1:1/copilot_internal/v2/token";
const OTHER_URL = "http://127.0.0.1:1/other";
const MODELS_URL = "https://api.githubcopilot.com/models";

function runPreloaded(
  url: string,
  token: string | null,
  inputKind: "string" | "url" | "request" = "string",
): string {
  const dir = tempDir("copilot-preload-");
  try {
    const target = join(dir, "target.ts");
    const input = inputKind === "url"
      ? `new URL(${CHILD_VALUES}.url)`
      : inputKind === "request"
      ? `new Request(${CHILD_VALUES}.url)`
      : `${CHILD_VALUES}.url`;
    writeFileSync(
      target,
      [
        "try {",
        `  const r = await fetch(${input});`,
        "  const b = await r.json();",
        "  console.log('INTERCEPTED:' + b.token + ':' + b.refresh_in);",
        "} catch {",
        "  console.log('PASSTHROUGH');",
        "}",
      ].join("\n"),
    );
    const argv = [...denoRunArgs("--preload", SHIM), target];
    if (token !== null) argv.push("--github-token", token);
    const res = runSync(Deno.execPath(), argv, {
      env: { ...process.env, ...childValuesEnv({ url }) },
    });
    return res.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fake-token fixtures stay short and low-entropy so gitleaks' generic rules never match.
test("the exchange URL is intercepted (synthetic token = the passed token, no network)", () => {
  expect(runPreloaded(EXCHANGE_URL, "ghp_test")).toBe("INTERCEPTED:ghp_test:21600");
});

test("the exchange is intercepted for URL and Request fetch inputs too", () => {
  expect(runPreloaded(EXCHANGE_URL, "ghp_test", "url")).toBe("INTERCEPTED:ghp_test:21600");
  expect(runPreloaded(EXCHANGE_URL, "ghp_test", "request")).toBe("INTERCEPTED:ghp_test:21600");
});

test("with no --github-token in argv, no wrap is installed (real fetch is used)", () => {
  expect(runPreloaded(EXCHANGE_URL, null)).toBe("PASSTHROUGH");
});

test("the wrap acts for ANY token shape (the load decision is the launch pipeline's job, not the shim's)", () => {
  // The load decision lives in launch.ts and `usePatPassthrough` (integration_identity.ts).
  expect(runPreloaded(EXCHANGE_URL, "gho_test")).toBe("INTERCEPTED:gho_test:21600");
});

test("non-exchange URLs are never intercepted", () => {
  expect(runPreloaded(OTHER_URL, "ghp_test")).toBe("PASSTHROUGH");
});

// --- integration-id rewrite (pure helpers) ----------------------------------
// Importing the preload without `--github-token` in argv is a no-op (the fetch wrap never
// installs), so its exported helpers can be unit-tested directly.
import {
  headersWithIntegrationId,
  isCopilotApiHost,
} from "../src/scripts/pat_passthrough_preload.ts";

test("isCopilotApiHost: only the Copilot inference hosts match", () => {
  expect(isCopilotApiHost("https://api.githubcopilot.com/models")).toBe(true);
  expect(isCopilotApiHost("https://api.enterprise.githubcopilot.com/v1/messages")).toBe(true);
  expect(isCopilotApiHost("https://api.business.githubcopilot.com/responses")).toBe(true);
  expect(isCopilotApiHost("https://api.github.com/copilot_internal/user")).toBe(false);
  expect(isCopilotApiHost("http://127.0.0.1:4141/models")).toBe(false);
  expect(isCopilotApiHost("not a url")).toBe(false);
});

test("headersWithIntegrationId: overrides the id across every fetch input shape", () => {
  expect(
    headersWithIntegrationId(
      MODELS_URL,
      { headers: { "Copilot-Integration-Id": "vscode-chat" } },
      "copilot-developer-cli",
    ).get("Copilot-Integration-Id"),
  ).toBe("copilot-developer-cli");
  expect(
    headersWithIntegrationId(
      new Request(MODELS_URL, { headers: { "Copilot-Integration-Id": "vscode-chat" } }),
      undefined,
      "copilot-developer-cli",
    ).get("Copilot-Integration-Id"),
  ).toBe("copilot-developer-cli");
  expect(
    headersWithIntegrationId(MODELS_URL, undefined, "copilot-developer-cli").get(
      "Copilot-Integration-Id",
    ),
  ).toBe("copilot-developer-cli");
});
