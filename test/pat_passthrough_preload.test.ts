import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denoRunArgs, ROOT, runSync } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The preload shim wraps the daemon's globalThis.fetch to fake copilot-api's editor
// token exchange for a PAT. It reads the token from `--github-token` in argv and only
// acts on the exchange URL, so it must be exercised as a real preloaded subprocess
// (`--preload`), which is how launchDaemon loads it.
const SHIM = join(ROOT, "src", "scripts", "pat_passthrough_preload.ts");

// A throwaway "exchange"/other URL on a refused port: if the shim intercepts, fetch
// returns a synthetic body WITHOUT touching the socket; if it doesn't, the real fetch
// fails fast (connection refused) and the target prints PASSTHROUGH.
const EXCHANGE_URL = "http://127.0.0.1:1/copilot_internal/v2/token";
const OTHER_URL = "http://127.0.0.1:1/other";
const MODELS_URL = "https://api.githubcopilot.com/models";

function runPreloaded(
  url: string,
  token: string | null,
  inputKind: "string" | "url" | "request" = "string",
): string {
  const dir = mkdtempSync(join(tmpdir(), "copilot-preload-"));
  try {
    const target = join(dir, "target.ts");
    // Exercise each fetch input shape the shim must handle: string | URL | Request.
    const input = inputKind === "url"
      ? `new URL(${JSON.stringify(url)})`
      : inputKind === "request"
      ? `new Request(${JSON.stringify(url)})`
      : JSON.stringify(url);
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
    const res = runSync(Deno.execPath(), argv);
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
  // A non-PAT token still gets intercepted when the shim is preloaded -- launch.ts only
  // preloads it on purpose, per the precedence documented on `usePatPassthrough`
  // (integration_identity.ts).
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
  // init.headers present -> overridden.
  expect(
    headersWithIntegrationId(
      MODELS_URL,
      { headers: { "Copilot-Integration-Id": "vscode-chat" } },
      "copilot-developer-cli",
    ).get("Copilot-Integration-Id"),
  ).toBe("copilot-developer-cli");
  // Headers on the Request itself (no init) -> still overridden.
  expect(
    headersWithIntegrationId(
      new Request(MODELS_URL, { headers: { "Copilot-Integration-Id": "vscode-chat" } }),
      undefined,
      "copilot-developer-cli",
    ).get("Copilot-Integration-Id"),
  ).toBe("copilot-developer-cli");
  // No headers anywhere -> set fresh.
  expect(
    headersWithIntegrationId(MODELS_URL, undefined, "copilot-developer-cli").get(
      "Copilot-Integration-Id",
    ),
  ).toBe("copilot-developer-cli");
});
