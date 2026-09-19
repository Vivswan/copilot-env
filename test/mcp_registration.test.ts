import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  classifyMcpEntry,
  claudeJsonPath,
  inspectMcpRegistration,
  registerClaudeMcpServer,
  removeClaudeMcpRegistration,
  serverPathEnv,
} from "../src/claude/mcp_registration.ts";
import { resolveExecutablePath } from "../src/utils/command.ts";
import { agentLauncherCommand } from "../src/utils/root.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot } from "./helpers/env.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

/** A fresh config dir; a case that runs several rows calls it once per row. */
function tmpConfigDir(): string {
  dir = removeDir(dir);
  dir = tempDir("copilot-mcpreg-");
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function readDoc(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>;
}

function readEntry(): unknown {
  return (readDoc().mcpServers as Record<string, unknown> | undefined)?.["copilot-env"];
}

function writeDoc(doc: Record<string, unknown>): void {
  writeFileSync(claudeJsonPath(), `${JSON.stringify(doc)}\n`);
}

function movedCheckout(entry: Record<string, unknown>): Record<string, unknown> {
  return process.platform === "win32"
    ? {
      ...entry,
      "args": (entry.args as string[]).map((a) =>
        /[\\/]bin[\\/]agent\.ps1$/i.test(a) ? "C:\\somewhere\\else\\bin\\agent.ps1" : a
      ),
    }
    : { ...entry, "command": "/somewhere/else/bin/agent" };
}

function managedEntry(): Record<string, unknown> {
  const { command, args } = agentLauncherCommand(["profile", "mcp", "--serve"]);
  const env = serverPathEnv(resolveExecutablePath("gh"));
  return { "type": "stdio", "command": command, "args": args, ...(env ? { env } : {}) };
}

const OTHER_SERVER = { "type": "stdio", "command": "x", "args": [] };

test("serverPathEnv puts gh's directory in front of the client's PATH by expansion, or nothing", () => {
  const gh = join(delimiter === ";" ? "C:\\tools\\gh" : "/opt/homebrew/bin", "gh");
  expect(serverPathEnv(gh)).toEqual({ PATH: `${dirname(gh)}${delimiter}\${PATH}` });
  expect(serverPathEnv(null)).toBeUndefined();
});

// Whether this pass can see gh decides what happens to the entry's PATH env: a pass that cannot
// keeps what an earlier one recorded, and a pass that can rewrites an env-less entry of ours. The
// second row needs a real gh on PATH (CI has one).
test("the PATH env follows gh's visibility: kept when gh is unseen, restored when it is seen", () => {
  const { command, args } = agentLauncherCommand(["profile", "mcp", "--serve"]);
  const bare = { "type": "stdio", "command": command, "args": args };
  const recorded = { ...bare, env: { PATH: `/somewhere/bin${delimiter}\${PATH}` } };
  const gh = resolveExecutablePath("gh");
  const rows: {
    visibility: string;
    gh: string | null;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }[] = [
    { visibility: "gh unseen", gh: null, before: movedCheckout(recorded), after: recorded },
    ...(gh === null ? [] : [{ visibility: "gh seen", gh, before: bare, after: managedEntry() }]),
  ];
  for (const { visibility, gh, before, after } of rows) {
    tmpConfigDir();
    expect({ visibility, status: classifyMcpEntry(after, gh) }).toEqual({
      visibility,
      status: "ours-current",
    });
    expect({ visibility, status: classifyMcpEntry(before, gh) }).toEqual({
      visibility,
      status: "ours-stale",
    });
    writeDoc({ "mcpServers": { "copilot-env": before } });
    expect({ visibility, registered: registerClaudeMcpServer(gh) }).toEqual({
      visibility,
      registered: true,
    });
    expect({ visibility, entry: readEntry() }).toEqual({ visibility, entry: after });
  }
  if (gh !== null) {
    const written = readEntry() as { env: { PATH: string } };
    expect(written.env.PATH.endsWith(`${delimiter}\${PATH}`)).toBe(true);
  }
});

// What register finds at the path decides what it writes around the managed entry.
test("register writes the managed entry into a missing file or an existing one, keeping the rest", () => {
  const rows: { existing: Record<string, unknown> | null; doc: Record<string, unknown> }[] = [
    { existing: null, doc: { "mcpServers": { "copilot-env": managedEntry() } } },
    {
      existing: { "numStartups": 42, "mcpServers": { "other": OTHER_SERVER } },
      doc: {
        "numStartups": 42,
        "mcpServers": { "other": OTHER_SERVER, "copilot-env": managedEntry() },
      },
    },
  ];
  for (const { existing, doc } of rows) {
    tmpConfigDir();
    if (existing !== null) writeDoc(existing);
    expect({ existing, registered: registerClaudeMcpServer() }).toEqual({
      existing,
      registered: true,
    });
    expect({ existing, doc: readDoc() }).toEqual({ existing, doc });
  }
});

test("register is byte-idempotent: a second run does not rewrite the file", () => {
  tmpConfigDir();
  expect(registerClaudeMcpServer()).toBe(true);
  const before = statSync(claudeJsonPath()).mtimeMs;
  const raw = readFileSync(claudeJsonPath(), "utf8");
  expect(registerClaudeMcpServer()).toBe(true);
  expect(readFileSync(claudeJsonPath(), "utf8")).toBe(raw);
  expect(statSync(claudeJsonPath()).mtimeMs).toBe(before);
});

// The state of the copilot-env entry decides whether register and remove may touch the file at
// all: someone else's entry and an unparseable file are left byte-for-byte; an entry of ours from
// a moved checkout is reclaimed by both.
test("register and remove act only on an entry that is ours: foreign and malformed stay untouched", () => {
  const foreign = { "type": "stdio", "command": "npx", "args": ["someone-elses-server"] };
  const stale = movedCheckout(managedEntry());
  expect(classifyMcpEntry(stale)).toBe("ours-stale");
  type Observed = { entry: unknown } | { raw: string };
  const rows: {
    state: string;
    raw: string;
    registered: boolean;
    afterRegister: Observed;
    afterRemove: Observed;
  }[] = [
    {
      state: "foreign entry",
      raw: `${JSON.stringify({ "mcpServers": { "copilot-env": foreign } })}\n`,
      registered: false,
      afterRegister: { entry: foreign },
      afterRemove: { entry: foreign },
    },
    {
      state: "malformed file",
      raw: "{ not json",
      registered: false,
      afterRegister: { raw: "{ not json" },
      afterRemove: { raw: "{ not json" },
    },
    {
      state: "ours-stale entry",
      raw: `${JSON.stringify({ "mcpServers": { "copilot-env": stale } })}\n`,
      registered: true,
      afterRegister: { entry: managedEntry() },
      afterRemove: { entry: undefined },
    },
  ];
  const observe = (expected: Observed): Observed =>
    "raw" in expected ? { raw: readFileSync(claudeJsonPath(), "utf8") } : { entry: readEntry() };
  for (const { state, raw, registered, afterRegister, afterRemove } of rows) {
    tmpConfigDir();
    writeFileSync(claudeJsonPath(), raw);
    expect({ state, registered: registerClaudeMcpServer() }).toEqual({ state, registered });
    expect({ state, ...observe(afterRegister) }).toEqual({ state, ...afterRegister });
    removeClaudeMcpRegistration();
    expect({ state, ...observe(afterRemove) }).toEqual({ state, ...afterRemove });
  }
});

// remove takes out exactly our entry: an emptied mcpServers goes with it, siblings and unrelated
// keys stay, the file itself is never deleted and never created.
test("remove deletes only ours, drops an emptied mcpServers, and never creates or deletes the file", () => {
  const rows: { setup: () => void; doc: Record<string, unknown> | null }[] = [
    { setup: () => expect(registerClaudeMcpServer()).toBe(true), doc: {} },
    {
      setup: () =>
        writeDoc({
          "numStartups": 1,
          "mcpServers": { "copilot-env": managedEntry(), "other": OTHER_SERVER },
        }),
      doc: { "numStartups": 1, "mcpServers": { "other": OTHER_SERVER } },
    },
    { setup: () => {}, doc: null },
  ];
  for (const { setup, doc } of rows) {
    tmpConfigDir();
    setup();
    removeClaudeMcpRegistration();
    expect(existsSync(claudeJsonPath()) ? readDoc() : null).toEqual(doc);
  }
});

test("classifyMcpEntry: ours-current, ours-stale, foreign, and absent, from the whole entry shape", () => {
  const managed = managedEntry();
  const args = managed.args as string[];
  const { type: _drop, ...untyped } = managed;
  const rows: { entry: unknown; status: string; posix?: true }[] = [
    { entry: undefined, status: "absent" },
    { entry: managed, status: "ours-current" },
    // Missing type counts as stdio (Claude's own default).
    { entry: untyped, status: "ours-current" },
    { entry: { ...managed, "type": "http" }, status: "foreign" },
    { entry: { "command": 5 }, status: "foreign" },
    { entry: "nope", status: "foreign" },
    // A bare `agent` from someone's PATH is foreign, not ours-stale; only a launcher path shaped
    // like ours, running our subcommand, is a moved checkout.
    {
      entry: { "type": "stdio", "command": "agent", "args": ["mcp"] },
      status: "foreign",
      posix: true,
    },
    {
      entry: { "type": "stdio", "command": "agent", "args": ["profile", "mcp", "--serve"] },
      status: "foreign",
      posix: true,
    },
    {
      entry: { "type": "stdio", "command": "/usr/local/agent", "args": ["mcp"] },
      status: "foreign",
      posix: true,
    },
    {
      entry: {
        "type": "stdio",
        "command": "/elsewhere/bin/agent",
        "args": ["profile", "mcp", "--serve"],
      },
      status: "ours-stale",
      posix: true,
    },
    // Malformed launcher argvs are never reclaimed; our launcher shape running some OTHER
    // subcommand is not a registration of ours either.
    { entry: { ...managed, "args": [...args, "extra"] }, status: "foreign" },
    { entry: { ...managed, "args": args.slice(0, -2) }, status: "foreign" },
    {
      entry: { ...managed, "args": args.map((a) => (a === "--serve" ? "--verbose" : a)) },
      status: "foreign",
    },
  ];
  if (process.platform === "win32") {
    const fileIdx = args.indexOf("-File");
    rows.push(
      // Missing script path: -File runs straight into the subargs.
      {
        entry: { ...managed, "args": [...args.slice(0, fileIdx + 1), ...args.slice(fileIdx + 2)] },
        status: "foreign",
      },
      {
        entry: { ...managed, "args": args.map((a) => (a === "-NoProfile" ? "-Profile" : a)) },
        status: "foreign",
      },
    );
  }
  // The POSIX rows spell POSIX launcher paths; they run on every platform but Windows.
  for (const { entry, status, posix } of rows) {
    if (posix && process.platform === "win32") continue;
    expect({ entry, status: classifyMcpEntry(entry) }).toEqual({ entry, status });
  }
});

test("a file Claude wrote without a trailing newline keeps its convention", () => {
  const home = tmpConfigDir();
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ "numStartups": 7 }, null, 2)); // no \n
  expect(registerClaudeMcpServer()).toBe(true);
  const raw = readFileSync(claudeJsonPath(), "utf8");
  expect(raw.endsWith("\n")).toBe(false);
  expect((JSON.parse(raw) as Record<string, unknown>).numStartups).toBe(7);
});

test("inspectMcpRegistration reports path and status without creating the file", () => {
  const home = tmpConfigDir();
  expect(inspectMcpRegistration()).toEqual({ path: claudeJsonPath(), status: "absent" });
  expect(existsSync(claudeJsonPath())).toBe(false);

  registerClaudeMcpServer();
  expect(inspectMcpRegistration().status).toBe("ours-current");

  writeFileSync(join(home, ".claude.json"), "{ not json");
  expect(inspectMcpRegistration().status).toBe("unreadable");
});

// POSIX only: creating symlinks on Windows needs elevation/dev-mode.
test.skipIf(process.platform === "win32")(
  "a dangling .claude.json symlink is unreadable, never treated as an empty file",
  () => {
    const home = tmpConfigDir();
    // A link whose target existed and was removed: the entry AT the path
    // remains (lstat), but every follow -- existsSync included -- reads ENOENT.
    const target = join(home, "real-claude.json");
    writeFileSync(target, `${JSON.stringify({ "numStartups": 3 })}\n`);
    symlinkSync(target, claudeJsonPath());
    rmSync(target);

    expect(inspectMcpRegistration()).toEqual({ path: claudeJsonPath(), status: "unreadable" });
    expect(registerClaudeMcpServer()).toBe(false);
    expect(removeClaudeMcpRegistration()).toBe(false);
    // Still the same link to the same place, and nothing materialized at its target.
    expect(lstatSync(claudeJsonPath()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeJsonPath())).toBe(target);
    expect(existsSync(target)).toBe(false);
  },
);
