#!/usr/bin/env -S npx tsx
/**
 * Create or refresh a host-local CODEX_HOME wired to the local copilot-api gateway.
 *
 * Per-host dir under ~/.codex/hosts/<host>, shared-state symlink farm, file
 * seeding, plus the config.toml managed-section logic.
 * Port/API key are read from copilot-api's own data dir.
 *
 * USAGE:
 *     codex-home [--symlink-farm] [--codex-home <path>] [--hostname-path] [--help]
 *
 * By default it does a config-only update (writes config.toml/.env at the
 * resolved CODEX_HOME). Pass --symlink-farm for the full per-host symlink farm.
 *
 * OUTPUT:
 *     On success, prints only the resolved CODEX_HOME path to stdout.
 *     Status, warnings, and errors go to stderr.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defineCommand, runMain } from "citty";
import { createConsola } from "consola";
import { execaSync } from "execa";
import { parse, stringify } from "smol-toml";
import which from "which";

import { CopilotApiConfig } from "./utils/config.ts";
import { getSanitizedHostname, HOME } from "./utils/hostname.ts";
import { copilotApiResolvePort } from "./utils/port.ts";

const logger = createConsola({ stdout: process.stderr, stderr: process.stderr });

// The per-host CODEX_HOME (~/.codex/hosts/<hostname>). Only used for the
// --hostname-path / --symlink-farm flows, which are Linux-only (they build/inspect
// the shared-state symlink farm used on the Linux fleet). Plain config.toml/.env
// updates target the standard ~/.codex on every platform instead.
function getHostLocalCodexHome(): string {
  return `${HOME}/.codex/hosts/${getSanitizedHostname()}`;
}

function assertLinux(feature: string, hint?: string): void {
  if (process.platform !== "linux") {
    throw new Error(
      `${feature} is only supported on Linux (this is ${process.platform}).${hint ? ` ${hint}` : ""}`,
    );
  }
}

// --- small fs helpers ------------------------------------------------------

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function readlinkOrEmpty(p: string): string {
  try {
    return fs.readlinkSync(p);
  } catch {
    return "";
  }
}

function filesEqual(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function isSymlinkPath(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirPath(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFilePath(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function statSize(p: string): number {
  return fs.statSync(p).size;
}

function shutilMove(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "EXDEV") {
      fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
}

// Walk root one level at a time (mirrors `find -mindepth 1` with
// follow_symlinks=False: symlinks to dirs are not descended).
function findMindepth1(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dirpath = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirpath, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirnames: string[] = [];
    const filenames: string[] = [];
    for (const entry of entries) {
      const isDir = !entry.isSymbolicLink() && entry.isDirectory();
      (isDir ? dirnames : filenames).push(entry.name);
    }
    for (const name of dirnames) results.push(path.join(dirpath, name));
    for (const name of filenames) results.push(path.join(dirpath, name));
    for (const name of dirnames) stack.push(path.join(dirpath, name));
  }
  return results;
}

// Merge-copy contents of localPath into sharedPath, preserving symlinks.
function cpPrMerge(localPath: string, sharedPath: string): void {
  const entries = fs.readdirSync(localPath, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(localPath, entry.name);
    const dst = path.join(sharedPath, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(src);
      if (lexists(dst)) {
        const dstIsSymlink = isSymlinkPath(dst);
        const dstIsDir = isDirPath(dst);
        if (dstIsSymlink || !dstIsDir) {
          fs.unlinkSync(dst);
        }
      }
      fs.symlinkSync(target, dst);
    } else if (entry.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

// === section: CODEX_HOME symlink farm (seeding) ===

function warnExistingCodexPath(p: string): void {
  logger.warn(`Warning: Leaving existing Codex path unchanged: ${p}`);
}

function ensureCodexPathParent(p: string): number {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch {
    return 1;
  }
  return 0;
}

// Promote a host-local directory into the shared Codex root when it can be
// merged without overwriting existing shared content.
// Returns:
//   0 when promotion succeeded or no promotion was needed
//   1 on an unexpected filesystem error
//   2 when the directory contains conflicting content and is left unchanged
function promoteCodexDirToSharedIfSafe(localPath: string, sharedPath: string): number {
  if (!isDirPath(localPath)) return 0;

  if (!lexists(sharedPath)) {
    if (ensureCodexPathParent(sharedPath) !== 0) return 1;
    try {
      shutilMove(localPath, sharedPath);
    } catch {
      return 1;
    }
    return 0;
  }

  if (isSymlinkPath(sharedPath) || !isDirPath(sharedPath)) {
    warnExistingCodexPath(localPath);
    return 2;
  }

  for (const entry of findMindepth1(localPath)) {
    const prefix = `${localPath}/`;
    const relPath = entry.startsWith(prefix) ? entry.slice(prefix.length) : entry;
    const targetPath = `${sharedPath}/${relPath}`;

    if (isSymlinkPath(entry)) {
      const localTarget = readlinkOrEmpty(entry);
      if (isSymlinkPath(targetPath)) {
        if (localTarget !== readlinkOrEmpty(targetPath)) {
          warnExistingCodexPath(localPath);
          return 2;
        }
      } else if (lexists(targetPath)) {
        warnExistingCodexPath(localPath);
        return 2;
      }
    } else if (isDirPath(entry)) {
      if (lexists(targetPath) && (isSymlinkPath(targetPath) || !isDirPath(targetPath))) {
        warnExistingCodexPath(localPath);
        return 2;
      }
    } else if (isFilePath(entry)) {
      if (lexists(targetPath)) {
        if (
          isSymlinkPath(targetPath) ||
          !isFilePath(targetPath) ||
          !filesEqual(entry, targetPath)
        ) {
          warnExistingCodexPath(localPath);
          return 2;
        }
      }
    } else {
      warnExistingCodexPath(localPath);
      return 2;
    }
  }

  // Note: TOCTOU race exists between validation above and the copy/remove
  // below if another process modifies either directory concurrently. This
  // symlink-farm flow runs during startup and accepts that trade-off.
  try {
    cpPrMerge(localPath, sharedPath);
  } catch {
    return 1;
  }
  try {
    fs.rmSync(localPath, { recursive: true, force: true });
  } catch {
    return 1;
  }
  return 0;
}

function primeSharedCodexHomeIfMissing(sharedRoot: string): void {
  if (lexists(sharedRoot)) return;
  if (which.sync("codex", { nothrow: true }) === null) return;

  // Best effort: let Codex create its default shared home before we seed and
  // symlink into it. Timeout prevents a misconfigured codex from blocking.
  try {
    execaSync("codex", ["exec"], {
      input: "hi\n",
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 10_000,
    });
  } catch {
    // pass
  }
}

function seedLocalCodexFileIfMissing(localPath: string, sharedPath: string): number {
  if (lexists(localPath)) {
    if (isSymlinkPath(localPath)) {
      logger.info(
        `Warning: Skipping local Codex seed because the path already exists as a symlink: ${localPath}`,
      );
    }
    return 0;
  }

  if (ensureCodexPathParent(localPath) !== 0) return 1;
  try {
    if (isFilePath(sharedPath)) {
      fs.copyFileSync(sharedPath, localPath);
    } else {
      fs.writeFileSync(localPath, "");
    }
  } catch {
    return 1;
  }
  return 0;
}

function seedSharedCodexFileIfMissingImpl(
  sharedPath: string,
  localPath: string,
  createPlaceholder: boolean,
): number {
  const sharedExists = lexists(sharedPath);

  if (isFilePath(localPath) && !isSymlinkPath(localPath)) {
    if (!sharedExists) {
      if (ensureCodexPathParent(sharedPath) !== 0) return 1;
      try {
        fs.copyFileSync(localPath, sharedPath);
      } catch {
        return 1;
      }
      return 0;
    }

    if (isFilePath(sharedPath) && statSize(sharedPath) === 0 && statSize(localPath) > 0) {
      try {
        fs.copyFileSync(localPath, sharedPath);
      } catch {
        return 1;
      }
    }
    return 0;
  }

  if (createPlaceholder && !sharedExists) {
    if (ensureCodexPathParent(sharedPath) !== 0) return 1;
    try {
      fs.writeFileSync(sharedPath, "");
    } catch {
      return 1;
    }
  }
  return 0;
}

// Shared desktop state files need a one-time promotion path from host-local
// CODEX_HOME into ~/.codex so existing installs keep their saved projects.
function seedSharedCodexFileIfMissing(sharedPath: string, localPath: string): number {
  return seedSharedCodexFileIfMissingImpl(sharedPath, localPath, true);
}

// Some shared state is only worth syncing when present.
function seedSharedCodexOptionalFileIfMissing(sharedPath: string, localPath: string): number {
  return seedSharedCodexFileIfMissingImpl(sharedPath, localPath, false);
}

function ensureCodexDirSymlink(localPath: string, sharedPath: string): number {
  if (isSymlinkPath(localPath)) {
    if (readlinkOrEmpty(localPath) === sharedPath) return 0;
    warnExistingCodexPath(localPath);
    return 0;
  }

  if (isDirPath(localPath)) {
    const rc = promoteCodexDirToSharedIfSafe(localPath, sharedPath);
    if (rc === 2) return 0;
    if (rc !== 0) return 1;
  } else if (lexists(localPath)) {
    warnExistingCodexPath(localPath);
    return 0;
  }

  if (!lexists(localPath)) {
    if (ensureCodexPathParent(localPath) !== 0) return 1;
    try {
      fs.symlinkSync(sharedPath, localPath);
    } catch {
      return 1;
    }
  }
  return 0;
}

// After the shared file is seeded, replace a matching host-local copy with a
// symlink so future desktop updates read and write the same shared state.
function ensureCodexFileSymlink(localPath: string, sharedPath: string): number {
  if (isSymlinkPath(localPath)) {
    if (readlinkOrEmpty(localPath) === sharedPath) return 0;
    warnExistingCodexPath(localPath);
    return 0;
  }

  if (isFilePath(localPath)) {
    if (filesEqual(localPath, sharedPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch {
        return 1;
      }
    } else {
      warnExistingCodexPath(localPath);
      return 0;
    }
  } else if (lexists(localPath)) {
    warnExistingCodexPath(localPath);
    return 0;
  }

  if (ensureCodexPathParent(localPath) !== 0) return 1;
  try {
    fs.symlinkSync(sharedPath, localPath);
  } catch {
    return 1;
  }
  return 0;
}

export function buildCodexSymlinkFarm(codexHome?: string | null): number {
  const localDirs = [
    ".tmp", // Host-local scratch/cache state, including plugin temp data.
    "log", // Host-local runtime logs.
    "tmp", // Host-local transient working files.
  ];
  const sharedDirs = [
    "ambient-suggestions", // Background suggestion state surfaced by Codex.
    "archived_sessions", // Older conversation transcripts kept by the desktop app.
    "memories", // Long-term memory state.
    "memories_extensions", // Extension-generated memory enrichments.
    "plugins", // Installed plugins and their persistent data.
    "rules", // Synced Codex rules and instructions.
    "sessions", // Active conversation transcripts.
    "shell_snapshots", // Reusable shell context captured by Codex.
    "skills", // Installed skills available to Codex.
    "vendor_imports", // Imported third-party agent bundles.
    "worktrees", // Shared worktree metadata used across checkouts.
  ];
  const sharedFiles = [
    ".codex-global-state.json", // Desktop workspace and project state.
    "AGENTS.md", // Shared agent instructions exposed inside Codex home.
    "session_index.jsonl", // Session lookup index maintained by the desktop app.
    "version.json", // Codex home layout/schema version marker.
  ];

  if (!codexHome) codexHome = getHostLocalCodexHome();

  const sharedRoot = `${HOME}/.codex`;
  primeSharedCodexHomeIfMissing(sharedRoot);
  try {
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
  } catch {
    return 1;
  }

  for (const localDir of localDirs) {
    try {
      fs.mkdirSync(`${codexHome}/${localDir}`, { recursive: true });
    } catch {
      return 1;
    }
  }

  if (
    seedLocalCodexFileIfMissing(
      `${codexHome}/.personality_migration`,
      `${sharedRoot}/.personality_migration`,
    ) !== 0
  )
    return 1;
  if (seedLocalCodexFileIfMissing(`${codexHome}/config.toml`, `${sharedRoot}/config.toml`) !== 0)
    return 1;
  if (
    seedLocalCodexFileIfMissing(`${codexHome}/history.jsonl`, `${sharedRoot}/history.jsonl`) !== 0
  )
    return 1;

  for (const sharedDir of sharedDirs) {
    try {
      fs.mkdirSync(`${sharedRoot}/${sharedDir}`, { recursive: true });
    } catch {
      return 1;
    }
    if (ensureCodexDirSymlink(`${codexHome}/${sharedDir}`, `${sharedRoot}/${sharedDir}`) !== 0)
      return 1;
  }

  for (const sharedFile of sharedFiles) {
    if (
      seedSharedCodexFileIfMissing(`${sharedRoot}/${sharedFile}`, `${codexHome}/${sharedFile}`) !==
      0
    )
      return 1;
    if (ensureCodexFileSymlink(`${codexHome}/${sharedFile}`, `${sharedRoot}/${sharedFile}`) !== 0)
      return 1;
  }

  if (
    seedSharedCodexOptionalFileIfMissing(
      `${sharedRoot}/installation_id`,
      `${codexHome}/installation_id`,
    ) !== 0
  )
    return 1;
  if (ensureCodexFileSymlink(`${codexHome}/installation_id`, `${sharedRoot}/installation_id`) !== 0)
    return 1;

  if (
    seedSharedCodexOptionalFileIfMissing(
      `${sharedRoot}/shell-init.sh`,
      `${codexHome}/shell-init.sh`,
    ) !== 0
  )
    return 1;
  if (ensureCodexFileSymlink(`${codexHome}/shell-init.sh`, `${sharedRoot}/shell-init.sh`) !== 0)
    return 1;

  return 0;
}

// === section: config.toml management ===
//
// Load-mutate-stringify so user-added keys/sections survive. smol-toml does
// NOT preserve comments or whitespace formatting — TS has no battle-tested
// equivalent of Python's tomlkit. Unknown top-level keys are preserved.

const DEFAULT_CONFIG = `\
model_provider = "copilot-api"

[model_providers.copilot-api]
name = "copilot-api gateway"
base_url = "{base_url}"
env_key = "COPILOT_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[analytics]
enabled = false

[feedback]
enabled = false
`;

function formatDefaultConfig(baseUrl: string): string {
  return DEFAULT_CONFIG.replace("{base_url}", baseUrl);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Load existing config (preferring shared, then host-local), or fall back to
// the default template. Failures to parse fall through to the next source.
function loadOrCreateConfig(
  sharedConfig: string,
  hostConfig: string,
  baseUrl: string,
): Record<string, unknown> {
  for (const source of [sharedConfig, hostConfig]) {
    try {
      if (fs.statSync(source).isFile()) {
        return parse(fs.readFileSync(source, "utf8")) as Record<string, unknown>;
      }
    } catch {
      // try next source
    }
  }
  return parse(formatDefaultConfig(baseUrl)) as Record<string, unknown>;
}

export function configureCodexConfig(
  baseUrl: string,
  apiKey: string,
  codexHome?: string | null,
): number {
  const home = process.env.HOME || HOME;
  codexHome = codexHome || process.env.CODEX_HOME || `${home}/.codex`;

  if (!baseUrl) {
    logger.warn("Warning: base_url not provided, skipping Codex config");
    return 1;
  }

  if (!/^[A-Za-z0-9:/._-]+$/.test(baseUrl)) {
    logger.error("Error: base_url contains invalid characters");
    return 1;
  }

  try {
    fs.mkdirSync(codexHome, { recursive: true });
  } catch {
    logger.warn(`Warning: Could not create Codex config directory: ${codexHome}`);
    return 1;
  }

  const sharedConfig = `${home}/.codex/config.toml`;
  const hostConfig = `${codexHome}/config.toml`;

  let doc = loadOrCreateConfig(sharedConfig, hostConfig, baseUrl);

  // Surgically set model_providers."copilot-api".base_url, replacing the
  // whole document only when our managed provider section is absent.
  const providers = doc.model_providers;
  if (!isRecord(providers) || !isRecord(providers["copilot-api"])) {
    doc = parse(formatDefaultConfig(baseUrl)) as Record<string, unknown>;
  } else {
    (providers["copilot-api"] as Record<string, unknown>).base_url = baseUrl;
  }

  fs.writeFileSync(hostConfig, stringify(doc));
  logger.info(`Codex App config written to ${hostConfig}`);

  const envFile = `${codexHome}/.env`;
  fs.writeFileSync(envFile, `COPILOT_API_KEY=${apiKey}\n`);
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    // pass
  }

  return 0;
}

// === section: CLI entry point ===

const main = defineCommand({
  meta: {
    name: "codex-home",
    description:
      "Create or refresh a host-local CODEX_HOME wired to the local copilot-api gateway. " +
      "On success, prints only the resolved CODEX_HOME path to stdout.",
  },
  args: {
    "hostname-path": {
      type: "boolean",
      default: false,
      description:
        "Resolve and print the per-host CODEX_HOME path (~/.codex/hosts/<hostname>; Linux-only, " +
        "or --codex-home if given) only; no symlink farm, no config writes.",
    },
    "symlink-farm": {
      type: "boolean",
      default: false,
      description:
        "Build the full per-host symlink farm (symlink farm + shared-state seeding) before " +
        "writing config. Without it, the default is a config-only update (write " +
        "config.toml/.env, no symlink farm).",
    },
    "codex-home": {
      type: "string",
      description:
        "CODEX_HOME path to operate on. Default: ~/.codex (%USERPROFILE%\\.codex on Windows) " +
        "for config writes; ~/.codex/hosts/<hostname> for --hostname-path / --symlink-farm (Linux).",
    },
    "base-url": {
      type: "string",
      description: "Base URL for the copilot-api gateway (e.g. http://localhost:4141/v1).",
    },
    "api-key": {
      type: "string",
      description: "API key for the copilot-api gateway.",
    },
  },
  async run({ args }) {
    const codexHomeArg = args["codex-home"] as string | undefined;
    // The per-host ~/.codex/hosts/<hostname> dir is used ONLY for --hostname-path
    // and --symlink-farm (both Linux-only). Every other (config-only) run targets
    // the standard ~/.codex / %USERPROFILE%\.codex on all platforms. An explicit
    // --codex-home always overrides.
    const useHostLocal = Boolean(args["hostname-path"] || args["symlink-farm"]);
    let codexHomePath: string;
    if (codexHomeArg) {
      codexHomePath = codexHomeArg;
    } else if (useHostLocal) {
      assertLinux("The per-host CODEX_HOME (~/.codex/hosts/<hostname>)");
      codexHomePath = getHostLocalCodexHome();
    } else {
      codexHomePath = path.join(HOME, ".codex");
    }

    // Resolve-only mode: print the host-local CODEX_HOME path and exit. No
    // symlink farm or config writes, so callers can use this to seed
    // CODEX_HOME cheaply (e.g. eager export on shell startup).
    if (args["hostname-path"]) {
      process.stdout.write(`${codexHomePath}\n`);
      return;
    }

    // Config-only is the default: (re)write config.toml/.env at the resolved
    // CODEX_HOME. --symlink-farm first lays down the full symlink farm +
    // shared-state seeding; configureCodexConfig below creates the dir either way.
    if (args["symlink-farm"]) {
      assertLinux("The CODEX_HOME symlink farm (--symlink-farm)");
      logger.info("Preparing CODEX_HOME (building symlink farm)...");
      if (buildCodexSymlinkFarm(codexHomePath) !== 0) {
        throw new Error("Failed to build the CODEX_HOME symlink farm");
      }
    }

    let baseUrl = args["base-url"] as string | undefined;
    let apiKey = args["api-key"] as string | undefined;
    if (!baseUrl) {
      const port = copilotApiResolvePort();
      baseUrl = `http://localhost:${port}/v1`;
    }
    if (!apiKey) {
      try {
        apiKey = new CopilotApiConfig().ensureApiKey();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`failed to persist auth token: ${msg}`);
      }
    }
    if (configureCodexConfig(baseUrl, apiKey, codexHomePath) !== 0) {
      throw new Error("Codex config write failed");
    }

    process.stdout.write(`${codexHomePath}\n`);
  },
});

if (import.meta.main) {
  runMain(main).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    // Set exitCode (not process.exit) so pending stderr writes flush.
    process.exitCode = 1;
  });
}
