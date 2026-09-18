// Registers the copilot-env MCP server in Claude Code's USER-SCOPE list, `~/.claude.json` (what
// `claude mcp add --scope user` writes), NOT settings.json: hence beside but apart from config.ts.
// Claude Code rewrites this file constantly and owns its schema, so a surprising document is warned
// about and left alone, never clobbered.
//   machine-global file, `agent mcp --serve` without `--profile` -> default profile only; a named
//                                                                  profile registers by hand
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { taggedLogger } from "../utils/logger.ts";
import { applyPatch, type PatchOp, planPatch, remove, set } from "../agents/write_plan.ts";
import { atomicWriteFile } from "../utils/report_write.ts";
import { MCP_SERVER_NAME } from "../mcp/server.ts";
import { resolveExecutablePath } from "../utils/command.ts";
import { isRecord } from "../utils/json.ts";
import { agentLauncherCommand } from "../utils/root.ts";
import { type FilePlan, readPlannedText, textVerdict } from "../utils/write_session.ts";
import { claudeConfigDirOverride } from "./paths.ts";

const logger = taggedLogger("claude.mcp");

/** Whose entry sits under our name in `mcpServers`.
 *    absent        -> no entry
 *    ours-current  -> exactly the launcher invocation this checkout would write
 *    ours-stale    -> our shape, different path (the checkout moved); safe to rewrite or remove
 *    foreign       -> someone else's `copilot-env` entry; never touched */
export type McpRegistrationStatus = "absent" | "ours-current" | "ours-stale" | "foreign";

/** CLAUDE_CONFIG_DIR relocates it alongside settings.json (true of current Claude Code releases).
 *  The fallback is homedir() ITSELF, not `~/.claude`, and without an $HOME override: Windows
 *  resolves %USERPROFILE%, where Claude Code reads. */
export function claudeJsonPath(): string {
  return join(claudeConfigDirOverride() ?? homedir(), ".claude.json");
}

const CURRENT_MCP_SUBARGS: readonly string[] = ["mcp", "--serve"];

/** MCP clients start servers with a minimal environment and the gh-cli credential needs `gh`, so
 *  gh's directory goes in front of Claude Code's `${PATH}` expansion (nothing the client had is
 *  lost). Undefined when gh is not on PATH at wiring time. */
export function serverPathEnv(ghPath: string | null): { PATH: string } | undefined {
  return ghPath === null ? undefined : { PATH: `${dirname(ghPath)}${delimiter}\${PATH}` };
}

/** When gh does not resolve from THIS process (a wiring pass started with a minimal PATH), the env
 *  already recorded in `previous` is kept: a rewrite never downgrades a working registration. */
function managedEntry(ghPath: string | null, previous?: unknown): Record<string, unknown> {
  const { command, args } = agentLauncherCommand(CURRENT_MCP_SUBARGS);
  const recorded = isRecord(previous) && isRecord(previous.env) ? previous.env : undefined;
  const env = serverPathEnv(ghPath) ?? recorded;
  return { "type": "stdio", "command": command, "args": args, ...(env ? { env } : {}) };
}

function sameStrings(a: readonly unknown[], b: readonly string[]): boolean {
  return a.length === b.length && b.every((v, i) => a[i] === v);
}

/** `ghPath` null means gh is unknown HERE, so a recorded env is taken as current rather than stale.
 */
export function classifyMcpEntry(
  entry: unknown,
  ghPath: string | null = resolveExecutablePath("gh"),
): McpRegistrationStatus {
  if (entry === undefined) return "absent";
  if (!isRecord(entry)) return "foreign";
  // Claude treats a missing type as stdio; anything else is not our shape.
  if (entry.type !== undefined && entry.type !== "stdio") return "foreign";
  const { command, args } = entry;
  if (typeof command !== "string" || !Array.isArray(args)) return "foreign";
  const managed = agentLauncherCommand(CURRENT_MCP_SUBARGS);
  const wanted = serverPathEnv(ghPath);
  const sameEnv = wanted === undefined ||
    JSON.stringify(entry.env ?? null) === JSON.stringify(wanted);
  if (command === managed.command && sameStrings(args, managed.args) && sameEnv) {
    return "ours-current";
  }
  if (process.platform === "win32") {
    // Split at -File: the flag prefix must match verbatim, the path must still end in bin/agent.ps1
    // (a moved checkout, not a foreign tool), and the trailing subargs must be the current shape.
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
  // POSIX: a command ending in bin/agent (the checkout layout); a bare `agent` from someone's PATH
  // is NOT claimed.
  const shape = /[\\/]bin[\\/]agent$/.test(command) && sameStrings(args, CURRENT_MCP_SUBARGS);
  return shape ? "ours-stale" : "foreign";
}

interface ClaudeJsonDoc {
  path: string;
  doc: Record<string, unknown>;
  raw: string;
  /** False when no file exists (raw is then ""); a present-but-blank file is true. */
  exists: boolean;
}

/** Null (unreadable or malformed) means leave it alone. Absence comes from readTextResult, so a
 *  dangling symlink reads unreadable, never absent: the entry at the path exists, and writing
 *  "back" through {} would replace the user's link with a plain file. */
function loadClaudeJson(): ClaudeJsonDoc | null {
  const path = claudeJsonPath();
  const read = readPlannedText(path);
  if (read.kind === "unreadable") {
    logger.warn(`could not read ${path}: ${read.error}`);
    return null;
  }
  const exists = read.kind === "text";
  const raw = read.kind === "text" ? read.text : "";
  if (raw.trim() === "") return { path, doc: {}, raw, exists };
  try {
    const doc: unknown = JSON.parse(raw);
    if (!isRecord(doc)) throw new Error("not a JSON object");
    return { path, doc, raw, exists };
  } catch {
    logger.warn(`${path} is not valid JSON; leaving it alone (Claude Code owns this file)`);
    return null;
  }
}

/** Claude Code writes this file WITHOUT a trailing newline, so the serialization mirrors the source
 *  text's convention; otherwise the unchanged-skip could never match a file Claude wrote. */
function claudeJsonText(loaded: ClaudeJsonDoc, doc: Record<string, unknown>): string {
  const newline = loaded.raw === "" || loaded.raw.endsWith("\n");
  return `${JSON.stringify(doc, null, 2)}${newline ? "\n" : ""}`;
}

/** The patch as one file plan plus the step that lands it; a byte-identical result is not
 *  rewritten. The step returns false (after warning) when the write failed. */
function planClaudeJsonPatch(loaded: ClaudeJsonDoc, ops: readonly PatchOp[]): McpWritePlan {
  const attributes = planPatch(loaded.doc, ops);
  const text = claudeJsonText(loaded, applyPatch(structuredClone(loaded.doc), ops));
  return {
    files: [{
      path: loaded.path,
      verdict: textVerdict(loaded.exists ? loaded.raw : null, text),
      attributes,
      before: loaded.exists ? loaded.raw : null,
      content: text,
    }],
    apply() {
      if (text === loaded.raw) return true;
      try {
        atomicWriteFile(loaded.path, text);
      } catch (e) {
        logger.warn(`could not write ${loaded.path}: ${String(e)}`);
        return false;
      }
      return true;
    },
  };
}

/** A `.claude.json` write, computed: `apply` returns what the eager function it replaces returned. */
export interface McpWritePlan {
  files: FilePlan[];
  apply(): boolean;
}

/** The registration, computed. `inPlace` predicts the apply's answer (the entry will be in place
 *  unless the write itself fails), so a caller can plan what it gates on that before writing. */
export interface McpRegistrationPlan extends McpWritePlan {
  inPlace: boolean;
}

const LEFT_ALONE: McpRegistrationPlan = { inPlace: false, files: [], apply: () => false };

/** What `agent mcp` (status) reports about the registration. */
export interface McpRegistrationInspection {
  path: string;
  /** "unreadable" when the file could not be read or parsed. */
  status: McpRegistrationStatus | "unreadable";
}

/** Never creates the file. */
export function inspectMcpRegistration(): McpRegistrationInspection {
  const path = claudeJsonPath();
  const loaded = loadClaudeJson(); // already warns on unreadable/malformed
  if (loaded === null) return { path, status: "unreadable" };
  const servers = loaded.doc.mcpServers;
  const entry = isRecord(servers) ? servers[MCP_SERVER_NAME] : undefined;
  return { path, status: classifyMcpEntry(entry) };
}

/** The entry in place (freshly written, or already current: then the plan states the entry it
 *  keeps); the caller gates the WebSearch deny on that, so a machine is never left denied without
 *  a server. */
export function planClaudeMcpRegistration(
  ghPath: string | null = resolveExecutablePath("gh"),
): McpRegistrationPlan {
  const loaded = loadClaudeJson();
  if (loaded === null) return LEFT_ALONE;
  const servers = loaded.doc.mcpServers ?? {};
  if (!isRecord(servers)) {
    logger.warn(`${loaded.path} has a non-object mcpServers; leaving it alone`);
    return LEFT_ALONE;
  }
  const entryPath = ["mcpServers", MCP_SERVER_NAME];
  switch (classifyMcpEntry(servers[MCP_SERVER_NAME], ghPath)) {
    case "ours-current":
      return {
        inPlace: true,
        files: [{
          path: loaded.path,
          verdict: "same",
          attributes: planPatch(loaded.doc, [set(entryPath, servers[MCP_SERVER_NAME])]),
        }],
        apply: () => true,
      };
    case "foreign":
      logger.warn(
        `${loaded.path} already has a '${MCP_SERVER_NAME}' MCP server that is not ours; leaving it alone`,
      );
      return LEFT_ALONE;
    case "absent":
    case "ours-stale":
      break;
  }
  return {
    inPlace: true,
    ...planClaudeJsonPatch(loaded, [
      set(entryPath, managedEntry(ghPath, servers[MCP_SERVER_NAME])),
    ]),
  };
}

/** planClaudeMcpRegistration, performed. */
export function registerClaudeMcpServer(
  ghPath: string | null = resolveExecutablePath("gh"),
): boolean {
  return planClaudeMcpRegistration(ghPath).apply();
}

/** The `.claude.json` removeClaudeMcpRegistration would rewrite right now, or null (no entry, a
 *  foreign one, or a file that cannot be judged). Read-only; the uninstall plan resolves this once
 *  and renders it both ways. */
export function plannedClaudeMcpRemoval(): string | null {
  const loaded = loadClaudeJson();
  if (loaded === null) return null;
  const servers = loaded.doc.mcpServers;
  if (!isRecord(servers)) return null;
  const status = classifyMcpEntry(servers[MCP_SERVER_NAME]);
  return status === "ours-current" || status === "ours-stale" ? loaded.path : null;
}

/** Foreign survives. True when NO managed entry remains (removed, or none was there); false when a
 *  foreign entry was left in place or the write failed. */
export function planClaudeMcpRemoval(): McpWritePlan {
  const loaded = loadClaudeJson();
  if (loaded === null) return { files: [], apply: () => false };
  const servers = loaded.doc.mcpServers;
  if (!isRecord(servers)) return { files: [], apply: () => true };
  const status = classifyMcpEntry(servers[MCP_SERVER_NAME]);
  if (status === "absent") return { files: [], apply: () => true };
  if (status === "foreign") return { files: [], apply: () => false };
  const ops = [remove(["mcpServers", MCP_SERVER_NAME])];
  if (Object.keys(servers).length === 1) ops.push(remove(["mcpServers"]));
  return planClaudeJsonPatch(loaded, ops);
}

/** planClaudeMcpRemoval, performed. */
export function removeClaudeMcpRegistration(): boolean {
  return planClaudeMcpRemoval().apply();
}
