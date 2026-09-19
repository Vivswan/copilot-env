import { configDefaultNumber } from "../src/copilot_api/config_registry.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  checkProxyPort,
  matchesProxyOrigin,
  openaiBaseUrl,
  parseLoopbackProxyUrl,
  proxyLoopbackOrigin,
  proxyPortRange,
} from "../src/copilot_api/port.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers/env.ts";

const restoreEnv = envSnapshot();

afterEach(() => {
  restoreEnv();
});

function tmpHome(): void {
  isolateProxyHome("copilot-port-");
}

// The allowed range is [min-port, max-port] from the config, [1024, 65535] by default: privileged,
// out-of-range, and non-integer ports read out of range before any socket is opened, and an
// inverted range is refused with the config commands that fix it.
test("the port range: config narrows the default [1024, 65535]; an inverted range is refused", async () => {
  tmpHome();
  const rows: {
    label: string;
    config: { "daemon.min-port": number; "daemon.max-port": number } | null;
    min: number;
    max: number;
    inRange: [number, boolean][];
  }[] = [
    {
      label: "the default range excludes privileged, out-of-range, and non-integer ports",
      config: null,
      min: configDefaultNumber("daemon.min-port"),
      max: configDefaultNumber("daemon.max-port"),
      inRange: [
        [443, false],
        [1023, false],
        [1024, true],
        [4141, true],
        [65535, true],
        [65536, false],
        [4141.5, false],
      ],
    },
    {
      // 4141 (the built-in default port) stays valid inside the narrowed range.
      label: "min-port / max-port config narrow the allowed range",
      config: { "daemon.min-port": 4000, "daemon.max-port": 5000 },
      min: 4000,
      max: 5000,
      inRange: [
        [4141, true],
        [3999, false],
        [5001, false],
        [8080, false],
      ],
    },
  ];
  for (const row of rows) {
    const config = new CopilotEnvConfig();
    if (row.config !== null) config.set(row.config);
    const inRange: [number, boolean][] = [];
    for (const [port] of row.inRange) {
      inRange.push([port, (await checkProxyPort(port, config)) !== "out-of-range"]);
    }
    expect({ label: row.label, range: proxyPortRange(config), inRange }).toEqual({
      label: row.label,
      range: { min: row.min, max: row.max },
      inRange: row.inRange,
    });
  }
  const inverted = new CopilotEnvConfig();
  inverted.set({ "daemon.min-port": 5000, "daemon.max-port": 4000 });
  await expect(checkProxyPort(4500, inverted)).rejects.toThrow(
    "invalid port range: daemon.min-port (5000) is greater than daemon.max-port (4000); " +
      "fix it with `agent config set daemon.min-port <n>` / `agent config set daemon.max-port <n>`.",
  );
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
    // The rest of the loopback block and ::1: the same rule the Copilot host validator applies.
    ["http://127.0.0.2:4141", { port: "4141", path: "" }],
    ["http://[::1]:4141", { port: "4141", path: "" }],
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
    // The port must match whole: 41410 once satisfied 4141 as a substring.
    ["http://localhost:41410/v1", 4141, "/v1", false],
    ["http://127.0.0.1:4141", 4141, "/v1", false],
    ["http://127.0.0.1:4141/v1", 4141, "", false],
    ["http://localhost:4141/not-v1", 4141, "/v1", false],
    ["https://127.0.0.1:4141/v1", 4141, "/v1", false],
    ["not a url", 4141, "", false],
  ];
  for (const [url, port, path, expected] of cases) {
    expect(matchesProxyOrigin(url, port, path)).toBe(expected);
  }
});
