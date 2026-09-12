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
import { readCodexToml, saveCodexToml } from "../src/codex/toml_io.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

// --- readCodexToml variants -----------------------------------------------------

test("readCodexToml: a missing file reads as absent", () => {
  dir = tempDir("codex-toml-io-");
  expect(readCodexToml(join(dir, "config.toml"))).toEqual({ kind: "absent" });
});

test("readCodexToml: valid TOML reads as ok with the parsed document", () => {
  dir = tempDir("codex-toml-io-");
  const path = join(dir, "config.toml");
  writeFileSync(path, ['model_provider = "copilot-env"', "", "[t]", 'k = "v"', ""].join("\n"));
  const read = readCodexToml(path);
  expect(read.kind).toBe("ok");
  if (read.kind !== "ok") throw new Error("expected ok");
  expect(read.doc.model_provider).toBe("copilot-env");
  expect(read.doc.t).toEqual({ "k": "v" });
});

test("readCodexToml: a file that exists but is not TOML reads as unparseable", () => {
  dir = tempDir("codex-toml-io-");
  const path = join(dir, "config.toml");
  writeFileSync(path, 'command = "unbalanced\n');
  const read = readCodexToml(path);
  expect(read.kind).toBe("unparseable");
  if (read.kind !== "unparseable") throw new Error("expected unparseable");
  expect(read.error.length).toBeGreaterThan(0);
});

test("readCodexToml: an empty or whitespace-only file reads as absent", () => {
  // The seed-a-default site (loadOrCreateConfig) treats an empty file like a missing one.
  dir = tempDir("codex-toml-io-");
  const path = join(dir, "config.toml");
  writeFileSync(path, "");
  expect(readCodexToml(path)).toEqual({ kind: "absent" });
  writeFileSync(path, "  \n\t\r\n");
  expect(readCodexToml(path)).toEqual({ kind: "absent" });
});

test("readCodexToml: blank-LOOKING content the parser rejects reads as unparseable, not absent", () => {
  // A BOM, NBSP, or lone CR is trim()-blank but smol-toml rejects it; classifying
  // it "absent" would let write paths clobber a file that exists and did not parse.
  dir = tempDir("codex-toml-io-");
  const path = join(dir, "config.toml");
  for (const content of ["\ufeff", "\u00a0", "\r", " \r "]) {
    writeFileSync(path, content);
    expect(readCodexToml(path).kind).toBe("unparseable");
  }
});

test("readCodexToml: a comment-only file reads as ok with an empty document, not absent", () => {
  // Non-blank but key-less content is real user text: it must NOT trigger the
  // absent path (which would seed the default template over it at site 1).
  dir = tempDir("codex-toml-io-");
  const path = join(dir, "config.toml");
  writeFileSync(path, "# my notes\n# more notes\n");
  expect(readCodexToml(path)).toEqual({ kind: "ok", doc: {} });
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

test("saveCodexToml: round-trips through readCodexToml and writes smol-toml's exact bytes", () => {
  dir = tempDir("codex-toml-io-");
  const path = join(dir, "config.toml");
  const doc = {
    "model_provider": "copilot-env",
    "model_providers": { "copilot-env": { "base_url": "http://localhost:4141/v1" } },
  };
  saveCodexToml(path, doc);
  // Byte-identical to a direct stringify: the shared writer adds no formatting of its own.
  expect(readFileSync(path, "utf8")).toBe(stringify(doc));
  expect(readCodexToml(path)).toEqual({ kind: "ok", doc });
});

test("saveCodexToml: a write error propagates to the caller", () => {
  // Each call site's own error handling (throw, or an outer swallow) stays in charge.
  dir = tempDir("codex-toml-io-");
  const asDir = join(dir, "config.toml");
  mkdirSync(asDir);
  expect(() => saveCodexToml(asDir, { "k": "v" })).toThrow();
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
    configureCodexConfig(codexHome, { mode: "proxy", baseUrl: "http://localhost:4141/v1" })
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
    configureCodexConfig(codexHome, { mode: "proxy", baseUrl: "http://localhost:4141/v1" })
  );
  expect((rawError as NodeJS.ErrnoException).code).toBe("EISDIR");
});

test("policy: syncCodexCatalogReference swallows an unparseable config, file preserved", () => {
  dir = isolateAgentHomes("codex-toml-io-", { mkdirs: true }).dir;
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  // Reach the config read: catalog enabled AND a usable generated file.
  new CopilotEnvConfig().set({ codexModelCatalog: true });
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

test("policy: removeCodexProfile is a no-op when absent, throws wrapped on unparseable", () => {
  dir = isolateAgentHomes("codex-toml-io-", { mkdirs: true }).dir;
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");

  // Absent: nothing to remove, and no config is ever created.
  expect(() => removeCodexProfile(codexHome, parseProfileName("work"))).not.toThrow();
  expect(existsSync(configPath)).toBe(false);

  // Unparseable: never blind-write over a config we could not read. The exact
  // wrapped message up to the parser's own text (path included).
  writeFileSync(configPath, UNPARSEABLE);
  const wrapped = capture(() => removeCodexProfile(codexHome, parseProfileName("work")));
  expect((wrapped as Error).message.startsWith(`${configPath} is not readable/valid TOML: `)).toBe(
    true,
  );
  expect(readFileSync(configPath, "utf8")).toBe(UNPARSEABLE);

  // A non-ENOENT read error (config.toml is a directory) gets the same wrap.
  rmSync(configPath);
  mkdirSync(configPath);
  const dirWrapped = capture(() => removeCodexProfile(codexHome, parseProfileName("work")));
  expect(
    (dirWrapped as Error).message.startsWith(`${configPath} is not readable/valid TOML: `),
  ).toBe(true);
});

test("policy: removeCodexDefaultWiring skips an absent config and never blind-writes", () => {
  dir = isolateAgentHomes("codex-toml-io-", { mkdirs: true }).dir;
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");
  const envPath = join(codexHome, ".env");
  writeFileSync(envPath, "OPENAI_API_KEY=user\n");

  // Absent config: nothing to strip, nothing created, the user's .env untouched.
  removeCodexDefaultWiring(codexHome);
  expect(existsSync(configPath)).toBe(false);
  expect(readFileSync(envPath, "utf8")).toBe("OPENAI_API_KEY=user\n");

  // Unparseable config: throws wrapped (exact prefix, path included), file preserved.
  writeFileSync(configPath, UNPARSEABLE);
  const wrapped = capture(() => removeCodexDefaultWiring(codexHome));
  expect((wrapped as Error).message.startsWith(`${configPath} is not readable/valid TOML: `)).toBe(
    true,
  );
  expect(readFileSync(configPath, "utf8")).toBe(UNPARSEABLE);

  // A non-ENOENT read error (config.toml is a directory) gets the same wrap.
  rmSync(configPath);
  mkdirSync(configPath);
  const dirWrapped = capture(() => removeCodexDefaultWiring(codexHome));
  expect(
    (dirWrapped as Error).message.startsWith(`${configPath} is not readable/valid TOML: `),
  ).toBe(true);
  expect(readFileSync(envPath, "utf8")).toBe("OPENAI_API_KEY=user\n");
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
