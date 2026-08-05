import { afterEach, expect, test } from "bun:test";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  DEFAULT_MAX_PROXY_PORT,
  DEFAULT_MIN_PROXY_PORT,
  matchesProxyOrigin,
  maxProxyPort,
  minProxyPort,
  openaiBaseUrl,
  parseLoopbackProxyUrl,
  proxyLoopbackOrigin,
  proxyPortInRange,
} from "../src/copilot_api/port.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function tmpHome(): void {
  dir = isolateProxyHome("copilot-port-");
}

test("the range defaults to [1024, 65535] and excludes privileged/out-of-range ports", () => {
  tmpHome();
  expect(minProxyPort()).toBe(DEFAULT_MIN_PROXY_PORT); // 1024
  expect(maxProxyPort()).toBe(DEFAULT_MAX_PROXY_PORT); // 65535
  expect(proxyPortInRange(443)).toBe(false); // privileged
  expect(proxyPortInRange(1023)).toBe(false);
  expect(proxyPortInRange(1024)).toBe(true);
  expect(proxyPortInRange(4141)).toBe(true);
  expect(proxyPortInRange(65535)).toBe(true);
  expect(proxyPortInRange(65536)).toBe(false);
  expect(proxyPortInRange(4141.5)).toBe(false); // non-integer
});

test("min-port / max-port config narrow the allowed range", () => {
  tmpHome();
  new CopilotEnvConfig().set({ minPort: 4000, maxPort: 5000 });
  expect(minProxyPort()).toBe(4000);
  expect(maxProxyPort()).toBe(5000);
  // 4141 (the built-in default) stays valid; ports outside the narrowed range do not.
  expect(proxyPortInRange(4141)).toBe(true);
  expect(proxyPortInRange(3999)).toBe(false);
  expect(proxyPortInRange(5001)).toBe(false);
  expect(proxyPortInRange(8080)).toBe(false);
});

test("an inverted range (min > max) admits no port", () => {
  tmpHome();
  new CopilotEnvConfig().set({ minPort: 5000, maxPort: 4000 });
  // proxyPortInRange is vacuously false for every port; resolveStartPort surfaces a clear
  // "min-port > max-port" error (exercised in the start flow, not here).
  for (const p of [3999, 4000, 4500, 5000, 5001]) {
    expect(proxyPortInRange(p)).toBe(false);
  }
});

test("parseLoopbackProxyUrl: the loopback-http grammar, host/protocol/garbage table", () => {
  const cases: [string, { port: string; path: string } | null][] = [
    // Both written shapes round-trip through the parser.
    [proxyLoopbackOrigin(4141), { port: "4141", path: "" }],
    [openaiBaseUrl("4141"), { port: "4141", path: "/v1" }],
    // A hand-edited localhost spelling still reads as the local proxy.
    ["http://localhost:4141", { port: "4141", path: "" }],
    // The URL parser lowercases scheme and host, so shouty hand-edits normalize too.
    ["HTTP://LOCALHOST:4141", { port: "4141", path: "" }],
    // Trailing slash tolerated (on the bare origin and on /v1).
    ["http://127.0.0.1:4141/", { port: "4141", path: "" }],
    ["http://localhost:4141/v1/", { port: "4141", path: "/v1" }],
    // Port-less and foreign-path URLs still parse (env.ts accepts them port-agnostically).
    ["http://127.0.0.1", { port: "", path: "" }],
    ["http://localhost:8080/other", { port: "8080", path: "/other" }],
    // Not the local proxy: https, non-loopback hosts, non-URLs.
    ["https://127.0.0.1:4141", null],
    ["https://api.githubcopilot.com", null],
    ["http://example.com:4141", null],
    ["http://[::1]:4141", null],
    ["not a url", null],
    ["", null],
  ];
  for (const [url, expected] of cases) {
    expect(parseLoopbackProxyUrl(url)).toEqual(expected);
  }
});

test("matchesProxyOrigin: layers the per-site expected port and path on the grammar", () => {
  const cases: [string, number, "" | "/v1", boolean][] = [
    // Claude's contract: bare origin, exact port; Codex's: /v1, exact port.
    [proxyLoopbackOrigin(4141), 4141, "", true],
    [openaiBaseUrl("4141"), 4141, "/v1", true],
    ["http://localhost:4141/", 4141, "", true], // localhost + trailing slash tolerated
    ["http://127.0.0.1:4141/v1/", 4141, "/v1", true],
    // Wrong port, wrong path, or a cross-contract mixup is NOT a match.
    ["http://127.0.0.1:5151", 4141, "", false],
    ["http://127.0.0.1:4141", 4141, "/v1", false],
    ["http://127.0.0.1:4141/v1", 4141, "", false],
    ["https://127.0.0.1:4141/v1", 4141, "/v1", false],
    ["not a url", 4141, "", false],
  ];
  for (const [url, port, path, expected] of cases) {
    expect(matchesProxyOrigin(url, port, path)).toBe(expected);
  }
});
