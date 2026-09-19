import { join } from "node:path";
import { CHILD_VALUES, childValuesEnv, ROOT, runWithPreload } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The shim reads its token from argv and wraps globalThis.fetch, so it is exercised as a real
// `--preload` subprocess, the way launchDaemon loads it.
const SHIM = join(ROOT, "src", "scripts", "pat_passthrough_preload.ts");

// Port 1 is refused, so the outcome is decided without a server:
//   intercepted    -> synthetic body, socket untouched
//   passed through -> connection refused, the target prints PASSTHROUGH
const EXCHANGE_URL = "http://127.0.0.1:1/copilot_internal/v2/token";
const OTHER_URL = "http://127.0.0.1:1/other";

type InputKind = "string" | "url" | "request";

function runPreloaded(url: string, token: string | null, inputKind: InputKind): string {
  const input = inputKind === "url"
    ? `new URL(${CHILD_VALUES}.url)`
    : inputKind === "request"
    ? `new Request(${CHILD_VALUES}.url)`
    : `${CHILD_VALUES}.url`;
  // Only the fetch itself may fail into PASSTHROUGH; an intercepted body that does not parse
  // fails the child instead of reading as a pass-through.
  const source = [
    `const r = await fetch(${input}).catch(() => null);`,
    "if (r === null) {",
    "  console.log('PASSTHROUGH');",
    "} else {",
    "  const b = await r.json();",
    "  console.log('INTERCEPTED:' + b.token + ':' + b.refresh_in);",
    "}",
  ].join("\n");
  const res = runWithPreload(SHIM, source, {
    env: { ...process.env, ...childValuesEnv({ url }) },
    args: token === null ? [] : ["--github-token", token],
  });
  return res.stdout.trim();
}

// The exchange URL is intercepted for every fetch input shape and any token shape (the load
// decision lives in launch.ts and `usePatPassthrough`, not in the shim); without a token in argv
// no wrap is installed, and other URLs always reach the real fetch.
// Fake-token fixtures stay short and low-entropy so gitleaks' generic rules never match.
test("the exchange URL with a token in argv is intercepted; anything else passes through", () => {
  const rows: { url: string; token: string | null; input: InputKind; out: string }[] = [
    { url: EXCHANGE_URL, token: "ghp_test", input: "string", out: "INTERCEPTED:ghp_test:21600" },
    { url: EXCHANGE_URL, token: "ghp_test", input: "url", out: "INTERCEPTED:ghp_test:21600" },
    { url: EXCHANGE_URL, token: "ghp_test", input: "request", out: "INTERCEPTED:ghp_test:21600" },
    { url: EXCHANGE_URL, token: "gho_test", input: "string", out: "INTERCEPTED:gho_test:21600" },
    { url: EXCHANGE_URL, token: null, input: "string", out: "PASSTHROUGH" },
    { url: OTHER_URL, token: "ghp_test", input: "string", out: "PASSTHROUGH" },
  ];
  for (const { url, token, input, out } of rows) {
    expect({ url, token, input, out: runPreloaded(url, token, input) }).toEqual({
      url,
      token,
      input,
      out,
    });
  }
});
