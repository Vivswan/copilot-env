import { consola } from "consola";
import type { RequestedMode } from "../agents/provider_mode.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { Credential } from "../copilot_api/credential.ts";
import { discoverServableClaudeModels } from "../copilot_api/discovery.ts";
import { renderDirectWiring } from "../agents/profile_wiring.ts";
import { probeDirectWiring } from "../codex/config.ts";
import { codexUserAgent } from "../codex/user_agent.ts";
import { proxyStatus } from "../copilot_api/daemon.ts";
import { assertKnownProfile } from "../copilot_api/env_state.ts";
import { agentStartCommand, parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { colorEnabled, palette } from "../utils/ansi.ts";
import { errMessage } from "../utils/error.ts";
import { formatTable, type TableRow, terminalWidth } from "../utils/table.ts";
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

/** Chat models come first within a vendor because they are the ones the wired agents can run. */
export function renderModelTable(
  models: ModelListEntry[],
  width: number | null = terminalWidth(),
  color = colorEnabled(),
): string {
  const byVendor = new Map<string, ModelListEntry[]>();
  for (const model of models) {
    const vendor = model.vendor ?? "Other";
    const group = byVendor.get(vendor) ?? [];
    group.push(model);
    byVendor.set(vendor, group);
  }
  const chatFirst = (e: ModelListEntry): number => (e.type === null || e.type === "chat" ? 0 : 1);
  const vendors = [...byVendor.keys()].sort(
    (a, b) => Number(a === "Other") - Number(b === "Other") || a.localeCompare(b),
  );
  const rows: TableRow[] = [];
  for (const vendor of vendors) {
    rows.push({ heading: vendor });
    const ordered = [...(byVendor.get(vendor) ?? [])].sort(
      (a, b) => chatFirst(a) - chatFirst(b) || a.id.localeCompare(b.id),
    );
    for (const entry of ordered) {
      // A painted "" would leave ANSI codes in an empty cell and defeat the trailing-space trim.
      const detail = entryDetail(entry);
      rows.push([
        entry.id,
        entry.name ?? "",
        detail === "" || !color ? detail : palette.dim(detail),
      ]);
    }
  }
  return formatTable(rows, { indent: "   ", wrap: [false, false, true], width, color }).join("\n");
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
      const whose = profile === null ? "" : ` for profile '${profile}'`;
      const start = agentStartCommand(profile);
      throw new Error(`the local proxy${whose} is not running (run \`${start}\`, or use --direct)`);
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
      // A listing renders what the wiring bakes (renderDirectWiring: the pin and literal over the
      // slot's probed halves) and writes nothing; a half never probed is probed here, and even that
      // answer is not stored: storing is the landing commands' (landDirectWiring).
      const direct = renderDirectWiring(profile) ?? await probeDirectWiring(profile, token);
      const discovered = await discoverServableClaudeModels(
        token,
        codexUserAgent(),
        direct.directIntegrationId,
        direct.directBaseUrl,
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
    const authCommand = profile === null ? "agent auth" : `agent profile ${profile} auth`;
    const hint = source === "proxy"
      ? profile === null
        ? "check `agent health` (or use --direct)"
        : `check \`${agentStartCommand(profile)} --check\` (or use --direct)`
      : `see \`${authCommand} --check\``;
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
  if (source === "proxy") {
    // copilot-api's local list is its own view, trimmed from upstream's (Fable stays hidden even
    // when the identity it sends lists it); the proxy still serves what upstream serves.
    const directListing = profile === null
      ? "agent profile models --direct"
      : `agent profile ${profile} models --direct`;
    consola.info(
      `The proxy lists its own catalog, a trimmed view of upstream's; \`${directListing}\` ` +
        "lists what Copilot serves this credential under its client identity.",
    );
  }
}
