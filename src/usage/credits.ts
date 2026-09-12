// The Copilot credits meter behind `agent credits`, the owner's ghco dashboard folded in.
// /copilot_internal/user is undocumented: only `premium_interactions` is metered (chat
// and completions are unlimited), and the period is the calendar month ending at
// 00:00 UTC on `quota_reset_date`, which is how GitHub's own meter counts it.
import { isRecord } from "../utils/json.ts";
import { Credential } from "../copilot_api/credential.ts";
import { configKeyDef, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { COPILOT_USER_URL } from "../copilot_api/integration_identity.ts";
import { blue, cyan, green, red } from "../utils/ansi.ts";
import { errMessage } from "../utils/error.ts";

export interface CopilotCredits {
  /** The login the endpoint reports, when it does. */
  login: string | null;
  /** Premium requests the plan grants per period. */
  entitlement: number;
  /** Premium requests spent so far this period. */
  used: number;
  /** `YYYY-MM-DD`; the period ends at 00:00 UTC on this day. */
  resetDate: string;
}

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 5000;

/** Validated field by field: a rename in the undocumented endpoint must surface by
 *  name, never as NaN. */
export function parseCopilotCredits(body: unknown): CopilotCredits {
  if (!isRecord(body)) throw new Error("the response is not a JSON object");
  const snapshots = isRecord(body.quota_snapshots) ? body.quota_snapshots : undefined;
  const quota = snapshots && isRecord(snapshots.premium_interactions)
    ? snapshots.premium_interactions
    : undefined;
  const entitlement = quota?.entitlement;
  if (typeof entitlement !== "number" || !Number.isFinite(entitlement) || entitlement <= 0) {
    throw new Error("no metered premium_interactions quota in the response");
  }
  const used = quota?.credits_used;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) {
    throw new Error("premium_interactions.credits_used missing or not a count");
  }
  const resetDate = body.quota_reset_date;
  if (typeof resetDate !== "string" || !isCalendarDate(resetDate)) {
    throw new Error("quota_reset_date missing or not a valid YYYY-MM-DD date");
  }
  return {
    login: typeof body.login === "string" ? body.login : null,
    entitlement,
    used,
    resetDate,
  };
}

/** True for `YYYY-MM-DD` naming a real day (Date.UTC would silently roll Feb 30 over). */
function isCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

export type CreditsFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The same env the owner's ghco script reads, so one setting drives both. */
export const CREDITS_TARGET_ENV = "COPILOT_CREDITS_TARGET";

/** Flag > env > stored `credits-target` > none; an explicit value is parsed by the
 *  registry's own rule, so the flag and the key share one range and one message. */
export function resolveCreditsTarget(
  flag: string | undefined,
  config: CopilotEnvConfig = new CopilotEnvConfig(),
  env: Record<string, string | undefined> = process.env,
): number | null {
  const explicit = flag !== undefined
    ? { raw: flag, source: "--target" }
    : env[CREDITS_TARGET_ENV] !== undefined
    ? { raw: env[CREDITS_TARGET_ENV] as string, source: CREDITS_TARGET_ENV }
    : null;
  if (explicit === null) return config.creditsTarget();
  const parse = configKeyDef("credits-target")?.parse;
  if (parse === undefined) throw new Error("config key 'credits-target' is not registered");
  try {
    return parse(explicit.raw) as number;
  } catch (e) {
    throw new Error(`${explicit.source}: ${errMessage(e)}`);
  }
}

export type CredentialLook = () => ReturnType<Credential["resolveWithReason"]>;

/** The live meter for the default credential; no credential is the command's error. */
export async function loadCreditsPace(
  target: number | null,
  deps: { fetchImpl?: CreditsFetch; credential?: CredentialLook; nowMs?: () => number } = {},
): Promise<CreditsPace> {
  const { token, reason } = (deps.credential ?? (() => new Credential().resolveWithReason()))();
  if (token === null) throw new Error(reason);
  const credits = await fetchCopilotCredits(token, deps.fetchImpl ?? fetch);
  return creditsPace(credits, target, (deps.nowMs ?? Date.now)());
}

/** The pace with its bounds as calendar days and the four headline credit figures (the
 *  entitlement, the spend, the target, the projection) beside their dollars. */
export function creditsJson(pace: CreditsPace): Record<string, unknown> {
  const { periodStartMs, resetMs, ...rest } = pace;
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const dollars = (n: number | null): number | null => n === null ? null : creditsUsd(n);
  return {
    ...rest,
    entitlementUsd: creditsUsd(pace.entitlement),
    usedUsd: creditsUsd(pace.used),
    targetUsd: dollars(pace.target),
    projectedUsd: dollars(pace.projected),
    periodStart: day(periodStartMs),
    resetDate: day(resetMs),
  };
}

export async function fetchCopilotCredits(
  token: string,
  fetchImpl: CreditsFetch,
): Promise<CopilotCredits> {
  const res = await fetchImpl(COPILOT_USER_URL, {
    headers: { Authorization: `token ${token}`, "User-Agent": "copilot-env" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${COPILOT_USER_URL} returned ${res.status}`);
  return parseCopilotCredits(await res.json());
}

/** GitHub bills AI credits at 100 to the dollar. */
export const CREDITS_PER_USD = 100;
export const creditsUsd = (credits: number): number => credits / CREDITS_PER_USD;

export interface CreditsPace {
  login: string | null;
  entitlement: number;
  used: number;
  /** The `credits-target` ceiling; null without one, and then no target bar or row is drawn. */
  target: number | null;
  /** Period bounds, ms since the epoch (UTC midnights). */
  periodStartMs: number;
  resetMs: number;
  /** Day of the period, 1-based, and the period's length in days. */
  day: number;
  daysTotal: number;
  /** Elapsed share of the period, 0..1. */
  elapsed: number;
  /** Where an even spend would sit right now against the target (null without one) and
   *  against the entitlement. */
  targetMark: number | null;
  totalMark: number;
  /** Null before any time has elapsed: the one owner of that reason. */
  projected: number | null;
}

/** The period's start: one calendar month before the reset, the day clamped to the
 *  shorter month (a Mar 31 reset starts on Feb 28 or 29). */
function periodStartMs(resetMs: number): number {
  const reset = new Date(resetMs);
  const lastOfPrevious = new Date(
    Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth(), 1) - DAY_MS,
  );
  const day = Math.min(reset.getUTCDate(), lastOfPrevious.getUTCDate());
  return Date.UTC(lastOfPrevious.getUTCFullYear(), lastOfPrevious.getUTCMonth(), day);
}

export function creditsPace(
  credits: CopilotCredits,
  target: number | null,
  nowMs: number,
): CreditsPace {
  const [y, m, d] = credits.resetDate.split("-").map(Number) as [number, number, number];
  const resetMs = Date.UTC(y, m - 1, d);
  const startMs = periodStartMs(resetMs);
  const period = resetMs - startMs;
  const elapsedMs = Math.min(Math.max(nowMs - startMs, 0), period);
  const elapsed = elapsedMs / period;
  const daysTotal = Math.round(period / DAY_MS);
  const day = Math.min(Math.max(Math.floor(elapsedMs / DAY_MS) + 1, 1), daysTotal);
  return {
    login: credits.login,
    entitlement: credits.entitlement,
    used: credits.used,
    target,
    periodStartMs: startMs,
    resetMs,
    day,
    daysTotal,
    elapsed,
    targetMark: target === null ? null : Math.round(target * elapsed),
    totalMark: Math.round(credits.entitlement * elapsed),
    // Never below the spend: rounding a fractional spend's projection down would draw a bar shorter
    // than what is already used.
    projected: elapsedMs > 0
      ? Math.max(credits.used, Math.round(credits.used / (elapsedMs / DAY_MS) * daysTotal))
      : null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOT = "·";
const OK = "✓";
const BAD = "✗";
const ARROW = "→";

const commas = (n: number): string =>
  Math.floor(Math.abs(n)).toLocaleString("en-US")
    .replace(/^/, n < 0 ? "-" : "");
const usd = (credits: number): string =>
  `$${
    creditsUsd(credits).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
const pct = (share: number): string => `${Math.round(share * 100)}%`;
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const delta = (n: number): string => n > 0 ? `${BAD} +${commas(n)}` : `${OK} ${commas(n)}`;

/** Colour goes on after every width is settled, so padding never counts an escape. */
const paintBar = (bar: string): string =>
  bar.replace(/#+/g, blue).replace(/\++/g, cyan).replace(/>$/, red);
const paintDelta = (cell: string): string =>
  cell.includes(BAD) ? red(cell) : cell.includes(OK) ? green(cell) : cell;

/** ghco's layout, kept cell for cell so the two read the same. A share past 100%
 *  closes the bar with `>`: an overrun must never look like a full month. Without a
 *  target the target bar, row, and marker are absent and the projection is judged
 *  against the entitlement. */
export function renderCredits(pace: CreditsPace): string[] {
  const { used, target, entitlement: total, projected } = pace;
  const reach = projected ?? used;
  const goal = target ?? total;
  const start = new Date(pace.periodStartMs);
  const reset = new Date(pace.resetMs);
  const header = `Copilot credits  ${pace.login === null ? "" : `${pace.login} ${DOT} `}${
    MONTHS[start.getUTCMonth()]
  } ${start.getUTCFullYear()} ${DOT} resets ${
    MONTHS[reset.getUTCMonth()]
  } ${reset.getUTCDate()} ${DOT} day ${pace.day}/${pace.daysTotal}`;

  const ceilings = target === null ? [total] : [target, total];
  const marks = pace.targetMark === null ? [pace.totalMark] : [pace.targetMark, pace.totalMark];
  const wEnd = Math.max(...ceilings.map((n) => commas(n).length));
  const wNow = Math.max(3, ...[used, reach].map((n) => commas(n).length));
  const wUsd = Math.max(1, ...[used, reach].map((n) => usd(n).length));
  const wMark = Math.max(pct(pace.elapsed).length, ...marks.map((n) => commas(n).length));
  const deltas = [
    ...marks.map((m) => used - m),
    ...(projected === null ? [] : [projected - goal]),
  ];
  const wDelta = Math.max(5, ...deltas.map((n) => delta(n).length));
  const wPct = Math.max(
    4,
    ...[pace.elapsed, ...ceilings.map((c) => used / c)].map((s) => pct(s).length),
  );
  const wProj = projected === null ? 0 : Math.max(...ceilings.map((c) => pct(reach / c).length));
  const wTable = 2 + 9 + 2 + wEnd + 8 + wNow + 5 + wUsd + 5 + wMark + 5 + wDelta;
  const wTail = 1 + wPct + (projected === null ? 0 : 2 + ARROW.length + wProj);
  const wBar = clamp(wTable - 11 - 1 - wTail, 10, 200);

  const cells = (share: number): number => clamp(Math.floor(share * wBar), 0, wBar);
  const bar = (usedShare: number, projShare: number): string => {
    const u = cells(usedShare);
    const p = cells(projShare);
    return `[${"#".repeat(u)}${"+".repeat(p - u)}${DOT.repeat(wBar - p)}${
      projShare > 1 ? ">" : "]"
    }`;
  };
  const mark = (line: string, at: number): string => {
    const m = clamp(Math.floor(at * wBar), 0, wBar - 1);
    return `${line.slice(0, m + 1)}|${line.slice(m + 2)}`;
  };
  const shares = (usedShare: number, projShare: number): string =>
    pct(usedShare).padStart(wPct) +
    (projected === null ? "" : ` ${ARROW} ${pct(projShare).padStart(wProj)}`);
  const row = (
    name: string,
    ceiling: string,
    now: string,
    dollars: string,
    at: string,
    d: string,
  ): string =>
    `  ${name.padEnd(9)}  ${ceiling.padStart(wEnd)}        ${now.padStart(wNow)}     ${
      dollars.padStart(wUsd)
    }     ${at.padStart(wMark)}     ${paintDelta(d.padStart(wDelta))}`;
  const legend = [
    "# used",
    ...(projected === null ? [] : ["+ projected"]),
    ...(target === null
      ? []
      : [`| target${target > total ? ` (above the ${commas(total)} entitlement)` : ""}`]),
  ].join("   ");
  const totalBar = bar(used / total, reach / total);

  return [
    header,
    "",
    `  time    ${paintBar(bar(pace.elapsed, pace.elapsed))} ${pct(pace.elapsed).padStart(wPct)}`,
    ...(target === null ? [] : [
      `  target  ${paintBar(bar(used / target, reach / target))} ${
        shares(used / target, reach / target)
      }`,
    ]),
    `  total   ${paintBar(target === null ? totalBar : mark(totalBar, target / total))} ${
      shares(used / total, reach / total)
    }`,
    `           ${legend}`,
    "",
    row("", "", "now", "$", pct(pace.elapsed), "delta"),
    ...(target === null || pace.targetMark === null ? [] : [
      row(
        "target",
        commas(target),
        commas(used),
        usd(used),
        commas(pace.targetMark),
        delta(used - pace.targetMark),
      ),
    ]),
    row(
      "total",
      commas(total),
      commas(used),
      usd(used),
      commas(pace.totalMark),
      delta(used - pace.totalMark),
    ),
    projected === null
      ? row("projected", "", "-", "-", "", "-")
      : row("projected", "", commas(projected), usd(projected), "", delta(projected - goal)),
  ];
}
