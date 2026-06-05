import * as fs from "node:fs";

import { defineCommand, runMain } from "citty";
import { consola } from "consola";
import { CopilotAdminClient } from "./utils/admin.ts";
import { cacheDir } from "./utils/cache.ts";
import { CopilotApiConfig } from "./utils/config.ts";
import { generateAliases } from "./utils/models.ts";
import { CopilotApiPaths } from "./utils/paths.ts";
import {
  COPILOT_API_PORT_DEFAULT,
  copilotApiFindPort,
  copilotApiPortAvailable,
  copilotApiResolvePort,
} from "./utils/port.ts";
import {
  type CostEstimate,
  estimateCost,
  fetchPricing,
  OPENROUTER_MODELS_URL,
  type PricingTier,
  type UsageTokens,
} from "./utils/pricing.ts";
import {
  copilotApiVersion,
  getOrphanPids,
  launchDaemon,
  pidAlive,
  printLogTail,
} from "./utils/process.ts";
import { discoverUsageDbs, readUsage, type UsageReport } from "./utils/usage.ts";

// --- Default config applied on every `start`. ---
//
// String literals here are external contracts (config-file keys, copilot-api
// model ids). Do not change them during refactors.
//

const DEFAULT_SMALL_MODEL = "gpt-5.5";

const DEFAULT_FLAGS: Record<string, unknown> = {
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  useResponsesApiWebSearch: true,
};

function applyDefaultConfig(config: CopilotApiConfig): void {
  // These are static defaults the daemon reads from config.json at startup.
  // They have no admin REST endpoint, so they must be written to the file before
  // launch (unlike model aliases, which are pushed live via CopilotAdminClient).
  config.update((d) => {
    d.smallModel = DEFAULT_SMALL_MODEL;
    Object.assign(d, DEFAULT_FLAGS);
  });
  // Persist an admin key so the live `/admin/config/model-mappings` route (used
  // by syncModelAliases) accepts our request instead of 401-ing.
  config.ensureAdminApiKey();
}

/**
 * Disable every built-in extraPrompt the gateway injects.
 *
 * The pinned `@jeffreycao/copilot-api` re-adds any *missing* default extraPrompt
 * key on every config reload (`mergeDefaultConfig`), so an empty or absent map
 * is futile — the defaults always come back. Instead we blank every key the
 * daemon has already written to config.json. Discovering the key set at runtime
 * (rather than hardcoding it) keeps this correct when a future package version
 * adds new default prompts.
 *
 * Must run after the daemon is up (so config.json holds the package's full
 * default set) and before the model-mappings POST, whose reloadConfig() makes
 * the blanked values take effect.
 */
function disableExtraPrompts(config: CopilotApiConfig): void {
  config.update((d) => {
    const current = d.extraPrompts;
    const blanked: Record<string, string> = {};
    if (current && typeof current === "object" && !Array.isArray(current)) {
      for (const key of Object.keys(current)) {
        blanked[key] = "";
      }
    }
    d.extraPrompts = blanked;
  });
}

/**
 * Pull the daemon's live model catalog and replace its aliases with a
 * catalog-derived map. Best-effort: on failure no aliases are set (the gateway
 * still resolves plain dash-form ids via its own normalizer), and a warning is
 * logged.
 */
async function syncModelAliases(admin: CopilotAdminClient): Promise<void> {
  try {
    const catalog = await admin.getModels();
    const aliases = generateAliases(catalog);
    await admin.setModelMappings(aliases);
    consola.info(`OK Synced ${Object.keys(aliases).length} model aliases from catalog.`);
  } catch (e) {
    consola.warn(
      `WARNING: could not sync model aliases from catalog (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  await printModelAliases(admin);
}

/** Fetch the daemon's live model mappings and print them grouped by target. */
async function printModelAliases(admin: CopilotAdminClient): Promise<void> {
  let mappings: Record<string, string>;
  try {
    mappings = await admin.getModelMappings();
  } catch (e) {
    consola.warn(
      `WARNING: could not read live model mappings (${e instanceof Error ? e.message : String(e)}).`,
    );
    return;
  }
  // Group the aliases by the model they resolve to, so each target is listed
  // once with its sources comma-joined.
  const sources = Object.keys(mappings);
  const byTarget = new Map<string, string[]>();
  for (const source of sources) {
    const target = mappings[source];
    if (target === undefined) {
      continue;
    }
    const list = byTarget.get(target) ?? [];
    list.push(source);
    byTarget.set(target, list);
  }
  const targets = [...byTarget.keys()].sort();
  const width = targets.reduce((m, t) => Math.max(m, t.length), 0);
  // Emit the whole table as a single message so consola stamps one timestamp
  // instead of one per row (which wraps and interleaves at terminal width).
  const rows = targets.map((target) => {
    const aliases = (byTarget.get(target) ?? []).sort();
    return `   ${target.padEnd(width)}  <-  ${aliases.join(", ")}`;
  });
  consola.info(
    `--- Model aliases (${sources.length} -> ${targets.length} models):\n${rows.join("\n")}`,
  );
}

function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}

/**
 * Log the running gateway's version and (best-effort) its npm publish date.
 * The installed package.json carries only the version; the publish timestamp
 * lives in the registry's `time` map, so we fetch it with a short timeout and
 * fall back to version-only when offline.
 */
async function logGatewayVersion(): Promise<void> {
  const version = copilotApiVersion();
  if (version === null) {
    return;
  }
  let published = "";
  try {
    const res = await fetch("https://registry.npmjs.org/@jeffreycao/copilot-api", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const body = (await res.json()) as { time?: Record<string, string> };
      const ts = body.time?.[version];
      if (ts) {
        published = ` (published ${ts.slice(0, 10)})`;
      }
    }
  } catch {
    // offline / slow registry — version alone is still useful
  }
  consola.info(`   Gateway: @jeffreycao/copilot-api ${version}${published}`);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const start = defineCommand({
  meta: {
    name: "start",
    description: "Start copilot-api in the background, detached.",
  },
  args: {
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the resolved startup plan without changing gateway runtime state.",
    },
  },
  async run({ args }): Promise<void> {
    const paths = new CopilotApiPaths();
    const config = new CopilotApiConfig();

    const pidFile = paths.pidFile;
    const portFile = paths.portFile;
    const logFile = paths.logFile;

    if (args["dry-run"]) {
      let port = Number(COPILOT_API_PORT_DEFAULT);
      if (!(await copilotApiPortAvailable(port))) {
        port = await copilotApiFindPort(port + 1);
      }
      let trackedPid: number | null = null;
      if (isFile(pidFile)) {
        const parsed = Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        if (!Number.isNaN(parsed) && pidAlive(parsed)) {
          trackedPid = parsed;
        }
      }
      const orphans = (await getOrphanPids(process.pid, process.ppid)).filter(pidAlive);

      consola.info("DRY RUN: no gateway runtime changes will be made.");
      consola.info(`   Would ensure runtime directories: ${paths.home}, ${paths.runDir}`);
      consola.info(`   Would apply default configuration: ${config.path}`);
      if (trackedPid !== null) {
        consola.info(`   Would stop tracked copilot-api (pid=${trackedPid}).`);
      }
      for (const orphan of orphans) {
        consola.info(`   Would stop orphaned copilot-api (pid=${orphan}).`);
      }
      consola.info(`   Would launch copilot-api on port ${port}.`);
      consola.info(`   Would write runtime files: ${pidFile}, ${portFile}, ${logFile}`);
      consola.info("   Would wait for readiness, sync model aliases, and report gateway details.");
      return;
    }

    fs.mkdirSync(paths.home, { recursive: true });
    fs.mkdirSync(paths.runDir, { recursive: true });
    applyDefaultConfig(config);

    consola.info("==> Cleaning up existing copilot-api processes ...");

    if (isFile(pidFile)) {
      let trackedStr = "";
      try {
        trackedStr = fs.readFileSync(pidFile, "utf-8").trim();
      } catch {
        /* pass */
      }
      if (trackedStr) {
        const tracked = Number.parseInt(trackedStr, 10);
        if (!Number.isNaN(tracked)) {
          if (pidAlive(tracked)) {
            consola.info(`   Stopping tracked copilot-api (pid=${tracked}) ...`);
            try {
              process.kill(tracked, "SIGTERM");
            } catch {
              /* OSError */
            }
            await sleep(2);
            if (pidAlive(tracked)) {
              try {
                process.kill(tracked, "SIGKILL");
              } catch {
                /* OSError */
              }
            }
          }
        }
      }
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* OSError */
      }
    }

    const myPid = process.pid;
    const myPpid = process.ppid;
    let orphans = await getOrphanPids(myPid, myPpid);
    if (orphans.length > 0) {
      for (const opid of orphans) {
        if (pidAlive(opid)) {
          consola.info(`   Stopping orphaned copilot-api (pid=${opid}) ...`);
          try {
            process.kill(opid, "SIGTERM");
          } catch {
            /* OSError */
          }
        }
      }
      await sleep(2);
      orphans = await getOrphanPids(myPid, myPpid);
      for (const opid of orphans) {
        if (pidAlive(opid)) {
          try {
            process.kill(opid, "SIGKILL");
          } catch {
            /* OSError */
          }
        }
      }
    }

    await sleep(1);

    let port = Number(COPILOT_API_PORT_DEFAULT);
    if (!(await copilotApiPortAvailable(port))) {
      consola.warn(`WARNING: Port ${port} is busy (held by another process/user).`);
      try {
        port = await copilotApiFindPort(port + 1);
      } catch {
        throw new Error("could not find a free port to start copilot-api.");
      }
      consola.info(`OK Using alternative port: ${port}`);
    }

    fs.writeFileSync(logFile, "");
    const daemonEnv: Record<string, string> = { COPILOT_API_SQLITE_DB_PATH: paths.sqliteDb };
    let pid = launchDaemon(port, logFile, daemonEnv);

    await sleep(1);
    if (!pidAlive(pid)) {
      let logContent = "";
      try {
        logContent = fs.readFileSync(logFile, "utf-8");
      } catch {
        logContent = "";
      }
      if (/address already in use|EADDRINUSE|bind.*failed/i.test(logContent)) {
        consola.warn(`WARNING: Port ${port} was taken (TOCTOU race), retrying ...`);
        try {
          port = await copilotApiFindPort(port + 1);
        } catch {
          throw new Error("could not find a free port after TOCTOU retry.");
        }
        fs.writeFileSync(logFile, "");
        pid = launchDaemon(port, logFile, daemonEnv);
        await sleep(1);
        if (!pidAlive(pid)) {
          printLogTail(logFile, 20);
          throw new Error(`copilot-api failed to start after TOCTOU retry. See ${logFile}`);
        }
        consola.info(`OK Started on port ${port} after retry.`);
      } else {
        printLogTail(logFile, 20);
        throw new Error(`copilot-api failed to start. See ${logFile}`);
      }
    }

    fs.writeFileSync(pidFile, String(pid));
    fs.writeFileSync(portFile, String(port));
    consola.info(`Started copilot-api (PID ${pid}) on port ${port}, detached. Logs: ${logFile}`);

    consola.info(`--- Waiting for copilot-api to start (tailing ${logFile}) ...`);

    const maxWait = 120;
    let ready = false;
    let printedLogBytes = 0;
    for (let i = 0; i < maxWait; i++) {
      if (!pidAlive(pid)) {
        throw new Error(`copilot-api (PID ${pid}) exited during startup. See ${logFile}.`);
      }
      let logContent = "";
      try {
        const logBytes = fs.readFileSync(logFile);
        if (logBytes.length < printedLogBytes) {
          printedLogBytes = 0;
        }
        if (logBytes.length > printedLogBytes) {
          process.stderr.write(logBytes.subarray(printedLogBytes));
          printedLogBytes = logBytes.length;
        }
        logContent = logBytes.toString("utf-8");
      } catch {
        logContent = "";
      }
      if (logContent.includes("Listening on:")) {
        ready = true;
        break;
      }
      await sleep(1);
    }

    if (!ready) {
      consola.warn(
        `WARNING: copilot-api did not start listening on port ${port} within ${maxWait}s.`,
      );
      consola.warn(`    It may still be coming up; check the log file: ${logFile}`);
      throw new Error(`copilot-api did not start listening on port ${port} within ${maxWait}s`);
    }

    consola.info(`OK copilot-api is up on port ${port} (PID ${pid}).`);

    // Blank the gateway's built-in extraPrompts now that config.json holds the
    // package's full default set. The setModelMappings POST below triggers the
    // daemon's reloadConfig(), which makes the blanked values take effect.
    disableExtraPrompts(config);

    const admin = new CopilotAdminClient({
      port,
      apiKey: config.ensureApiKey(),
      adminKey: config.ensureAdminApiKey(),
    });
    await syncModelAliases(admin);

    await logGatewayVersion();
    // One message, one timestamp — keeps the path block from interleaving.
    consola.info(
      [
        `   Logs:   ${logFile}`,
        `   PID:    ${pidFile}`,
        `   Port:   ${portFile}`,
        `   SQLite: ${paths.sqliteDb}`,
        `   Bun env: ${cacheDir()}`,
      ].join("\n"),
    );
  },
});

const stop = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the copilot-api server on this host.",
  },
  async run(): Promise<void> {
    const paths = new CopilotApiPaths();
    const pidFile = paths.pidFile;
    const portFile = paths.portFile;

    if (!isFile(pidFile)) {
      throw new Error(`PID file not found: ${pidFile}. Run 'copilot-api start' first.`);
    }

    let pid: number;
    try {
      pid = Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    } catch {
      throw new Error(`could not read PID from ${pidFile}`);
    }
    if (Number.isNaN(pid)) {
      throw new Error(`could not read PID from ${pidFile}`);
    }

    if (!pidAlive(pid)) {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* OSError */
      }
      try {
        fs.unlinkSync(portFile);
      } catch {
        /* OSError */
      }
      throw new Error(`Process ${pid} is not running (stale PID file). Removed.`);
    }

    // On Windows there are no POSIX signals: Node maps SIGTERM (and SIGKILL) to
    // an unconditional TerminateProcess, so this is a hard kill with no graceful
    // SQLite flush. SQLite's WAL recovery makes that safe; just don't expect
    // clean teardown here on Windows.
    process.kill(pid, "SIGTERM");
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* OSError */
    }
    try {
      fs.unlinkSync(portFile);
    } catch {
      /* OSError */
    }
    consola.info(`Stopped copilot-api (PID ${pid})`);
    consola.info(`   Bun env: ${cacheDir()}`);
  },
});

const envCmd = defineCommand({
  meta: {
    name: "env",
    description: "Print env assignments for copilot-api, evaluated by the calling shell.",
  },
  args: {
    format: {
      type: "string",
      default: "posix",
      description:
        "Output syntax: 'posix' (default; `export KEY=VALUE`, eval-able by sh/bash/zsh) " +
        "or 'powershell' (`$env:KEY = '...'`, Invoke-Expression-able by PowerShell).",
    },
  },
  async run({ args }): Promise<void> {
    const format = String(args.format).toLowerCase();
    const isPowershell = format === "powershell" || format === "pwsh" || format === "ps";
    if (!isPowershell && format !== "posix" && format !== "sh" && format !== "bash") {
      throw new Error(`unknown --format '${args.format}' (expected 'posix' or 'powershell')`);
    }

    const port = copilotApiResolvePort();
    let token: string;
    try {
      token = new CopilotApiConfig().ensureApiKey();
    } catch (e) {
      throw new Error(
        `failed to persist auth token: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const vars: Array<[string, string]> = [
      ["ANTHROPIC_BASE_URL", `http://localhost:${port}`],
      ["ANTHROPIC_AUTH_TOKEN", token],
      ["OPENAI_BASE_URL", `http://localhost:${port}/v1`],
      ["OPENAI_API_KEY", token],
    ];

    for (const [key, value] of vars) {
      if (isPowershell) {
        // Single-quoted PS literal; double any embedded quote per PS escaping.
        console.log(`$env:${key} = '${value.replace(/'/g, "''")}'`);
      } else {
        console.log(`export ${key}=${value}`);
      }
    }
  },
});

const cost = defineCommand({
  meta: {
    name: "cost",
    description: "Aggregate token usage across all per-host SQLite DBs and estimate cost.",
  },
  args: {
    days: {
      type: "string",
      description: "Only include usage from the last N days (default: all).",
    },
    json: {
      type: "boolean",
      description: "Emit a JSON object instead of a formatted report.",
    },
    "pricing-url": {
      type: "string",
      description: "OpenRouter models API URL for live pricing.",
      default: OPENROUTER_MODELS_URL,
    },
  },
  async run({ args }): Promise<void> {
    const dbPaths = discoverUsageDbs();
    if (dbPaths.length === 0) {
      consola.warn("WARNING: no copilot-api usage databases found.");
      return;
    }

    const sinceMs = parseDaysCutoff(args.days);
    const report = readUsage(dbPaths, sinceMs);

    // Best-effort pricing: a fetch failure still yields a token-only report.
    let pricing = new Map<string, PricingTier>();
    try {
      pricing = await fetchPricing(args["pricing-url"]);
    } catch (e) {
      consola.warn(
        `WARNING: could not fetch OpenRouter pricing (${e instanceof Error ? e.message : String(e)}); reporting tokens only.`,
      );
    }

    const tokensByModel = new Map<string, UsageTokens>();
    for (const [model, u] of report.byModel) {
      tokensByModel.set(model, {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheCreation: u.cacheCreation,
      });
    }
    const estimate = estimateCost(tokensByModel, pricing);

    if (args.json) {
      console.log(
        JSON.stringify(buildCostJson(report, estimate, dbPaths.length, sinceMs), null, 2),
      );
      return;
    }
    printCostReport(report, estimate, dbPaths.length, args.days);
  },
});

/** Translate `--days N` into a unix-ms cutoff, or undefined for "all time". */
function parseDaysCutoff(days: string | undefined): number | undefined {
  if (days === undefined) {
    return undefined;
  }
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--days must be a positive number, got '${days}'`);
  }
  return Date.now() - n * 86_400_000;
}

/** Format a token count with a K/M suffix. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

function formatCurrency(amount: number | undefined): string {
  return amount === undefined ? "N/A" : `$${amount.toFixed(2)}`;
}

type Align = "left" | "right";

function padCell(text: string, width: number, align: Align): string {
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

/**
 * Render an aligned text table to stdout: a header row, a separator, the body
 * rows, then (if present) a second separator and footer rows. Uses console.log
 * directly so output is clean — no consola `i` prefix or trailing timestamp.
 */
function printTable(
  headers: string[],
  aligns: Align[],
  body: string[][],
  footer: string[][],
): void {
  const rows = [headers, ...body, ...footer];
  const widths = headers.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (row: string[]): string =>
    `  ${row.map((c, i) => padCell(c ?? "", widths[i] ?? 0, aligns[i] ?? "left")).join("  ")}`;
  const sep = `  ${widths.map((w) => "-".repeat(w)).join("  ")}`;

  console.log(fmt(headers));
  console.log(sep);
  for (const row of body) {
    console.log(fmt(row));
  }
  if (footer.length > 0) {
    console.log(sep);
    for (const row of footer) {
      console.log(fmt(row));
    }
  }
}

/** Print the by-model usage + cost report as a table (hosts merged). */
function printCostReport(
  report: UsageReport,
  estimate: CostEstimate,
  dbCount: number,
  days: string | undefined,
): void {
  const { byModel, activeDays } = report;
  const models = [...byModel.keys()].sort();
  const period = days ? `last ${days} days` : "all time";

  const sum = { reqs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const body: string[][] = [];
  for (const model of models) {
    const u = byModel.get(model);
    if (u === undefined) {
      continue;
    }
    const total = u.input + u.output + u.cacheRead + u.cacheCreation;
    sum.reqs += u.events;
    sum.input += u.input;
    sum.output += u.output;
    sum.cacheRead += u.cacheRead;
    sum.cacheWrite += u.cacheCreation;
    sum.total += total;
    const priced = estimate.perModel[model];
    body.push([
      model,
      formatTokens(u.events),
      formatTokens(u.input),
      formatTokens(u.output),
      formatTokens(u.cacheRead),
      formatTokens(u.cacheCreation),
      formatTokens(total),
      priced ? formatCurrency(priced.estimatedCostUsd) : "unpriced",
    ]);
  }

  const perDay = (n: number): string =>
    activeDays > 0 ? formatTokens(Math.round(n / activeDays)) : "N/A";
  const footer: string[][] = [
    [
      "TOTAL",
      formatTokens(sum.reqs),
      formatTokens(sum.input),
      formatTokens(sum.output),
      formatTokens(sum.cacheRead),
      formatTokens(sum.cacheWrite),
      formatTokens(sum.total),
      formatCurrency(estimate.totalUsd),
    ],
    [
      "Avg/day",
      perDay(sum.reqs),
      perDay(sum.input),
      perDay(sum.output),
      perDay(sum.cacheRead),
      perDay(sum.cacheWrite),
      perDay(sum.total),
      activeDays > 0 ? formatCurrency(estimate.totalUsd / activeDays) : "N/A",
    ],
  ];

  console.log();
  console.log(
    `Usage by model - ${period} | ${dbCount} db${dbCount === 1 ? "" : "s"} | ${sum.reqs} requests | ${activeDays} active day${activeDays === 1 ? "" : "s"}`,
  );
  console.log();
  printTable(
    ["Model", "Requests", "Input", "Output", "Cache Read", "Cache Write", "Total", "Cost"],
    ["left", "right", "right", "right", "right", "right", "right", "right"],
    body,
    footer,
  );
  if (estimate.unpriced.length > 0) {
    console.log();
    console.log(`  Unpriced (excluded from total): ${estimate.unpriced.join(", ")}`);
  }
  console.log();
}

/** Build the `--json` payload. */
function buildCostJson(
  report: UsageReport,
  estimate: CostEstimate,
  dbCount: number,
  sinceMs: number | undefined,
): Record<string, unknown> {
  const div = report.activeDays > 0 ? report.activeDays : 1;
  return {
    dbCount,
    sinceMs: sinceMs ?? null,
    activeDays: report.activeDays,
    usageByModel: Object.fromEntries(report.byModel),
    perModel: estimate.perModel,
    totalUsd: estimate.totalUsd,
    avgCostPerDayUsd:
      report.activeDays > 0 ? Math.round((estimate.totalUsd / div) * 10_000) / 10_000 : null,
    unpriced: estimate.unpriced,
  };
}

const cli = defineCommand({
  meta: {
    name: "copilot-api",
    description: "Manage the local copilot-api gateway.",
  },
  subCommands: {
    start,
    stop,
    env: envCmd,
    cost,
  },
});

if (import.meta.main) {
  runMain(cli).catch((e: unknown) => {
    consola.error(e instanceof Error ? e.message : String(e));
    // Set exitCode (not process.exit) so pending stderr writes flush.
    process.exitCode = 1;
  });
}
