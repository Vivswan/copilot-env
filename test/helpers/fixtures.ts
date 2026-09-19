// Not a test file (the `test` task collects only test/**/*.test.ts), so importing it registers
// nothing. The agent files and run state a test stages by hand, and the offline GitHub login
// lookup every token acquisition asks.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_GRAPHQL_URL, setGithubLoginFetch } from "../../src/copilot_api/github_login.ts";
import type { ProfileName } from "../../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../../src/copilot_api/run_state.ts";

/** Every token acquisition asks GitHub whose token it is; this answers offline from `logins`
 *  (token -> login), 401 for any other token. Reset with `setGithubLoginFetch(null)`. */
export function stubGithubLogins(logins: Record<string, string>): void {
  setGithubLoginFetch((input, init) => {
    if (input !== GITHUB_GRAPHQL_URL) throw new Error(`unexpected fetch of ${input}`);
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const login = logins[token];
    return Promise.resolve(
      login === undefined
        ? new Response('{"message":"Bad credentials"}', { status: 401 })
        : new Response(JSON.stringify({ data: { viewer: { login } } }), { status: 200 }),
    );
  });
}

export interface CodexConfigTomlOptions {
  baseUrl: string;
  envKey?: string;
  wireApi?: string;
  /** The `auth` inline table (the managed proxy shape carries proxyTokenCommand()). */
  auth?: { command: string; args: readonly string[] };
}

/** A minimal stand-in for the writers' [model_providers.copilot-env] table. The optional fields are
 *  fixture knobs, not a mode's shape: both managed shapes (src/codex/config.ts) emit wire_api and
 *  an auth command, and neither emits env_key. */
export function codexConfigToml(opts: CodexConfigTomlOptions): string {
  const table = [`base_url = "${opts.baseUrl}"`];
  if (opts.envKey !== undefined) table.push(`env_key = "${opts.envKey}"`);
  if (opts.wireApi !== undefined) table.push(`wire_api = "${opts.wireApi}"`);
  if (opts.auth !== undefined) {
    // JSON string escapes are valid TOML basic-string escapes (Windows paths carry `\`).
    const args = opts.auth.args.map((a) => JSON.stringify(a)).join(", ");
    table.push(`auth = { command = ${JSON.stringify(opts.auth.command)}, args = [${args}] }`);
  }
  return ['model_provider = "copilot-env"', "", "[model_providers.copilot-env]", ...table, ""].join(
    "\n",
  );
}

export function writeCodexConfigToml(codexHome: string, opts: CodexConfigTomlOptions): string {
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, codexConfigToml(opts));
  return configPath;
}

export interface ClaudeSettingsOptions {
  apiKeyHelper: string;
  baseUrl?: string;
  extra?: Record<string, unknown>;
  /** The shape our writer emits (2-space indent, trailing newline). */
  pretty?: boolean;
}

export function claudeSettingsJson(opts: ClaudeSettingsOptions): string {
  const doc: Record<string, unknown> = { "apiKeyHelper": opts.apiKeyHelper };
  if (opts.baseUrl !== undefined) doc.env = { "ANTHROPIC_BASE_URL": opts.baseUrl };
  Object.assign(doc, opts.extra);
  return opts.pretty ? `${JSON.stringify(doc, null, 2)}\n` : JSON.stringify(doc);
}

export function writeClaudeSettings(claudeHome: string, opts: ClaudeSettingsOptions): string {
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, "settings.json");
  writeFileSync(settingsPath, claudeSettingsJson(opts));
  return settingsPath;
}

export function writeRunState(
  patch: Parameters<CopilotEnvRunState["set"]>[0],
  profile?: ProfileName,
): void {
  const state = profile ? CopilotEnvRunState.forProfile(profile) : new CopilotEnvRunState();
  state.set(patch);
}
