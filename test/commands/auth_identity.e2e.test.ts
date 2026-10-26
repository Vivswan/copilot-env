import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { directWiring } from "../../src/agents/configure.ts";
import { configureClaudeConfig } from "../../src/claude/config.ts";
import { runAuth } from "../../src/commands/auth.ts";
import { type IdentityTableInput, identityTableLines } from "../../src/commands/identity.ts";
import { runPrintProxyToken } from "../../src/commands/proxy_token.ts";
import { CODEX_IDENTITY_NAME } from "../../src/copilot_api/config_registry.ts";
import { CopilotEnvConfig } from "../../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../../src/copilot_api/env_state.ts";
import { setGithubLoginFetch } from "../../src/copilot_api/github_login.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
  type ProbeFetch,
  setIntegrationProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../../src/copilot_api/integration_identity.ts";
import { CopilotApiPaths } from "../../src/copilot_api/paths.ts";
import { withColumns } from "../helpers/columns.ts";
import { envSnapshot, isolateAgentHomes, resetExitCode } from "../helpers/env.ts";
import { stubGithubLogins, writeRunState } from "../helpers/fixtures.ts";
import { afterEach, expect, test } from "../helpers/testing.ts";
import { captureStderr, captureStdout, OCTOCAT_LOGINS } from "./auth_fixtures.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
  setGithubLoginFetch(null);
});

function isolate(): { claudeHome: string; codexHome: string } {
  const homes = isolateAgentHomes("copilot-auth-");
  dir = homes.dir;
  stubGithubLogins(OCTOCAT_LOGINS);
  return { claudeHome: homes.claudeHome, codexHome: homes.codexHome };
}

// The catalog is opt-in (default false); without this a wiring or launch refresh never runs.
function enableCatalog(): void {
  new CopilotEnvConfig().set({ "codex.model-catalog": true });
}

/** The `host` key's literal host; stubIdentitySurvey accepts every identity there (9 models). */
const CONFIGURED_HOST = "https://copilot.example";

/** An id no candidate list carries: only a pin or a stored pair puts it in the table. */
const FOREIGN_ID = "my-custom-id";

/** FOREIGN_ID's survey row: rejected on both hosts, the in-use mark after the first cell. */
const FOREIGN_MARKED_ROW = new RegExp(
  `^${FOREIGN_ID}\\s+rejected \\(400\\) \\*\\s+rejected \\(400\\)`,
  "m",
);

/** The stub the identities tests install (stubIdentitySurvey), kept so a test can wrap it. */
let stubbedSurveyFetch: ProbeFetch = () => Promise.reject(new Error("no survey stub installed"));

/** The probe answers for a PAT: the CLI identity is accepted on both hosts (a 5-model generic
 *  catalog, 37 on the account host), the sandbox on the generic host only (2 models), and the
 *  codex identity (no id header), vscode-chat, and any other id are rejected. CONFIGURED_HOST
 *  accepts every identity (9 models); `designated` is the account host the user lookup names. */
function stubIdentitySurvey(designated = "https://api.enterprise.githubcopilot.com"): void {
  stubbedSurveyFetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ endpoints: { api: designated } }), { status: 200 }),
      );
    }
    const catalog = (size: number): Response =>
      new Response(
        JSON.stringify({ data: Array.from({ length: size }, (_, i) => ({ id: `m${i}` })) }),
        {
          status: 200,
        },
      );
    if (new URL(url).origin === CONFIGURED_HOST) return Promise.resolve(catalog(9));
    const enterprise = url.startsWith("https://api.enterprise.");
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
    if (id === COPILOT_CLI_INTEGRATION_ID) return Promise.resolve(catalog(enterprise ? 37 : 5));
    if (id === COPILOT_SANDBOX_INTEGRATION_ID && !enterprise) return Promise.resolve(catalog(2));
    return Promise.resolve(
      new Response("Personal Access Tokens are not supported for this endpoint", { status: 400 }),
    );
  };
  setIntegrationProbeFetch(stubbedSurveyFetch);
}

const PAT_REJECTION = "400 Personal Access Tokens are not supported for this endpoint";

const GENERIC_HOST = "https://api.githubcopilot.com";

test("identity survey: one column per host, ONE mark on the slot's identity under the pin, and never a read of the agent files", async () => {
  const { claudeHome } = isolate();
  const credential = { kind: "stored", provider: "gh-token", token: "github_pat_x" } as const;
  new CopilotEnvState().setCredential(null, credential);
  stubIdentitySurvey();
  // The table is pinned at its natural width whatever terminal runs the tests.
  await withColumns(200, async () => {
    try {
      // One header set for every mode, so every (host, identity) is asked ONCE; the survey selects
      // nothing and writes nothing.
      const requests = new Map<string, number>();
      const surveyFetch = (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers);
        const key = `${url} ${headers.get(INTEGRATION_ID_HEADER) ?? "-"} ${
          headers.get("User-Agent") ?? "-"
        }`;
        requests.set(key, (requests.get(key) ?? 0) + 1);
        return stubbedSurveyFetch(input, init);
      };
      setIntegrationProbeFetch(surveyFetch);
      const fresh = await captureStdout(() => runAuth({ identities: true }));
      expect([...requests.entries()].filter(([, n]) => n !== 1)).toEqual([]);
      // The account lookup (no id, copilot-env's own User-Agent) happened exactly once.
      expect(requests.get("https://api.github.com/copilot_internal/user - copilot-env")).toBe(1);
      setIntegrationProbeFetch(stubbedSurveyFetch);
      // Color is a TTY affordance: the survey a pipe or a test reads is plain text.
      expect(fresh).not.toContain("\x1b");
      // Four candidate rows, nothing more; vscode-chat is the last candidate.
      expect(fresh).toMatch(
        /^vscode-chat\s+rejected \(400\)\s+rejected \(400\)\s+copilot-api's former default$/m,
      );
      expect(fresh).not.toContain(FOREIGN_ID);
      expect(fresh).toContain("identity: auto");
      expect(fresh).toContain("host: auto (api.githubcopilot.com in use)");
      expect(fresh).toMatch(
        /^identity\s+api\.githubcopilot\.com \(in use\)\s+api\.enterprise\.githubcopilot\.com \(account\)\s+note$/m,
      );
      expect(fresh).toMatch(/^codex\s+rejected \(400\)\s+rejected \(400\)\s+the default/m);
      // A slot never probed has nothing in use, so no `*`; `>` sits on what the next landing would
      // pick: the first candidate the host in use accepts (the codex identity is rejected there).
      expect(fresh).toMatch(
        /^copilot-developer-cli\s+accepted \(5 models\) >\s+accepted \(37 models\)\s+GitHub Copilot CLI/m,
      );
      expect(fresh).toMatch(
        /^copilot-developer-sandbox\s+accepted \(2 models\)\s+rejected \(400\)$/m,
      );
      expect(fresh.match(/ \*/g)).toBeNull();
      expect(fresh.match(/\) >/g)).toHaveLength(1);
      expect(fresh).toContain("; > = would be picked by the next landing (nothing stored yet)");
      expect(fresh).toContain(
        "Nothing stored yet for this profile: run `agent init` (or `agent start`) once; it probes " +
          "on the host in use and stores the identity and host it lands on.",
      );
      expect(new CopilotEnvState().readProfileDirectPair(null)).toEqual({});
      expect(fresh).toContain(`  codex on api.githubcopilot.com: ${PAT_REJECTION}`);
      expect(fresh).toContain(
        `  copilot-developer-sandbox on api.enterprise.githubcopilot.com (account): ${PAT_REJECTION}`,
      );

      // A pin without a stored pair marks nothing: the pin fixes the identity, so there is no pick to
      // preview, and the host is still the probe's to find, so the `*` waits for the pair.
      new CopilotEnvConfig().setProfile(null, { identity: COPILOT_CLI_INTEGRATION_ID });
      const pinnedEmpty = await captureStdout(() => runAuth({ identities: true }));
      expect(pinnedEmpty).toContain(`identity: pinned to ${COPILOT_CLI_INTEGRATION_ID}`);
      expect(pinnedEmpty).not.toContain(">");
      expect(pinnedEmpty.match(/ \*/g)).toBeNull();
      expect(pinnedEmpty).toContain("The host is not stored yet for this profile");
      new CopilotEnvConfig().setProfile(null, { identity: "auto" });

      // A pinned landing stored only the host; with the pin cleared the slot holds that half alone.
      // The next landing re-selects from the generic host, so no pick is previewed on the stored one.
      new CopilotEnvState().setProfileDirectPair(null, {
        host: "https://api.enterprise.githubcopilot.com",
      });
      const halfStored = await captureStdout(() => runAuth({ identities: true }));
      expect(halfStored).toContain("host: auto (api.enterprise.githubcopilot.com in use)");
      expect(halfStored).not.toContain(">");
      expect(halfStored.match(/ \*/g)).toBeNull();
      expect(halfStored).toContain("The identity is not stored yet for this profile");

      // The stored pair is THE identity in use: one `*`, on its host, and the `>` preview is gone.
      new CopilotEnvState().setProfileDirectPair(null, {
        integrationId: COPILOT_CLI_INTEGRATION_ID,
        host: GENERIC_HOST,
      });
      const stored = await captureStdout(() => runAuth({ identities: true }));
      expect(stored).toMatch(
        /^copilot-developer-cli\s+accepted \(5 models\) \*\s+accepted \(37 models\)\s/m,
      );
      expect(stored.match(/ \*/g)).toHaveLength(1);
      expect(stored).not.toContain(">");
      expect(stored).not.toContain("Nothing stored yet");

      // Negative control: an agent file baking another identity changes nothing; the files are
      // outputs, and the survey never reads them.
      configureClaudeConfig(claudeHome, {
        mode: "direct",
        credential: { kind: "command" },
        direct: directWiring(COPILOT_SANDBOX_INTEGRATION_ID, DEFAULT_COPILOT_API_BASE),
      });
      expect(await captureStdout(() => runAuth({ identities: true }))).toBe(stored);

      // A pin overlays the stored identity: the mark moves to it, and the note names the overlay.
      await runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID });
      const pinned = await captureStdout(() => runAuth({ identities: true }));
      expect(pinned).toContain(`identity: pinned to ${COPILOT_SANDBOX_INTEGRATION_ID}`);
      expect(pinned).toMatch(
        /^copilot-developer-cli\s+accepted \(5 models\)\s+accepted \(37 models\)\s/m,
      );
      expect(pinned).toMatch(
        /^copilot-developer-sandbox\s+accepted \(2 models\) \*\s+rejected \(400\)$/m,
      );
      expect(pinned).toContain(
        "Slot: the probed identity is copilot-developer-cli; the pin overlays it at every " +
          "re-render and daemon start.",
      );

      // A pin that is not a built-in candidate is still probed and marked, never a bare `-`.
      new CopilotEnvConfig().setProfile(null, { identity: FOREIGN_ID });
      const foreign = await captureStdout(() => runAuth({ identities: true }));
      expect(foreign).toMatch(FOREIGN_MARKED_ROW);
      expect(foreign).toContain(`  ${FOREIGN_ID} on api.githubcopilot.com: ${PAT_REJECTION}`);

      // A stored identity no candidate list names (set here directly: a landing never stores a
      // pin) stays in use once the pin clears, so its row stays and keeps the mark.
      new CopilotEnvConfig().setProfile(null, { identity: "auto" });
      new CopilotEnvState().setProfileDirectPair(null, {
        integrationId: FOREIGN_ID,
        host: GENERIC_HOST,
      });
      const storedForeign = await captureStdout(() => runAuth({ identities: true }));
      expect(storedForeign).toContain("identity: auto");
      expect(storedForeign).toMatch(FOREIGN_MARKED_ROW);
      expect(storedForeign.match(/ \*/g)).toHaveLength(1);

      // A credential the proxy exchanges itself (device-flow) has no identity story of its own: the
      // credential write took the pair with it, so the slot reads as never probed again.
      new CopilotEnvState().setCredential(null, {
        kind: "stored",
        provider: "copilot",
        token: "ghu_device",
      });
      const exchanged = await captureStdout(() => runAuth({ identities: true }));
      expect(exchanged.match(/ \*/g)).toBeNull();
      expect(exchanged).toContain("Nothing stored yet for this profile");
      expect(exchanged).not.toContain("passthrough");

      // A running daemon keeps the identity and host it launched with, and the table says so.
      writeRunState({ pid: process.pid, port: 4141 });
      const running = await captureStdout(() => runAuth({ identities: true }));
      expect(running).toContain(
        "Proxy: a daemon is running and keeps the identity and host it launched with; restart it " +
          "to apply a change: `agent stop`, then `agent start`.",
      );
    } finally {
      setIntegrationProbeFetch(null);
    }
  });
});

/** Every verdict kind on the host in use, an absent account-host cell, the would-be pick: each palette color lands. */
const SURVEY_TABLE: IdentityTableInput = {
  survey: {
    hosts: [
      {
        apiBase: GENERIC_HOST,
        role: "generic",
        verdicts: [
          { name: CODEX_IDENTITY_NAME, verdict: { kind: "rejected", detail: PAT_REJECTION } },
          { name: COPILOT_CLI_INTEGRATION_ID, verdict: { kind: "accepted", models: 5 } },
          {
            name: VSCODE_CHAT_INTEGRATION_ID,
            verdict: { kind: "inconclusive", detail: "503 upstream unavailable", status: 503 },
          },
        ],
      },
      {
        apiBase: "https://api.enterprise.githubcopilot.com",
        role: "designated",
        verdicts: [
          { name: CODEX_IDENTITY_NAME, verdict: { kind: "rejected", detail: PAT_REJECTION } },
          { name: COPILOT_CLI_INTEGRATION_ID, verdict: { kind: "accepted", models: 37 } },
        ],
      },
    ],
    designatedUnknown: false,
  },
  pinned: null,
  configuredHost: null,
  stored: {},
  hostInUse: GENERIC_HOST,
  slot: { kind: "empty", wouldPick: COPILOT_CLI_INTEGRATION_ID },
  daemonRunning: false,
  profile: null,
  color: false,
};

/** Opens every SGR sequence; a line painted dim end to end splits on it into exactly three parts. */
const ESC = "\x1b";

test("identityTableLines: with color on, the palette paints the survey like agent config and strips back to the plain layout", async () => {
  await withColumns(160, () => {
    const plain = identityTableLines(SURVEY_TABLE);
    const colored = identityTableLines({ ...SURVEY_TABLE, color: true });
    expect(plain.join("\n")).not.toContain("\x1b");
    // Escapes never move a cell: stripped, the painted table IS the plain one, line for line.
    const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    expect(colored.map((line) => line.replace(sgr, ""))).toEqual(plain);
    const painted = colored.join("\n");
    expect(painted).toContain("\x1b[1midentity\x1b[22m");
    expect(painted).toContain(`\x1b[36m${COPILOT_CLI_INTEGRATION_ID}\x1b[39m`);
    expect(painted).toContain("\x1b[32maccepted (5 models)\x1b[39m \x1b[32m>\x1b[39m");
    expect(painted).toContain("\x1b[33mrejected (400)\x1b[39m");
    expect(painted).toContain("\x1b[2munclear (503)\x1b[22m");
    expect(painted).toContain("\x1b[2m-\x1b[22m");
    expect(painted).toContain("api.githubcopilot.com \x1b[2m(in use)\x1b[22m");
    // The legend, every note, and every reason are dim end to end: one open, one close, so the
    // host label inside a reason never nests a dim of its own.
    const dimWhole = (line: string | undefined, indent = ""): boolean =>
      line?.startsWith(`${indent}\x1b[2m`) === true &&
      line.endsWith("\x1b[22m") &&
      line.split(ESC).length === 3;
    expect(dimWhole(colored.find((line) => line.includes("* = in use")))).toBe(true);
    expect(dimWhole(colored.find((line) => line.includes("Nothing stored yet")))).toBe(true);
    const reason = colored.find((line) => line.includes("codex on api.enterprise."));
    expect(reason).toContain("(account)");
    expect(dimWhole(reason, "  ")).toBe(true);
  });
});

test("identity survey: columns are the generic host, the account's when it differs, and the host in use (the literal, else the stored host)", async () => {
  isolate();
  const credential = { kind: "stored", provider: "gh-token", token: "github_pat_x" } as const;
  new CopilotEnvState().setCredential(null, credential);
  await withColumns(200, async () => {
    try {
      // The account is served on the generic host: one column, marked in use.
      stubIdentitySurvey("https://api.githubcopilot.com");
      const one = await captureStdout(() => runAuth({ identities: true }));
      expect(one).toMatch(/^identity\s+api\.githubcopilot\.com \(in use\)\s+note$/m);
      expect(one).not.toContain("(account)");

      // A literal adds its column and takes the in-use mark over the stored host: the stored codex
      // identity is marked on the literal's column, where every identity is accepted.
      new CopilotEnvState().setProfileDirectPair(null, { integrationId: null, host: GENERIC_HOST });
      new CopilotEnvConfig().setProfile(null, { host: CONFIGURED_HOST });
      stubIdentitySurvey();
      const three = await captureStdout(() => runAuth({ identities: true }));
      expect(three).toContain(`host: ${CONFIGURED_HOST}`);
      expect(three).toMatch(
        /^identity\s+api\.githubcopilot\.com\s+api\.enterprise\.githubcopilot\.com \(account\)\s+copilot\.example \(host, in use\)\s+note$/m,
      );
      expect(three).toMatch(
        /^codex\s+rejected \(400\)\s+rejected \(400\)\s+accepted \(9 models\) \*\s+the default/m,
      );
      expect(three.match(/ \*/g)).toHaveLength(1);

      // Under `auto` the stored host is the host in use: a column of its own when the account lookup
      // fails (no account column to merge into), tagged as stored, and the mark sits there.
      new CopilotEnvConfig().delProfile(null, "host");
      new CopilotEnvState().setProfileDirectPair(null, {
        integrationId: COPILOT_CLI_INTEGRATION_ID,
        host: "https://api.enterprise.githubcopilot.com",
      });
      setIntegrationProbeFetch((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/copilot_internal/user")) {
          return Promise.resolve(new Response("upstream", { status: 503 }));
        }
        return stubbedSurveyFetch(input, init);
      });
      const storedHost = await captureStdout(() => runAuth({ identities: true }));
      expect(storedHost).toContain("host: auto (api.enterprise.githubcopilot.com in use)");
      expect(storedHost).toMatch(
        /^identity\s+api\.githubcopilot\.com\s+api\.enterprise\.githubcopilot\.com \(stored, in use\)\s+note$/m,
      );
      expect(storedHost).toMatch(
        /^copilot-developer-cli\s+accepted \(5 models\)\s+accepted \(37 models\) \*\s/m,
      );
      expect(storedHost).toContain(
        "Host: the account's designated host could not be looked up (transient); only the hosts " +
          "above were surveyed.",
      );

      // A literal equal to the account's host is one column, in its account role.
      stubIdentitySurvey();
      new CopilotEnvConfig().setProfile(null, { host: "https://api.enterprise.githubcopilot.com" });
      const merged = await captureStdout(() => runAuth({ identities: true }));
      expect(merged).toMatch(
        /^identity\s+api\.githubcopilot\.com\s+api\.enterprise\.githubcopilot\.com \(account, in use\)\s+note$/m,
      );
      expect(merged).not.toContain("host, in use");
    } finally {
      setIntegrationProbeFetch(null);
    }
  });
});

test("identity survey: at 80 columns the note wraps inside its own column, never under the identity", async () => {
  isolate();
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "github_pat_x",
  });
  // One host column (the account is served on the generic host), so the columns fit and wrap.
  stubIdentitySurvey("https://api.githubcopilot.com");
  await withColumns(80, async () => {
    try {
      const lines = (await captureStdout(() => runAuth({ identities: true }))).split("\n");
      expect(lines.filter((line) => line.length > 80)).toEqual([]);
      const header = lines.find((line) => line.startsWith("identity  "));
      const noteAt = header?.indexOf("note") ?? -1;
      expect(noteAt).toBeGreaterThan(0);
      // The codex note breaks before its longest word; the continuation starts where the note
      // column does, with every cell before it blank.
      const continuation = lines.find((line) => /^\s+Copilot-Integration-Id/.test(line));
      expect(continuation?.search(/\S/)).toBe(noteAt);
    } finally {
      setIntegrationProbeFetch(null);
    }
  });
});

test("set identity <id>: refused only when EVERY host rejects; one acceptance pins and names the other verdicts; auto clears", async () => {
  isolate();
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "github_pat_x",
  });
  stubIdentitySurvey();
  try {
    await expect(runAuth({ identity: VSCODE_CHAT_INTEGRATION_ID })).rejects.toThrow(
      [
        `every host rejects this credential under \`${VSCODE_CHAT_INTEGRATION_ID}\`; not pinned:`,
        `  - api.githubcopilot.com: ${PAT_REJECTION}`,
        `  - api.enterprise.githubcopilot.com (account): ${PAT_REJECTION}`,
      ].join("\n"),
    );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();

    // Accepted on the generic host, rejected on the account's: pinned, and the warning names what
    // carried it.
    const narrated = await captureStderr(() =>
      runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID }),
    );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe(COPILOT_SANDBOX_INTEGRATION_ID);
    // consola's fancy reporter strips the backticks around the id; the CI reporter keeps them.
    expect(narrated).toMatch(
      new RegExp(
        `api\\.enterprise\\.githubcopilot\\.com \\(account\\): rejects \`?${COPILOT_SANDBOX_INTEGRATION_ID}\`? ` +
          `\\(${PAT_REJECTION}\\); pinning on api\\.githubcopilot\\.com accepting it\\.`,
      ),
    );

    await runAuth({ identity: "auto" });
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();

    // A transient account-host lookup leaves that host unknown and a blocked generic host (403)
    // is inconclusive: nothing definitive stands against the pin, so it lands unverified and
    // says so.
    setIntegrationProbeFetch((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        url.includes("/copilot_internal/user")
          ? new Response("upstream", { status: 503 })
          : new Response("forbidden", { status: 403 }),
      );
    });
    const unknown = await captureStderr(() =>
      runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID }),
    );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe(COPILOT_SANDBOX_INTEGRATION_ID);
    expect(unknown).toContain(
      "The account's designated host could not be looked up (transient); pinning unverified.",
    );

    // Under a literal every request goes there, so its rejection alone refuses the pin even though
    // another host accepts the identity (the enterprise host rejects the sandbox id in this stub).
    await runAuth({ identity: "auto" });
    stubIdentitySurvey();
    new CopilotEnvConfig().setProfile(null, { host: "https://api.enterprise.githubcopilot.com" });
    await expect(runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID })).rejects.toThrow(
      "api.enterprise.githubcopilot.com (account, in use) rejects this credential under " +
        `\`${COPILOT_SANDBOX_INTEGRATION_ID}\`; not pinned, every request goes to the ` +
        `host in use: ${PAT_REJECTION}`,
    );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();

    // Under `auto` the same rule reads the host auto WOULD select for the pin: the generic host
    // answers 400 for the sandbox id (kept: 400 is an identity answer), so its rejection refuses
    // the pin even though the account's host accepts that id; the CLI id, accepted there, pins.
    new CopilotEnvConfig().delProfile(null, "host");
    setIntegrationProbeFetch((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/copilot_internal/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ endpoints: { api: "https://api.enterprise.githubcopilot.com" } }),
            { status: 200 },
          ),
        );
      }
      const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
      const enterprise = url.startsWith("https://api.enterprise.");
      const accepted =
        id === COPILOT_CLI_INTEGRATION_ID || (id === COPILOT_SANDBOX_INTEGRATION_ID && enterprise);
      return Promise.resolve(
        accepted
          ? new Response(JSON.stringify({ data: [{}] }), { status: 200 })
          : new Response("Personal Access Tokens are not supported for this endpoint", {
              status: 400,
            }),
      );
    });
    await expect(runAuth({ identity: COPILOT_SANDBOX_INTEGRATION_ID })).rejects.toThrow(
      "api.githubcopilot.com rejects this credential under " +
        `\`${COPILOT_SANDBOX_INTEGRATION_ID}\`; not pinned, every request goes to the host auto ` +
        `selects for this identity: ${PAT_REJECTION}`,
    );
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBeNull();
    await runAuth({ identity: COPILOT_CLI_INTEGRATION_ID });
    expect(new CopilotEnvConfig().pinnedIntegrationId(null)).toBe(COPILOT_CLI_INTEGRATION_ID);
  } finally {
    setIntegrationProbeFetch(null);
  }
});

test("auth --get and the proxy-token resolver return the credential without a catalog refresh or a Codex config rewrite: a due catalog and a healable Codex config stay byte-identical", async () => {
  isolate();
  enableCatalog();
  // What a refresh would act on: a config with our provider and no catalog
  // reference (the sync's add-only heal), no catalog file, and a throttle that reads as due.
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, stringify({ model_provider: "copilot-env" }));
  const configBytes = readFileSync(configPath, "utf8");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_stored123",
  });

  expect(await captureStdout(() => runAuth({ get: true }))).toBe("ghu_stored123\n");
  expect(process.exitCode).toBe(0);
  expect(await captureStdout(() => Promise.resolve(runPrintProxyToken(null)))).toMatch(
    /^[0-9a-f]{64}\n$/,
  );

  expect(readFileSync(configPath, "utf8")).toBe(configBytes);
  expect(existsSync(catalogFile)).toBe(false);
  // Not even the refresh's own bookkeeping ran: the attempt stamp is what a refresh writes first.
  expect(new CopilotEnvState().read().codexCatalogLastAttemptMs).toBe(0);
});
