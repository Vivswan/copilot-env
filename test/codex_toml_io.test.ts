import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "smol-toml";
import { syncCodexCatalogReference } from "../src/codex/catalog_reference.ts";
import {
  configureCodexConfig,
  removeCodexDefaultWiring,
  removeCodexProfile,
} from "../src/codex/config.ts";
import { readCodexToml } from "../src/codex/toml_io.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";
const COMMAND = { kind: "command" } as const;

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

// --- readCodexToml: the file's content decides the kind ---------------------------

test("readCodexToml: missing and blank read as absent, key-less text as an empty ok document, anything the parser rejects as unparseable", () => {
  // The seed-a-default site (loadOrCreateConfig) treats an absent read like a missing file, so
  // only content with nothing in it may read absent: a comment-only file is real user text, and a
  // BOM, NBSP, or lone CR is trim()-blank but rejected by smol-toml; classifying either "absent"
  // would let a write path clobber a file that exists.
  dir = tempDir("codex-toml-io-");
  const path = join(dir, "config.toml");
  const cases: { name: string; content: string | null; kind: "absent" | "ok" | "unparseable" }[] = [
    { name: "missing", content: null, kind: "absent" },
    { name: "empty", content: "", kind: "absent" },
    { name: "whitespace only", content: "  \n\t\r\n", kind: "absent" },
    { name: "comment only", content: "# my notes\n# more notes\n", kind: "ok" },
    { name: "not TOML", content: 'command = "unbalanced\n', kind: "unparseable" },
    { name: "BOM", content: "\ufeff", kind: "unparseable" },
    { name: "NBSP", content: "\u00a0", kind: "unparseable" },
    { name: "lone CR", content: "\r", kind: "unparseable" },
    { name: "CR between spaces", content: " \r ", kind: "unparseable" },
  ];
  for (const c of cases) {
    rmSync(path, { force: true });
    if (c.content !== null) writeFileSync(path, c.content);
    const read = readCodexToml(path);
    if (c.kind === "unparseable") {
      expect([c.name, read.kind]).toEqual([c.name, "unparseable"]);
      if (read.kind === "unparseable") expect(read.error.length, c.name).toBeGreaterThan(0);
    } else {
      // The whole result: an absent read carries nothing else, an ok read the (empty) document.
      expect([c.name, read]).toEqual([
        c.name,
        c.kind === "absent" ? { kind: "absent" } : { kind: "ok", doc: {} },
      ]);
    }
  }
  // Valid TOML reads as ok with the parsed document.
  writeFileSync(path, ['model_provider = "copilot-env"', "", "[t]", 'k = "v"', ""].join("\n"));
  const read = readCodexToml(path);
  if (read.kind !== "ok") throw new Error("expected ok");
  expect(read.doc.model_provider).toBe("copilot-env");
  expect(read.doc.t).toEqual({ "k": "v" });
});

test("readCodexToml: the parser's diagnostic quotes the offending line, so a static-key bearer is redacted from it", () => {
  dir = tempDir("codex-toml-io-");
  const path = join(dir, "config.toml");
  const token = "REVIEW_SENTINEL_TOKEN";
  // The typo sits right after the bearer line: smol-toml's message excerpts the source around it.
  writeFileSync(
    path,
    [
      "[model_providers.copilot-env.http_headers]",
      `Authorization = "Bearer ${token}"`,
      "broken = ]",
      "",
    ]
      .join("\n"),
  );
  const read = readCodexToml(path);
  if (read.kind !== "unparseable") throw new Error("expected unparseable");
  expect(read.error).not.toContain(token);
  expect(read.error).toContain("Bearer <redacted>");
});

test("readCodexToml: a non-ENOENT filesystem error throws raw instead of reading as absent", () => {
  dir = tempDir("codex-toml-io-");
  const asDir = join(dir, "config.toml");
  mkdirSync(asDir); // reading a directory raises EISDIR, never ENOENT
  let thrown: unknown;
  try {
    readCodexToml(asDir);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  // Raw fs error, not ENOENT and not one of the wrapped call-site messages.
  expect((thrown as NodeJS.ErrnoException).code).toBe("EISDIR");
  expect((thrown as Error).message).not.toMatch(/valid TOML/);
});

// --- call-site policies in src/codex/config.ts + catalog_reference.ts ---------------

// Real user content plus one TOML syntax error (an unbalanced quote from a hand edit).
const UNPARSEABLE = ["[mcp_servers.mine]", 'command = "my-server', ""].join("\n");

function capture(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

test("policy: configureCodexConfig (loadOrCreateConfig) throws on unparseable, file preserved", () => {
  dir = isolateAgentHomes("codex-toml-io-", { mkdirs: true }).dir;
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, UNPARSEABLE);

  // The exact wrapped message up to the parser's own text (path included).
  const thrown = capture(() =>
    configureCodexConfig(codexHome, {
      mode: "proxy",
      credential: COMMAND,
      baseUrl: "http://localhost:4141/v1",
    })
  );
  expect(
    (thrown as Error).message.startsWith(
      `${configPath} is not valid TOML; refusing to overwrite it (`,
    ),
  ).toBe(true);
  expect(readFileSync(configPath, "utf8")).toBe(UNPARSEABLE);

  // A non-ENOENT read error (config.toml is a directory) propagates raw --
  // fail loudly, never overwrite blindly.
  rmSync(configPath);
  mkdirSync(configPath);
  const rawError = capture(() =>
    configureCodexConfig(codexHome, {
      mode: "proxy",
      credential: COMMAND,
      baseUrl: "http://localhost:4141/v1",
    })
  );
  expect((rawError as NodeJS.ErrnoException).code).toBe("EISDIR");
});

test("policy: syncCodexCatalogReference swallows an unparseable config, file preserved", () => {
  dir = isolateAgentHomes("codex-toml-io-", { mkdirs: true }).dir;
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  // Reach the config read: catalog enabled AND a usable generated file.
  new CopilotEnvConfig().set({ "codex.model-catalog": true });
  writeFileSync(new CopilotApiPaths().codexModelCatalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, UNPARSEABLE);

  expect(() => syncCodexCatalogReference()).not.toThrow();
  expect(readFileSync(configPath, "utf8")).toBe(UNPARSEABLE);

  // A non-ENOENT read error (config.toml is a directory) is swallowed too:
  // best-effort, never throws.
  rmSync(configPath);
  mkdirSync(configPath);
  expect(() => syncCodexCatalogReference()).not.toThrow();
});

test("policy: the removals skip an absent config and never blind-write: unparseable or unreadable throws wrapped, file preserved", () => {
  // Both removal functions share one read policy; the user's .env is never touched by either.
  const removals: { name: string; remove: (codexHome: string) => void }[] = [
    { name: "removeCodexProfile", remove: (h) => removeCodexProfile(h, parseProfileName("work")) },
    { name: "removeCodexDefaultWiring", remove: (h) => removeCodexDefaultWiring(h) },
  ];
  for (const { name, remove } of removals) {
    dir = removeDir(dir);
    dir = isolateAgentHomes("codex-toml-io-", { mkdirs: true }).dir;
    const codexHome = join(dir, ".codex");
    const configPath = join(codexHome, "config.toml");
    const envPath = join(codexHome, ".env");
    writeFileSync(envPath, "OPENAI_API_KEY=user\n");

    // Absent: nothing to remove, no config is ever created, the user's .env untouched.
    expect(() => remove(codexHome), name).not.toThrow();
    expect(existsSync(configPath), name).toBe(false);
    expect(readFileSync(envPath, "utf8"), name).toBe("OPENAI_API_KEY=user\n");

    // Unparseable: never blind-write over a config we could not read. The exact wrapped message up
    // to the parser's own text (path included).
    writeFileSync(configPath, UNPARSEABLE);
    const wrapped = capture(() => remove(codexHome));
    expect(
      (wrapped as Error).message.startsWith(`${configPath} is not readable/valid TOML: `),
      name,
    )
      .toBe(true);
    expect(readFileSync(configPath, "utf8"), name).toBe(UNPARSEABLE);

    // A non-ENOENT read error (config.toml is a directory) gets the same wrap.
    rmSync(configPath);
    mkdirSync(configPath);
    const dirWrapped = capture(() => remove(codexHome));
    expect(
      (dirWrapped as Error).message.startsWith(`${configPath} is not readable/valid TOML: `),
      name,
    ).toBe(true);
    expect(readFileSync(envPath, "utf8"), name).toBe("OPENAI_API_KEY=user\n");
  }
});

// The removal strips `model_catalog_json` only when it DENOTES our catalog file; the cases differ
// solely in what the reference resolves to. The "ours" case uses a symlink alias (hence the Windows
// skip, where symlinks need privileges): the exact spelling short-circuits before the resolver, so
// only an alias exercises its "yes" branch.
test.skipIf(process.platform === "win32")(
  "policy: removeCodexDefaultWiring strips model_catalog_json only when it is provably ours",
  () => {
    dir = isolateAgentHomes("codex-toml-io-", { mkdirs: true }).dir;
    const codexHome = join(dir, ".codex");
    const configPath = join(codexHome, "config.toml");
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    mkdirSync(dirname(catalogFile), { recursive: true });
    writeFileSync(catalogFile, '{"models":[]}');

    // 1. Ours via a non-identical spelling that RESOLVES to our file: stripped.
    const alias = join(dir, "catalog-alias.json");
    symlinkSync(catalogFile, alias);
    writeFileSync(configPath, stringify({ "model_catalog_json": alias }));
    removeCodexDefaultWiring(codexHome);
    expect(readFileSync(configPath, "utf8")).not.toContain("model_catalog_json");

    // 2. Provably NOT ours: another file that resolves fine, elsewhere. Left alone.
    const foreign = join(dir, "someone-elses-catalog.json");
    writeFileSync(foreign, "{}");
    writeFileSync(configPath, stringify({ "model_catalog_json": foreign }));
    removeCodexDefaultWiring(codexHome);
    expect(readFileSync(configPath, "utf8")).toContain("model_catalog_json");
  },
);

// Its own test so the platform skip is visible in the output: a reference whose resolve cannot
// run is not proof the key is ours, so it is left alone, never stripped on doubt. Non-root POSIX
// only: root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "policy: removeCodexDefaultWiring leaves a reference it CANNOT resolve alone",
  () => {
    dir = isolateAgentHomes("codex-toml-io-", { mkdirs: true }).dir;
    const codexHome = join(dir, ".codex");
    const configPath = join(codexHome, "config.toml");
    const blocked = join(dir, "blocked");
    mkdirSync(blocked, { recursive: true });
    const pinned = stringify({ "model_catalog_json": join(blocked, "catalog.json") });
    writeFileSync(configPath, pinned);
    chmodSync(blocked, 0o000); // realpathSync raises EACCES -> "unknown"
    try {
      removeCodexDefaultWiring(codexHome);
      expect(readFileSync(configPath, "utf8")).toContain("model_catalog_json");
    } finally {
      chmodSync(blocked, 0o755);
    }
  },
);
