// The Copilot credits meter behind `agent credits`, the owner's ghco dashboard folded in.
// /copilot_internal/user is undocumented: only `premium_interactions` is metered (chat
// and completions are unlimited), and the period is the calendar month ending at
// 00:00 UTC on `quota_reset_date`, which is how GitHub's own meter counts it.

import { configKeyDef } from "../copilot_api/config_registry.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { COPILOT_USER_URL } from "../copilot_api/integration_identity.ts";
import { blue, cyan, green, red } from "../utils/ansi.ts";
import { isRecord } from "../utils/json.ts";
import { rethrown } from "../utils/message.ts";
import { MILLISECONDS_PER_DAY as DAY_MS } from "../utils/time.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";

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

const FETCH_TIMEOUT_MS = 5000;

/** Validated field by field: a rename in the undocumented endpoint must surface by
 *  name, never as NaN. */
export function parseCopilotCredits(body: unknown): CopilotCredits {
  if (!isRecord(body)) throw new Error("the response is not a JSON object");
  const snapshots = isRecord(body.quota_snapshots) ? body.quota_snapshots : undefined;
  const quota =
    snapshots && isRecord(snapshots.premium_interactions)
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

/** The flag over the env, each under the name its error message carries; null when neither is
 *  set. */
function explicitTarget(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): { raw: string; source: string } | null {
  if (flag !== undefined) return { raw: flag, source: "--target" };
  const fromEnv = env[CREDITS_TARGET_ENV];
  if (fromEnv !== undefined) return { raw: fromEnv, source: CREDITS_TARGET_ENV };
  return null;
}

/** Flag > env > stored `cost.credits-target` > none; an explicit value is parsed by the
 *  registry's own rule, so the flag and the key share one range and one message. */
export function resolveCreditsTarget(
  flag: string | undefined,
  config: CopilotEnvConfig = new CopilotEnvConfig(),
  env: Record<string, string | undefined> = process.env,
): number | null {
  const explicit = explicitTarget(flag, env);
  if (explicit === null) return config.creditsTarget();
  const parse = configKeyDef("cost.credits-target")?.parse;
  if (parse === undefined) throw new Error("config key 'cost.credits-target' is not registered");
  try {
    return parse(explicit.raw) as number;
  } catch (e) {
    throw rethrown(e, (message) => `${explicit.source}: ${message}`);
  }
}

type CredentialLook = () => ReturnType<Credential["resolveWithReason"]>;

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
  const dollars = (n: number | null): number | null => (n === null ? null : creditsUsd(n));
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
    headers: { Authorization: `token ${token}`, "User-Agent": COPILOT_ENV_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${COPILOT_USER_URL} returned ${res.status}`);
  return parseCopilotCredits(await res.json());
}

/** GitHub bills AI credits at 100 to the dollar. */
const CREDITS_PER_USD = 100;

/** Exact: the table's `usd` rounds it to two decimals, the JSON keeps the full figure. */
const creditsUsd = (credits: number): number => credits / CREDITS_PER_USD;

export interface CreditsPace {
  /** The GitHub login the endpoint reports; null when it reports none. */
  login: string | null;

  /** Premium requests the plan grants per period, in AI credits (100 to the dollar). */
  entitlement: number;

  /** Premium requests spent so far this period, in the same credits. */
  used: number;

  /** The `cost.credits-target` ceiling; null without one, and then no target bar or row is drawn. */
  target: number | null;

  /** One calendar month before `resetMs`, ms since the epoch (UTC midnight). */
  periodStartMs: number;

  /** 00:00 UTC on `quota_reset_date`, ms since the epoch. */
  resetMs: number;

  /** Day of the period, 1-based. */
  day: number;

  /** The period's length in days, 28 to 31. */
  daysTotal: number;

  /** Elapsed share of the period, 0..1. */
  elapsed: number;

  /** Where an even spend of the target would sit right now; null without a target. */
  targetMark: number | null;

  /** Where an even spend of the entitlement would sit right now. */
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
    projected:
      elapsedMs > 0
        ? Math.max(credits.used, Math.round((credits.used / (elapsedMs / DAY_MS)) * daysTotal))
        : null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOT = "·";
const OK = "✓";
const BAD = "✗";
const ARROW = "→";

const commas = (n: number): string =>
  Math.floor(Math.abs(n))
    .toLocaleString("en-US")
    .replace(/^/, n < 0 ? "-" : "");
const usd = (credits: number): string =>
  `$${creditsUsd(credits).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const pct = (share: number): string => `${Math.round(share * 100)}%`;
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const delta = (n: number): string => (n > 0 ? `${BAD} +${commas(n)}` : `${OK} ${commas(n)}`);

const paintBar = (bar: string): string =>
  bar.replace(/#+/g, blue).replace(/\++/g, cyan).replace(/>$/, red);
const paintDelta = (cell: string): string => {
  if (cell.includes(BAD)) return red(cell);
  if (cell.includes(OK)) return green(cell);
  return cell;
};

/** The widths the bars and the table share, each from the widest cell it will hold. */
interface CreditsWidths {
  /** The ceiling column: the target and the entitlement. */
  end: number;

  /** The now column: the spend and the projection. */
  now: number;

  /** Their dollars. */
  usd: number;

  /** The even-spend marks and the elapsed share. */
  mark: number;

  /** The delta column. */
  delta: number;

  /** The share after a bar. */
  pct: number;

  /** The projected share after the arrow; 0 without a projection. */
  proj: number;

  /** The bar between its brackets: the table's width less the label and the shares. */
  bar: number;
}

function creditsWidths(pace: CreditsPace): CreditsWidths {
  const { used, target, entitlement: total, projected } = pace;
  const reach = projected ?? used;
  const ceilings = target === null ? [total] : [target, total];
  const marks = pace.targetMark === null ? [pace.totalMark] : [pace.targetMark, pace.totalMark];
  const deltas = marks.map((m) => used - m);
  if (projected !== null) deltas.push(projected - (target ?? total));
  const wEnd = Math.max(...ceilings.map((n) => commas(n).length));
  const wNow = Math.max(3, ...[used, reach].map((n) => commas(n).length));
  const wUsd = Math.max(1, ...[used, reach].map((n) => usd(n).length));
  const wMark = Math.max(pct(pace.elapsed).length, ...marks.map((n) => commas(n).length));
  const wDelta = Math.max(5, ...deltas.map((n) => delta(n).length));
  const wPct = Math.max(
    4,
    ...[pace.elapsed, ...ceilings.map((c) => used / c)].map((s) => pct(s).length),
  );
  const wProj = projected === null ? 0 : Math.max(...ceilings.map((c) => pct(reach / c).length));
  const wTable = 2 + 9 + 2 + wEnd + 8 + wNow + 5 + wUsd + 5 + wMark + 5 + wDelta;
  const wTail = 1 + wPct + (projected === null ? 0 : 2 + ARROW.length + wProj);
  return {
    end: wEnd,
    now: wNow,
    usd: wUsd,
    mark: wMark,
    delta: wDelta,
    pct: wPct,
    proj: wProj,
    bar: clamp(wTable - 11 - 1 - wTail, 10, 200),
  };
}

/** The time, target (with one), and total bars, the total bar marked at the target, and the
 *  legend. A share past 100% closes the bar with `>`: an overrun must never look like a full
 *  month. */
function renderBars(pace: CreditsPace, w: CreditsWidths): string[] {
  const { used, target, entitlement: total, projected } = pace;
  const reach = projected ?? used;
  const cells = (share: number): number => clamp(Math.floor(share * w.bar), 0, w.bar);
  const bar = (usedShare: number, projShare: number): string => {
    const u = cells(usedShare);
    const p = cells(projShare);
    const close = projShare > 1 ? ">" : "]";
    return `[${"#".repeat(u)}${"+".repeat(p - u)}${DOT.repeat(w.bar - p)}${close}`;
  };
  const mark = (line: string, at: number): string => {
    const m = clamp(Math.floor(at * w.bar), 0, w.bar - 1);
    return `${line.slice(0, m + 1)}|${line.slice(m + 2)}`;
  };
  const shares = (usedShare: number, projShare: number): string => {
    const now = pct(usedShare).padStart(w.pct);
    if (projected === null) return now;
    return `${now} ${ARROW} ${pct(projShare).padStart(w.proj)}`;
  };

  const legend = ["# used"];
  if (projected !== null) legend.push("+ projected");
  if (target !== null) {
    const above = target > total ? ` (above the ${commas(total)} entitlement)` : "";
    legend.push(`| target${above}`);
  }

  const lines = [
    `  time    ${paintBar(bar(pace.elapsed, pace.elapsed))} ${pct(pace.elapsed).padStart(w.pct)}`,
  ];
  if (target !== null) {
    const targetBar = bar(used / target, reach / target);
    lines.push(`  target  ${paintBar(targetBar)} ${shares(used / target, reach / target)}`);
  }
  const totalBar = bar(used / total, reach / total);
  const marked = target === null ? totalBar : mark(totalBar, target / total);
  lines.push(`  total   ${paintBar(marked)} ${shares(used / total, reach / total)}`);
  lines.push(`           ${legend.join("   ")}`);
  return lines;
}

/** The table under the bars: its header, the target row (with one), the total, the projection. */
function renderRows(pace: CreditsPace, w: CreditsWidths): string[] {
  const { used, target, entitlement: total, projected } = pace;
  const row = (
    name: string,
    ceiling: string,
    now: string,
    dollars: string,
    at: string,
    d: string,
  ): string =>
    `  ${name.padEnd(9)}  ${ceiling.padStart(w.end)}        ${now.padStart(w.now)}     ${dollars.padStart(
      w.usd,
    )}     ${at.padStart(w.mark)}     ${paintDelta(d.padStart(w.delta))}`;

  const rows = [row("", "", "now", "$", pct(pace.elapsed), "delta")];
  if (target !== null && pace.targetMark !== null) {
    rows.push(
      row(
        "target",
        commas(target),
        commas(used),
        usd(used),
        commas(pace.targetMark),
        delta(used - pace.targetMark),
      ),
    );
  }
  rows.push(
    row(
      "total",
      commas(total),
      commas(used),
      usd(used),
      commas(pace.totalMark),
      delta(used - pace.totalMark),
    ),
  );
  if (projected === null) {
    rows.push(row("projected", "", "-", "-", "", "-"));
  } else {
    const goal = target ?? total;
    rows.push(row("projected", "", commas(projected), usd(projected), "", delta(projected - goal)));
  }
  return rows;
}

/** ghco's layout, kept cell for cell so the two read the same. Without a target the target bar,
 *  row, and marker are absent and the projection is judged against the entitlement. Colour goes
 *  on after every width is settled, so padding never counts an escape. */
export function renderCredits(pace: CreditsPace): string[] {
  const start = new Date(pace.periodStartMs);
  const reset = new Date(pace.resetMs);
  const login = pace.login === null ? "" : `${pace.login} ${DOT} `;
  const period = `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  const resets = `resets ${MONTHS[reset.getUTCMonth()]} ${reset.getUTCDate()}`;
  const day = `day ${pace.day}/${pace.daysTotal}`;
  const header = `Copilot credits  ${login}${period} ${DOT} ${resets} ${DOT} ${day}`;
  const widths = creditsWidths(pace);

  return [header, "", ...renderBars(pace, widths), "", ...renderRows(pace, widths)];
}
