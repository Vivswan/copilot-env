// `agent models`: list the models GitHub Copilot serves, grouped by vendor.
//
// One catalog, two roads to it (the same split as the agent wiring commands):
// `--proxy` reads the running local daemon's `GET /models`, `--direct` asks
// upstream api.githubcopilot.com with the resolved credential, and no flag
// auto-picks -- the proxy when it is up, Direct otherwise. `--json` emits a
// machine-readable `{source, models}` object instead of the table.
import { consola } from "consola";
import type { RequestedMode } from "../agents/provider_mode.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { Credential } from "../copilot_api/credential.ts";
import { discoverServableClaudeModels } from "../copilot_api/discovery.ts";
import { codexUserAgent, probeDirectIntegrationId } from "../codex/config.ts";
import { proxyStatus } from "../copilot_api/daemon.ts";
import { assertKnownProfile } from "../copilot_api/env_state.ts";
import { parseProfileFlag, type Profile, profileLabel } from "../copilot_api/profile.ts";
import { bold, cyan, gray } from "../utils/ansi.ts";
import { errMessage } from "../utils/error.ts";
import { mergeUnlistedModels, type ModelListEntry, parseModelList } from "../copilot_api/models.ts";

export interface ModelsArgs {
  /** `--direct`/`--proxy`, parsed once at the CLI boundary (auto = neither). */
  mode: RequestedMode;
  json?: boolean;
  /**
   * `--profile <name>`: list via that named profile's wiring -- its own daemon
   * (proxy) or its own credential (direct); a named profile never falls back to
   * the default daemon or credential. An unknown name is a hard error.
   */
  profile?: string;
}

/** Humanize a token limit for the table: 200000 -> "200k", 1048576 -> "1M". */
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

/** The gray trailing column: limits + tags, comma-joined ("128k context, 16k out, preview"). */
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

/**
 * Render the vendor-grouped table. Vendors sort alphabetically (unknown last,
 * as "Other"); within a vendor, chat models -- the ones the wired agents can
 * actually run -- come before the rest (embeddings etc.), each block id-sorted.
 * Columns are padded BEFORE coloring so ANSI codes never skew the alignment.
 */
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
      // Style only non-empty detail: gray("") would append ANSI codes after
      // the padding and defeat the trailing-space trim.
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

/** The resolved catalog road: Direct, or the running proxy with the port its
 *  liveness was just confirmed on (a proxy source ALWAYS carries that port). */
type ResolvedSource = { source: "direct" } | { source: "proxy"; port: number };

/**
 * Resolve which catalog to read (and, for the proxy, the port its liveness was
 * just confirmed on). A forced mode wins; on "auto", the proxy is preferred
 * when it is genuinely up (so the listing reflects what the proxy-wired agents
 * actually see), else Direct. `profile` addresses that named profile's daemon.
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

/** `models`: fetch the live catalog and print it as a table (or `--json`). */
export async function runModels(args: ModelsArgs): Promise<void> {
  // Boundary validation, before any probe or fetch: an unknown profile is a hard
  // error naming the known ones -- never a silent answer from the default wiring.
  const profile: Profile = parseProfileFlag(args.profile);
  if (profile !== null) assertKnownProfile(profile);
  const resolved = await resolveSource(args.mode, profile);
  const { source } = resolved;
  const label = sourceLabel(resolved, profile);
  let models: ModelListEntry[];
  try {
    if (source === "direct") {
      // The SAME unified pipeline the Claude Desktop wiring runs (catalog +
      // allowlist oracle + cached verification), so both surfaces list identical
      // models and every discovery fix propagates to both.
      const token = new Credential(undefined, profile).resolve();
      if (token === null) {
        // Same wording as fetchRawModels' direct branch: a named profile never
        // falls back to the default credential.
        throw new Error(
          profile === null
            ? "no GitHub credential configured (run `agent auth`)"
            : `no GitHub credential for ${
              profileLabel(profile)
            } - run \`agent auth --profile ${profile}\` ` +
              "to log in (a named profile never falls back to the default credential)",
        );
      }
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
  // Emit the whole table as a single message so consola stamps one prefix
  // instead of one per row (same rationale as start's alias table).
  consola.info(`${models.length} models via ${label}:\n${renderModelTable(models)}`);
}
