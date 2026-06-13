import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The preload shim wraps the daemon's globalThis.fetch to fake copilot-api's editor
// token exchange for a PAT. It reads the token from `--github-token` in argv and only
// acts on the exchange URL, so it must be exercised as a real preloaded subprocess
// (`bun --preload`), which is how launchDaemon loads it.
const SHIM = join(import.meta.dir, "..", "src", "scripts", "pat_passthrough_preload.ts");

// A throwaway "exchange"/other URL on a refused port: if the shim intercepts, fetch
// returns a synthetic body WITHOUT touching the socket; if it doesn't, the real fetch
// fails fast (connection refused) and the target prints PASSTHROUGH.
const EXCHANGE_URL = "http://127.0.0.1:1/copilot_internal/v2/token";
const OTHER_URL = "http://127.0.0.1:1/other";

function runPreloaded(
  url: string,
  token: string | null,
  inputKind: "string" | "url" | "request" = "string",
): string {
  const dir = mkdtempSync(join(tmpdir(), "copilot-preload-"));
  try {
    const target = join(dir, "target.ts");
    // Exercise each fetch input shape the shim must handle: string | URL | Request.
    const input =
      inputKind === "url"
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
    const argv = ["bun", "--preload", SHIM, target];
    if (token !== null) argv.push("--github-token", token);
    const res = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return res.stdout.toString().trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the exchange URL is intercepted (synthetic token = the passed token, no network)", () => {
  expect(runPreloaded(EXCHANGE_URL, "ghp_secret123")).toBe("INTERCEPTED:ghp_secret123:21600");
});

test("the exchange is intercepted for URL and Request fetch inputs too", () => {
  expect(runPreloaded(EXCHANGE_URL, "ghp_secret123", "url")).toBe(
    "INTERCEPTED:ghp_secret123:21600",
  );
  expect(runPreloaded(EXCHANGE_URL, "ghp_secret123", "request")).toBe(
    "INTERCEPTED:ghp_secret123:21600",
  );
});

test("with no --github-token in argv, no wrap is installed (real fetch is used)", () => {
  expect(runPreloaded(EXCHANGE_URL, null)).toBe("PASSTHROUGH");
});

test("the wrap acts for ANY token shape (the load decision is start.ts's job, not the shim's)", () => {
  // A non-PAT token still gets intercepted when the shim is preloaded -- start.ts only
  // preloads it on purpose (auto for a PAT, or a forced --passthrough).
  expect(runPreloaded(EXCHANGE_URL, "gho_oauth123")).toBe("INTERCEPTED:gho_oauth123:21600");
});

test("non-exchange URLs are never intercepted", () => {
  expect(runPreloaded(OTHER_URL, "ghp_secret123")).toBe("PASSTHROUGH");
});
