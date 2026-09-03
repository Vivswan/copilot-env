// Registers the copilot-env MCP server in Claude Code's USER-SCOPE server list.
// That list lives in `~/.claude.json` (the file `claude mcp add --scope user`
// writes) -- NOT settings.json, which is why this sits beside but apart from
// src/claude/config.ts. Registration is default-profile-only by nature: the file
// is global to the machine, and the registered entry runs `agent mcp --serve`
// with no `--profile`, so the server resolves the default credential (a named
// profile that wants its own credential registers its own entry by hand).
//
// Everything here is BEST-EFFORT and must never fail the wiring that calls it:
// Claude Code rewrites this file constantly and owns its schema, so a malformed
// or surprising document is warned about and left alone, never clobbered.
import { homedir } from "node:os";
import { join } from "node:path";
import { consola } from "consola";
import { atomicWriteFile } from "../copilot_api/config.ts";
import { MCP_SERVER_NAME } from "../mcp/server.ts";
import { readTextResult } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import { agentLauncherCommand } from "../utils/root.ts";
import { claudeConfigDirOverride } from "./paths.ts";

const logger = consola.withTag("claude.mcp");

/**
 * Whose entry (if any) sits under our name in `mcpServers`:
 *   - absent        -- no entry
 *   - ours-current  -- exactly the launcher invocation this checkout would write
 *   - ours-stale    -- our shape, different path (the checkout moved); safe to
 *                      rewrite or remove
 *   - foreign       -- someone else's `copilot-env` entry; never touched
 */
export type McpRegistrationStatus = "absent" | "ours-current" | "ours-stale" | "foreign";

/**
 * Claude Code's user-scope state file. CLAUDE_CONFIG_DIR relocates it alongside
 * settings.json (version-dependent Claude Code behavior -- true of current
 * releases); the fallback is homedir() ITSELF (not `~/.claude`), deliberately
 * without an $HOME override (Windows resolves %USERPROFILE%, where Claude Code
 * actually reads).
 */
export function claudeJsonPath(): string {
  return join(claudeConfigDirOverride() ?? homedir(), ".claude.json");
}

/** The subcommand argv the managed registration runs (the current shape). */
const CURRENT_MCP_SUBARGS: readonly string[] = ["mcp", "--serve"];

function managedEntry(): Record<string, unknown> {
  const { command, args } = agentLauncherCommand(CURRENT_MCP_SUBARGS);
  return { "type": "stdio", "command": command, "args": args };
}

function sameStrings(a: readonly unknown[], b: readonly string[]): boolean {
  return a.length === b.length && b.every((v, i) => a[i] === v);
}

/** Classify the entry under our name (see McpRegistrationStatus). */
export function classifyMcpEntry(entry: unknown): McpRegistrationStatus {
  if (entry === undefined) return "absent";
  if (!isRecord(entry)) return "foreign";
  // Claude treats a missing type as stdio; anything else is not our shape.
  if (entry.type !== undefined && entry.type !== "stdio") return "foreign";
  const { command, args } = entry;
  if (typeof command !== "string" || !Array.isArray(args)) return "foreign";
  const managed = agentLauncherCommand(CURRENT_MCP_SUBARGS);
  if (command === managed.command && sameStrings(args, managed.args)) return "ours-current";
  if (process.platform === "win32") {
    // Split the managed argv at -File: the flag prefix must match verbatim, the
    // path element must still end in bin/agent.ps1 (a moved checkout, not a
    // foreign tool), and the trailing subargs must be the current shape.
    const fileIdx = managed.args.indexOf("-File");
    const shape = command
      .toLowerCase()
      .replace(/\.exe$/, "")
      .endsWith("powershell") &&
      fileIdx >= 0 &&
      managed.args.slice(0, fileIdx + 1).every((a, i) => args[i] === a) &&
      typeof args[fileIdx + 1] === "string" &&
      /[\\/]bin[\\/]agent\.ps1$/i.test(String(args[fileIdx + 1])) &&
      sameStrings(args.slice(fileIdx + 2), CURRENT_MCP_SUBARGS);
    return shape ? "ours-stale" : "foreign";
  }
  // POSIX: a command that ends in bin/agent (the checkout layout -- a bare
  // `agent` from someone's PATH is NOT claimed) running the current subargs.
  const shape = /[\\/]bin[\\/]agent$/.test(command) && sameStrings(args, CURRENT_MCP_SUBARGS);
  return shape ? "ours-stale" : "foreign";
}

interface ClaudeJsonDoc {
  path: string;
  doc: Record<string, unknown>;
  raw: string;
}

/** Read `.claude.json` (PROVEN-missing/empty -> {}); null = unreadable or
 *  malformed, leave it alone. Absence comes from readTextResult, so a dangling
 *  symlink reads unreadable, never absent: the entry at the path exists, and
 *  writing "back" through {} would replace the user's link with a plain file. */
function loadClaudeJson(): ClaudeJsonDoc | null {
  const path = claudeJsonPath();
  const read = readTextResult(path);
  if (read.kind === "unreadable") {
    logger.warn(`could not read ${path}: ${read.error}`);
    return null;
  }
  const raw = read.kind === "text" ? read.text : "";
  if (raw.trim() === "") return { path, doc: {}, raw };
  try {
    const doc: unknown = JSON.parse(raw);
    if (!isRecord(doc)) throw new Error("not a JSON object");
    return { path, doc, raw };
  } catch {
    logger.warn(`${path} is not valid JSON; leaving it alone (Claude Code owns this file)`);
    return null;
  }
}

/**
 * Write back atomically (the shared atomicWriteFile recipe -- never a torn file),
 * skipping the write when nothing changed byte-for-byte. Claude Code writes this
 * file WITHOUT a trailing newline, so the serialization mirrors whatever
 * convention the source text had -- otherwise the unchanged-skip could never
 * match a file Claude wrote.
 */
function saveClaudeJson(loaded: ClaudeJsonDoc): void {
  const newline = loaded.raw === "" || loaded.raw.endsWith("\n");
  const text = `${JSON.stringify(loaded.doc, null, 2)}${newline ? "\n" : ""}`;
  if (text === loaded.raw) return;
  atomicWriteFile(loaded.path, text);
}

/** What `agent mcp` (status) reports about the registration. */
export interface McpRegistrationInspection {
  /** The `.claude.json` path inspected. */
  path: string;
  /** Entry classification, or "unreadable" when the file could not be read/parsed. */
  status: McpRegistrationStatus | "unreadable";
}

/** Read-only registration lookup for the status command; never creates the file. */
export function inspectMcpRegistration(): McpRegistrationInspection {
  const path = claudeJsonPath();
  const loaded = loadClaudeJson(); // already warns on unreadable/malformed
  if (loaded === null) return { path, status: "unreadable" };
  const servers = loaded.doc.mcpServers;
  const entry = isRecord(servers) ? servers[MCP_SERVER_NAME] : undefined;
  return { path, status: classifyMcpEntry(entry) };
}

/**
 * Ensure the managed `copilot-env` entry is registered. Returns true when the
 * entry is in place (freshly written or already current) -- the caller gates the
 * WebSearch deny on that, so a machine is never left denied without a server.
 */
export function registerClaudeMcpServer(): boolean {
  const loaded = loadClaudeJson();
  if (loaded === null) return false;
  const servers = loaded.doc.mcpServers ?? {};
  if (!isRecord(servers)) {
    logger.warn(`${loaded.path} has a non-object mcpServers; leaving it alone`);
    return false;
  }
  switch (classifyMcpEntry(servers[MCP_SERVER_NAME])) {
    case "ours-current":
      return true;
    case "foreign":
      logger.warn(
        `${loaded.path} already has a '${MCP_SERVER_NAME}' MCP server that is not ours; leaving it alone`,
      );
      return false;
    case "absent":
    case "ours-stale":
      break;
  }
  servers[MCP_SERVER_NAME] = managedEntry();
  loaded.doc.mcpServers = servers;
  try {
    saveClaudeJson(loaded);
  } catch (e) {
    logger.warn(`could not write ${loaded.path}: ${String(e)}`);
    return false;
  }
  return true;
}

/**
 * Remove the managed entry (ours-current or ours-stale only); foreign survives.
 * Returns true when NO managed entry remains (removed, or none was there); false
 * when a foreign entry was left in place or the write failed.
 */
export function removeClaudeMcpRegistration(): boolean {
  const loaded = loadClaudeJson();
  if (loaded === null) return false;
  const servers = loaded.doc.mcpServers;
  if (!isRecord(servers)) return true;
  const status = classifyMcpEntry(servers[MCP_SERVER_NAME]);
  if (status === "absent") return true;
  if (status === "foreign") return false;
  delete servers[MCP_SERVER_NAME];
  if (Object.keys(servers).length === 0) delete loaded.doc.mcpServers;
  try {
    saveClaudeJson(loaded);
  } catch (e) {
    logger.warn(`could not write ${loaded.path}: ${String(e)}`);
    return false;
  }
  return true;
}
