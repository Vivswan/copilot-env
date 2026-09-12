import { consola } from "consola";
import type { RequestedMode } from "../agents/provider_mode.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { Credential } from "../copilot_api/credential.ts";
import { discoverServableClaudeModels } from "../copilot_api/discovery.ts";
import { codexUserAgent, probeDirectIntegrationId } from "../codex/config.ts";
import { proxyStatus } from "../copilot_api/daemon.ts";
import { assertKnownProfile } from "../copilot_api/env_state.ts";
import { parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { bold, cyan, gray } from "../utils/ansi.ts";
import { errMessage } from "../utils/error.ts";
import { mergeUnlistedModels, type ModelListEntry, parseModelList } from "../copilot_api/models.ts";

export interface ModelsArgs {
  mode: RequestedMode;
  json?: boolean;
  profile?: string;
}

/** 200000 -> "200k", 1048576 -> "1M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) {
    return `${thousands}k`;
  }
  // Values that would round to "1000k" (e.g. 999500) promote to the M tier.
  const millions = tokens / 1_000_000;
  const rounded = millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10;
  return `${rounded}M`;
}

function entryDetail(entry: ModelListEntry): string {
  const parts = [
    entry.contextWindow !== null ? `${formatTokens(entry.contextWindow)} context` : null,
    entry.maxOutput !== null ? `${formatTokens(entry.maxOutput)} out` : null,
    entry.type !== null && entry.type !== "chat" ? entry.type : null,
    entry.preview ? "preview" : null,
    entry.unlisted === true ? "unlisted" : null,
  ];
  return parts.filter((p) => p !== null).join(", ");
}

/** Chat models come first within a vendor because they are the ones the wired agents can run.
 *  Columns are padded before coloring so ANSI codes never skew the alignment. */
export function renderModelTable(models: ModelListEntry[]): string {
  const byVendor = new Map<string, ModelListEntry[]>();
  for (const model of models) {
    const vendor = model.vendor ?? "Other";
    const group = byVendor.get(vendor) ?? [];
    group.push(model);
    byVendor.set(vendor, group);
  }
  const idWidth = models.reduce((m, e) => Math.max(m, e.id.length), 0);
  const nameWidth = models.reduce((m, e) => Math.max(m, (e.name ?? "").length), 0);
  const chatFirst = (e: ModelListEntry): number => (e.type === null || e.type === "chat" ? 0 : 1);
  const vendors = [...byVendor.keys()].sort(
    (a, b) => Number(a === "Other") - Number(b === "Other") || a.localeCompare(b),
  );
  const lines: string[] = [];
  for (const vendor of vendors) {
    lines.push(`   ${bold(vendor)}`);
    const ordered = [...(byVendor.get(vendor) ?? [])].sort(
      (a, b) => chatFirst(a) - chatFirst(b) || a.id.localeCompare(b.id),
    );
    for (const entry of ordered) {
      // gray("") would append ANSI codes after the padding and defeat the trailing-space trim.
      const detail = entryDetail(entry);
      const row = [
        `     ${cyan(entry.id.padEnd(idWidth))}`,
        (entry.name ?? "").padEnd(nameWidth),
        detail === "" ? "" : gray(detail),
      ];
      lines.push(row.join("  ").trimEnd());
    }
  }
  return lines.join("\n");
}

type ResolvedSource = { source: "direct" } | { source: "proxy"; port: number };

/** On "auto" the proxy wins when it is up, so the listing reflects what the proxy-wired agents see.
 */
async function resolveSource(mode: RequestedMode, profile: Profile): Promise<ResolvedSource> {
  if (mode === "direct") {
    return { source: "direct" };
  }
  const status = await proxyStatus(profile);
  if (mode === "proxy") {
    if (!status.up) {
      throw new Error(
        profile === null
          ? "the local proxy is not running (run `agent start`, or use --direct)"
          : `the local proxy for profile '${profile}' is not running (run \`agent start --profile ${profile}\`, or use --direct)`,
      );
    }
    return { source: "proxy", port: status.port };
  }
  return status.up ? { source: "proxy", port: status.port } : { source: "direct" };
}

function sourceLabel(resolved: ResolvedSource, profile: Profile): string {
  if (resolved.source === "direct") return "GitHub Copilot Direct";
  return profile === null
    ? `the local proxy (port ${resolved.port})`
    : `profile '${profile}' local proxy (port ${resolved.port})`;
}

export async function runModels(args: ModelsArgs): Promise<void> {
  // Before any probe or fetch: an unknown profile must error naming the known ones, never answer
  // from the default wiring.
  const profile: Profile = parseProfileFlag(args.profile);
  if (profile !== null) assertKnownProfile(profile);
  const resolved = await resolveSource(args.mode, profile);
  const { source } = resolved;
  const label = sourceLabel(resolved, profile);
  let models: ModelListEntry[];
  try {
    if (source === "direct") {
      // The same discovery the Claude Desktop wiring runs, so a discovery fix reaches both; the
      // listings still differ, because Desktop keeps only the Claude rows.
      const resolved = new Credential(undefined, profile).resolveWithReason();
      if (resolved.token === null) throw new Error(resolved.reason);
      const token = resolved.token;
      const discovered = await discoverServableClaudeModels(
        token,
        codexUserAgent(),
        await probeDirectIntegrationId(profile, token),
        {},
      );
      models = mergeUnlistedModels(parseModelList(discovered.catalogBody), discovered);
    } else {
      models = parseModelList(
        await fetchRawModels(source, {
          profile,
          ...(resolved.source === "proxy" ? { port: resolved.port } : {}),
        }),
      );
    }
  } catch (e) {
    const profileFlag = profile === null ? "" : ` --profile ${profile}`;
    const hint = source === "proxy"
      ? profile === null
        ? "check `agent health` (or use --direct)"
        : `check \`agent start --profile ${profile} --check\` (or use --direct)`
      : `see \`agent auth --check${profileFlag}\``;
    throw new Error(`could not list models via ${label}: ${errMessage(e)}; ${hint}`);
  }
  if (args.json) {
    console.log(JSON.stringify({ source, models }, null, 2));
    return;
  }
  if (models.length === 0) {
    consola.warn(`No models in the catalog via ${label}.`);
    return;
  }
  // One message, so consola stamps one prefix instead of one per row.
  consola.info(`${models.length} models via ${label}:\n${renderModelTable(models)}`);
}
