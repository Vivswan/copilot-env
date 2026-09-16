// A read-only Codex sandbox blocks the proxy auth command (loopback is firewalled there, and
// Codex has no network switch for read-only), so both surfaces must name the offending line.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { providerModeExitCode } from "../src/agents/provider_mode.ts";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { configureCodexConfig, runCodex } from "../src/codex/config.ts";
import { DEFAULT_COPILOT_API_BASE } from "../src/copilot_api/integration_identity.ts";
import { parseProfileName, type Profile } from "../src/copilot_api/profile.ts";
import { evaluateAll } from "../src/health/checks.ts";
import { gatherFacts, type ProbeDeps } from "../src/health/probe.ts";
import type { CheckResult } from "../src/health/types.ts";
import type { TextReadResult } from "../src/utils/fs.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { proxyTokenCommand } from "../src/utils/root.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, resetExitCode } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
  dir = removeDir(dir);
});

const P = parseProfileName("work");
const HOME = "/hx";
const CONFIG = join(HOME, "config.toml");
const PROXY_URL = "http://127.0.0.1:4141/v1";
const PROFILE_PROXY_URL = "http://127.0.0.1:4242/v1";

/** A selection's provider table: the managed proxy command shape, a static bearer, or Direct. */
type Wiring = "proxy" | "static-proxy" | "direct";

function providerTable(wiring: Wiring, profile: Profile): string[] {
  if (wiring === "direct") return [`base_url = "${DEFAULT_COPILOT_API_BASE}"`];
  const lines = [`base_url = "${profile === null ? PROXY_URL : PROFILE_PROXY_URL}"`];
  if (wiring === "static-proxy") {
    return [...lines, 'http_headers = { Authorization = "Bearer sk-baked" }'];
  }
  const { command, args } = proxyTokenCommand(profile);
  const argList = args.map((a) => JSON.stringify(a)).join(", ");
  return [...lines, `auth = { command = ${JSON.stringify(command)}, args = [${argList}] }`];
}

/** The default selection plus the named profile `work`; `lines.top` starts on line 2 and
 *  `lines.profile` sits on line 6, so a sandbox_mode line's number is known to the assertions. */
function configToml(
  wiring: { default: Wiring; profile: Wiring },
  lines: { top?: string[]; profileHeaderComment?: string; profile?: string },
): string {
  return [
    'model_provider = "copilot-env"',
    ...(lines.top ?? []),
    "",
    `[profiles.work]${lines.profileHeaderComment ? ` # ${lines.profileHeaderComment}` : ""}`,
    'model_provider = "copilot-env-work"',
    ...(lines.profile ? [lines.profile] : []),
    "",
    "[model_providers.copilot-env]",
    ...providerTable(wiring.default, null),
    "",
    "[model_providers.copilot-env-work]",
    ...providerTable(wiring.profile, P),
    "",
  ].join("\n");
}

async function sandboxRows(toml: string): Promise<CheckResult[]> {
  // A named profile's candidate port is never derived: on an exhausted port range that derivation
  // throws, and a Direct profile needs no port at all. The classification is port-independent.
  const neverForNamed = (what: string) => (profile: Profile): never => {
    throw new Error(`${what} derived a candidate port for profile ${profile}`);
  };
  const deps: Partial<ProbeDeps> = {
    codexHome: () => HOME,
    readFileSafe: () => null,
    readFileResult: (): TextReadResult => ({ kind: "text", text: toml }),
    resolvePort: (profile) => profile === null ? "4141" : neverForNamed("resolvePort")(profile),
    fallbackPort: neverForNamed("fallbackPort"),
    profileNames: () => [P],
    codexTokenInEnviron: () => false,
    authProvider: () => null,
    storedTokenPresent: () => false,
    codexDirectAuth: () => Promise.resolve({ command: null, authenticated: false }),
    ghActiveLogin: () => Promise.resolve(null),
  };
  const facts = await gatherFacts("codex", {}, deps);
  return evaluateAll("codex", facts).filter((c) => c.id === "setup.codex-sandbox");
}

test("health: a read-only sandbox warns per proxy selection, naming the line; Direct has no row", async () => {
  const readOnly = 'sandbox_mode = "read-only"';
  const bothProxy = { default: "proxy", profile: "proxy" } as const;
  const cases: {
    name: string;
    toml: string;
    expected: {
      profile: string | null;
      status: string;
      cites?: string;
      at?: string;
      fix?: string;
    }[];
  }[] = [
    {
      name: "proxy + top-level read-only: both selections inherit it",
      toml: configToml(bothProxy, { top: [readOnly] }),
      expected: [
        { profile: null, status: "warn", at: `${CONFIG}:2`, fix: "agent codex --direct" },
        { profile: P, status: "warn", at: `${CONFIG}:2`, fix: "agent profile --add work --direct" },
      ],
    },
    {
      name: "proxy + workspace-write is fine",
      toml: configToml(bothProxy, { top: ['sandbox_mode = "workspace-write"'] }),
      expected: [{ profile: null, status: "ok" }, { profile: P, status: "ok" }],
    },
    {
      name: "direct + read-only: nothing to report",
      toml: configToml({ default: "direct", profile: "direct" }, { top: [readOnly] }),
      expected: [],
    },
    {
      name: "a static bearer runs no auth command, so only the command-shape profile has a row",
      toml: configToml({ default: "static-proxy", profile: "proxy" }, { top: [readOnly] }),
      expected: [{ profile: P, status: "warn", at: `${CONFIG}:2` }],
    },
    {
      name:
        "the profile table's read-only overrides a top-level workspace-write for that profile only",
      toml: configToml(bothProxy, { top: ['sandbox_mode = "workspace-write"'], profile: readOnly }),
      expected: [
        { profile: null, status: "ok" },
        { profile: P, status: "warn", at: `${CONFIG}:6 (in the profile table)` },
      ],
    },
    {
      // smol-toml reports no positions, so the line is proved by rewriting its value; a look-alike
      // inside a multi-line string (line 3), a quoted key that merely spells the path (line 5),
      // and a comment on the profile's table header (line 8) must not be cited over the real
      // assignments (line 6 for the default, line 10 for the profile).
      name: "the cited line is the assignment itself, never a look-alike",
      toml: configToml(bothProxy, {
        top: [
          'developer_instructions = """',
          'sandbox_mode = "workspace-write"',
          '"""',
          '"profiles.work.sandbox_mode" = "workspace-write"',
          readOnly,
        ],
        profileHeaderComment: readOnly,
        profile: readOnly,
      }),
      expected: [
        { profile: null, status: "warn", at: `${CONFIG}:6` },
        { profile: P, status: "warn", at: `${CONFIG}:10 (in the profile table)` },
      ],
    },
    {
      // Codex's rule: `profile` in config.toml is the default profile when --profile is absent, so
      // plain `codex` runs [profiles.work] and its read-only, and the fix must address that profile.
      name: "the config's profile key selects a read-only profile for plain codex",
      toml: configToml(bothProxy, {
        top: ['profile = "work"', 'sandbox_mode = "workspace-write"'],
        profile: readOnly,
      }),
      expected: [
        {
          profile: null,
          status: "warn",
          at: `${CONFIG}:7 (in the profile table)`,
          fix: "agent profile --add work --direct",
        },
        { profile: P, status: "warn", at: `${CONFIG}:7 (in the profile table)` },
      ],
    },
    {
      name: "the config's profile key selects a workspace-write profile over a read-only top level",
      toml: configToml(bothProxy, {
        top: ['profile = "work"', readOnly],
        profile: 'sandbox_mode = "workspace-write"',
      }),
      expected: [{ profile: null, status: "ok" }, { profile: P, status: "ok" }],
    },
    {
      name:
        "the config's profile key selects a Direct profile: no row despite a read-only top level",
      toml: configToml({ default: "proxy", profile: "direct" }, {
        top: ['profile = "work"', readOnly],
      }),
      expected: [],
    },
    {
      // Codex rejects the file at startup ("expected a string") for every launch, --profile
      // included (verified against codex 0.153.4), so nothing of ours runs and no selection is
      // judged in its place.
      name: "a non-string profile key is a config Codex rejects: no row for any launch",
      toml: configToml(bothProxy, { top: ["profile = 1", readOnly] }),
      expected: [],
    },
    // Permission profiles (default_permissions, Codex >= 0.138): their network is off unless the
    // profile enables it and [sandbox_workspace_write] does not apply, so the built-in :workspace
    // blocks as much as :read-only; only :danger-full-access or a custom profile with network on
    // reaches the proxy. Any sandbox_mode, in the selected profile or at the top level, wins over
    // the key (verified against openai/codex config_toml.rs and the permissions guide).
    ...[":read-only", ":workspace"].map((builtin) => ({
      name: `default_permissions = "${builtin}" leaves the auth command offline`,
      toml: configToml(bothProxy, { top: [`default_permissions = "${builtin}"`] }),
      expected: [
        {
          profile: null,
          status: "warn",
          cites: `default_permissions = "${builtin}"`,
          at: `${CONFIG}:2`,
          fix: 'set sandbox_mode = "workspace-write" in',
        },
        {
          profile: P,
          status: "warn",
          cites: `default_permissions = "${builtin}"`,
          at: `${CONFIG}:2`,
        },
      ],
    })),
    {
      name: 'default_permissions = ":danger-full-access" lifts the sandbox',
      toml: configToml(bothProxy, { top: ['default_permissions = ":danger-full-access"'] }),
      expected: [{ profile: null, status: "ok" }, { profile: P, status: "ok" }],
    },
    {
      name: "a custom permission profile with network enabled reaches the proxy",
      toml: configToml(bothProxy, {
        top: ['default_permissions = "net"', "[permissions.net]", "network = { enabled = true }"],
      }),
      expected: [{ profile: null, status: "ok" }, { profile: P, status: "ok" }],
    },
    {
      name: "a custom permission profile without network names its own switch as the fix",
      toml: configToml(bothProxy, {
        top: ['default_permissions = "net"', "[permissions.net]", "network = { enabled = false }"],
      }),
      expected: [
        {
          profile: null,
          status: "warn",
          cites: 'default_permissions = "net"',
          at: `${CONFIG}:2`,
          fix: `set permissions.net.network.enabled = true in ${CONFIG}`,
        },
        { profile: P, status: "warn", cites: 'default_permissions = "net"', at: `${CONFIG}:2` },
      ],
    },
    {
      // `permissions.team.net.network` would address a nested pair, not the profile's table.
      name: "a custom profile name that is not a bare TOML key is quoted in the fix",
      toml: configToml(bothProxy, {
        top: [
          'default_permissions = "team.net"',
          '[permissions."team.net".network]',
          "enabled = false",
        ],
      }),
      expected: [
        {
          profile: null,
          status: "warn",
          cites: 'default_permissions = "team.net"',
          at: `${CONFIG}:2`,
          fix: `set permissions."team.net".network.enabled = true in ${CONFIG}`,
        },
        {
          profile: P,
          status: "warn",
          cites: 'default_permissions = "team.net"',
          at: `${CONFIG}:2`,
        },
      ],
    },
    // Codex refuses the file on a wrong-typed key or an unknown sandbox_mode (verified against
    // codex 0.153.4), so no launch runs and no selection is judged in its place, whatever the
    // other keys say.
    ...[
      ["default_permissions = 1", 'sandbox_mode = "workspace-write"'],
      ["sandbox_mode = 1"],
      ['sandbox_mode = "everything"'],
      // An UNSELECTED profile's bad value refuses the file just the same.
      ['sandbox_mode = "workspace-write"', "[profiles.other]", "sandbox_mode = 1"],
    ].map((top) => ({
      name: `Codex refuses [${top.join("; ")}]: no row for any launch`,
      toml: configToml(bothProxy, { top }),
      expected: [],
    })),
    {
      name: "the selected profile's legacy sandbox_mode wins over default_permissions",
      toml: configToml(bothProxy, {
        top: ['default_permissions = ":read-only"'],
        profile: 'sandbox_mode = "workspace-write"',
      }),
      expected: [
        {
          profile: null,
          status: "warn",
          cites: 'default_permissions = ":read-only"',
          at: `${CONFIG}:2`,
        },
        { profile: P, status: "ok" },
      ],
    },
  ];
  for (const c of cases) {
    const rows = await sandboxRows(c.toml);
    expect(rows.map((r) => ({ profile: r.profile, status: r.status })), c.name).toEqual(
      c.expected.map(({ profile, status }) => ({ profile, status })),
    );
    for (const [i, e] of c.expected.entries()) {
      if (e.at) {
        expect(rows[i]?.detail, c.name).toContain(`${e.cites ?? readOnly} at ${e.at}`);
      }
      if (e.fix) expect(rows[i]?.fix, c.name).toContain(e.fix);
    }
  }
});

test("health: the config's profile key names the selected profile in the default row's detail", async () => {
  const [row] = await sandboxRows(
    configToml({ default: "proxy", profile: "proxy" }, {
      top: ['profile = "work"'],
      profile: 'sandbox_mode = "read-only"',
    }),
  );
  expect(row?.detail).toContain(
    'the config\'s profile = "work" key selects that profile for plain codex',
  );
  expect(row?.value).toMatchObject({ effectiveProfile: "work", selectedVia: "config-key" });
});

test("agent codex --check says where a read-only sandbox blocks proxy auth, and leaves the line alone", async () => {
  const homes = isolateAgentHomes("copilot-sandbox-", { mkdirs: true });
  dir = homes.dir;
  const configPath = join(homes.codexHome, "config.toml");
  const write = () =>
    configureCodexConfig(homes.codexHome, {
      mode: "proxy",
      baseUrl: PROXY_URL,
      credential: { kind: "command" },
      quiet: true,
    });
  write();
  const doc = parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, stringify({ ...doc, sandbox_mode: "read-only" }));
  const line = readFileSync(configPath, "utf8").split("\n")
    .findIndex((l) => l.startsWith("sandbox_mode")) + 1;
  expect(line).toBeGreaterThan(0);

  const said = await stderrOf(() => runCodex({ kind: "check" }, NOOP_CATALOG_DEPS));
  // The warning is advisory: the provider-mode exit code stays.
  expect(process.exitCode).toBe(providerModeExitCode("proxy"));
  expect(said).toContain(
    `sandbox_mode = "read-only" at ${configPath}:${line} blocks the proxy auth command`,
  );
  // The logger renders markdown, so the command's backticks are asserted apart from the text.
  expect(said).toContain(
    `set sandbox_mode = "workspace-write" in ${configPath}, or switch Codex to Direct with`,
  );
  expect(said).toContain("agent codex --direct");
  // A rewire never touches the user's setting.
  write();
  expect(parse(readFileSync(configPath, "utf8")).sandbox_mode).toBe("read-only");
});

/** Everything `fn` says on stderr, the logger's lines and the seam's held-back write reports. */
async function stderrOf(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const realWrite = process.stderr.write;
  const realLog = console.log;
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  console.log = () => {};
  deferWriteReports();
  try {
    await fn();
  } finally {
    process.stderr.write = realWrite;
    console.log = realLog;
    out += flushWriteReports().map((line) => `${line}\n`).join("");
  }
  return out;
}
