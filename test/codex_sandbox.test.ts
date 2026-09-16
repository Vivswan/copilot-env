// A Codex sandbox without network blocks the proxy auth command (loopback is firewalled inside it),
// so both surfaces must name the setting and line that decide it. The rules pinned here were
// verified live on codex 0.153.4 and two contradict Codex's docs: `default_permissions` wins over
// any `sandbox_mode`, and the profile-v1 selector/table refuse the launch instead of selecting.
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

/** The default selection; `top` starts on line 2, so a setting's line number is known to the
 *  assertions. `legacyProfile` adds the `[profiles.work]` wiring configureCodexConfig still writes
 *  for a named profile (the shape Codex 0.153 refuses on `--profile work`). */
function configToml(
  wiring: Wiring,
  top: string[],
  opts: { providerHeaderComment?: string; legacyProfile?: boolean } = {},
): string {
  const header = `[model_providers.copilot-env]${
    opts.providerHeaderComment ? ` # ${opts.providerHeaderComment}` : ""
  }`;
  return [
    'model_provider = "copilot-env"',
    ...top,
    "",
    header,
    ...providerTable(wiring, null),
    "",
    ...(opts.legacyProfile
      ? [
        "[profiles.work]",
        'model_provider = "copilot-env-work"',
        "",
        "[model_providers.copilot-env-work]",
        ...providerTable("proxy", P),
        "",
      ]
      : []),
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

test("health: the sandbox that blocks proxy auth is named with its line; open or absent sandboxes are not", async () => {
  const readOnly = 'sandbox_mode = "read-only"';
  const workspace = 'sandbox_mode = "workspace-write"';
  const cases: {
    name: string;
    toml: string;
    expected: { status: string; cites?: string; at?: string; fix?: string }[];
  }[] = [
    {
      name: "legacy read-only warns",
      toml: configToml("proxy", [readOnly]),
      expected: [{ status: "warn", at: `${CONFIG}:2`, fix: "agent codex --direct" }],
    },
    {
      name: "legacy workspace-write is fine",
      toml: configToml("proxy", [workspace]),
      expected: [{ status: "ok" }],
    },
    { name: "nothing set is fine", toml: configToml("proxy", []), expected: [{ status: "ok" }] },
    {
      name: "direct + read-only: nothing to report",
      toml: configToml("direct", [readOnly]),
      expected: [],
    },
    {
      name: "a static bearer runs no auth command",
      toml: configToml("static-proxy", [readOnly]),
      expected: [],
    },
    {
      // smol-toml reports no positions, so the line is proved by rewriting its value; a look-alike
      // inside a multi-line string (line 3), a quoted key that merely spells the path (line 5),
      // and a comment on a table header (line 8) must not be cited over the assignment (line 6).
      name: "the cited line is the assignment itself, never a look-alike",
      toml: configToml("proxy", [
        'developer_instructions = """',
        workspace,
        '"""',
        '"profiles.work.sandbox_mode" = "workspace-write"',
        readOnly,
      ], { providerHeaderComment: readOnly }),
      expected: [{ status: "warn", at: `${CONFIG}:6` }],
    },
    // Permission profiles: network off unless the profile enables it, [sandbox_workspace_write]
    // does not apply, so :workspace blocks as much as :read-only.
    ...[":read-only", ":workspace"].map((builtin) => ({
      name: `default_permissions = "${builtin}" leaves the auth command offline`,
      toml: configToml("proxy", [`default_permissions = "${builtin}"`]),
      expected: [{
        status: "warn",
        cites: `default_permissions = "${builtin}"`,
        at: `${CONFIG}:2`,
        fix: `remove default_permissions from ${CONFIG} (it overrides sandbox_mode) or select`,
      }],
    })),
    {
      // Removing the profile key alone would expose the legacy read-only underneath.
      name: "a built-in profile over a legacy read-only names both steps of the fix",
      toml: configToml("proxy", [readOnly, 'default_permissions = ":workspace"']),
      expected: [{
        status: "warn",
        cites: 'default_permissions = ":workspace"',
        at: `${CONFIG}:3`,
        fix:
          `remove default_permissions from ${CONFIG} (it overrides sandbox_mode) and set sandbox_mode = "workspace-write" or select`,
      }],
    },
    {
      name: 'default_permissions = ":danger-full-access" lifts the sandbox',
      toml: configToml("proxy", ['default_permissions = ":danger-full-access"']),
      expected: [{ status: "ok" }],
    },
    {
      name: "a custom permission profile with network enabled reaches the proxy",
      toml: configToml("proxy", [
        'default_permissions = "net"',
        "[permissions.net]",
        "network = { enabled = true }",
      ]),
      expected: [{ status: "ok" }],
    },
    {
      name: "a custom permission profile without network names its own switch as the fix",
      toml: configToml("proxy", [
        'default_permissions = "net"',
        "[permissions.net]",
        "network = { enabled = false }",
      ]),
      expected: [{
        status: "warn",
        cites: 'default_permissions = "net"',
        at: `${CONFIG}:2`,
        fix: `set permissions.net.network.enabled = true in ${CONFIG}`,
      }],
    },
    {
      // `permissions.team.net.network` would address a nested pair, not the profile's table.
      name: "a custom profile name that is not a bare TOML key is quoted in the fix",
      toml: configToml("proxy", [
        'default_permissions = "team.net"',
        '[permissions."team.net".network]',
        "enabled = false",
      ]),
      expected: [{
        status: "warn",
        cites: 'default_permissions = "team.net"',
        at: `${CONFIG}:2`,
        fix: `set permissions."team.net".network.enabled = true in ${CONFIG}`,
      }],
    },
    // `extends` (single parent, chains allowed): the nearest network.enabled along the chain decides,
    // and a built-in parent has the network off.
    {
      name: "a custom profile inherits its parent's network switch",
      toml: configToml("proxy", [
        'default_permissions = "child"',
        "[permissions.base]",
        "network = { enabled = true }",
        "[permissions.child]",
        'extends = "base"',
      ]),
      expected: [{ status: "ok" }],
    },
    {
      name: "a child's own network switch overrides its parent's",
      toml: configToml("proxy", [
        'default_permissions = "child"',
        "[permissions.base]",
        "network = { enabled = true }",
        "[permissions.child]",
        'extends = "base"',
        "network = { enabled = false }",
      ]),
      expected: [{ status: "warn", cites: 'default_permissions = "child"', at: `${CONFIG}:2` }],
    },
    {
      name: "a chain ending in a built-in parent has the network off",
      toml: configToml("proxy", [
        'default_permissions = "child"',
        "[permissions.base]",
        'extends = ":workspace"',
        "[permissions.child]",
        'extends = "base"',
      ]),
      expected: [{ status: "warn", cites: 'default_permissions = "child"', at: `${CONFIG}:2` }],
    },
    {
      // The probe value must differ from the file's own value, or a comment look-alike (line 2)
      // probed first leaves the parse unchanged and gets cited over the assignment (line 3).
      name: "a value equal to the line probe's sentinel still cites the right line",
      toml: configToml("proxy", [
        '# default_permissions = "not-it"',
        'default_permissions = "copilot-env-line-probe"',
        "[permissions.copilot-env-line-probe]",
        "network = { enabled = false }",
      ]),
      expected: [{
        status: "warn",
        cites: 'default_permissions = "copilot-env-line-probe"',
        at: `${CONFIG}:3`,
      }],
    },
    // Precedence, the reverse of Codex's docs: `codex exec` under legacy workspace-write plus
    // `:read-only` banners "sandbox: read-only", and legacy read-only plus `:danger-full-access`
    // banners "sandbox: danger-full-access" (codex 0.153.4).
    {
      name: "default_permissions wins over a legacy workspace-write",
      toml: configToml("proxy", [workspace, 'default_permissions = ":read-only"']),
      expected: [{
        status: "warn",
        cites: 'default_permissions = ":read-only"',
        at: `${CONFIG}:3`,
      }],
    },
    {
      name: "default_permissions wins over a legacy read-only",
      toml: configToml("proxy", [readOnly, 'default_permissions = ":danger-full-access"']),
      expected: [{ status: "ok" }],
    },
  ];
  for (const c of cases) {
    const rows = await sandboxRows(c.toml);
    expect(rows.map((r) => ({ profile: r.profile, status: r.status })), c.name).toEqual(
      c.expected.map(({ status }) => ({ profile: null, status })),
    );
    for (const [i, e] of c.expected.entries()) {
      if (e.at) {
        expect(rows[i]?.detail, c.name).toContain(`${e.cites ?? readOnly} at ${e.at}`);
      }
      if (e.fix) expect(rows[i]?.fix, c.name).toContain(e.fix);
    }
  }
});

test("health: a launch Codex refuses to start gets no row, whatever the sandbox keys say", async () => {
  const readOnly = 'sandbox_mode = "read-only"';
  // codex 0.153.4: `profile = "<name>"` -> "legacy profile config is no longer supported";
  // `--profile work` with a `[profiles.work]` table -> "cannot be used while config.toml contains
  // legacy ... [profiles.work]"; a wrong-typed key or an unknown sandbox_mode anywhere -> the whole
  // file is refused ("invalid type: integer `1`, expected a string").
  const refusedForAll: [name: string, top: string[], legacyProfile: boolean][] = [
    ["a legacy profile selector", ['profile = "work"', readOnly], true],
    ["a wrong-typed profile selector", ["profile = 1", readOnly], false],
    ["a wrong-typed default_permissions", ["default_permissions = 1", readOnly], false],
    ["a wrong-typed sandbox_mode", ["sandbox_mode = 1"], false],
    ["an unknown sandbox_mode", ['sandbox_mode = "everything"'], false],
    ["a bad sandbox_mode in an unselected profile", [
      readOnly,
      "[profiles.other]",
      "sandbox_mode = 1",
    ], false],
    // Permission-profile chains Codex refuses: a missing profile or parent, a cycle, a
    // :danger-full-access parent.
    ["a selected custom profile with no table", ['default_permissions = "ghost"'], false],
    ["an unknown parent", [
      'default_permissions = "child"',
      "[permissions.child]",
      'extends = "ghost"',
    ], false],
    ["an inheritance cycle", [
      'default_permissions = "a"',
      "[permissions.a]",
      'extends = "b"',
      "[permissions.b]",
      'extends = "a"',
    ], false],
    ["a :danger-full-access parent", [
      'default_permissions = "child"',
      "[permissions.child]",
      'extends = ":danger-full-access"',
    ], false],
    // The chain is validated past the nearest switch, and only :read-only/:workspace are built-in
    // parents.
    ["an unknown parent behind the child's own network switch", [
      'default_permissions = "child"',
      "[permissions.child]",
      'extends = "ghost"',
      "network = { enabled = true }",
    ], false],
    ["a misspelled built-in parent", [
      'default_permissions = "child"',
      "[permissions.child]",
      'extends = ":nope"',
    ], false],
    ["a misspelled built-in as the selected profile", ['default_permissions = ":nope"'], false],
  ];
  for (const [name, top, legacyProfile] of refusedForAll) {
    expect(await sandboxRows(configToml("proxy", top, { legacyProfile })), name).toEqual([]);
  }
  // The `[profiles.work]` wiring configureCodexConfig still writes refuses only `--profile work`:
  // plain codex is judged, the named launch is not.
  const rows = await sandboxRows(configToml("proxy", [readOnly], { legacyProfile: true }));
  expect(rows.map((r) => [r.profile, r.status])).toEqual([[null, "warn"]]);
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
