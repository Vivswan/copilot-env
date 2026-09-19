// `agent profile [<name>] identity` and `set identity <id|auto>`: the Copilot client identities a
// credential is accepted under, on the Direct and the proxy host. The survey and its table, the
// interactive chooser, and the pin; the credential command (auth.ts) resolves the token, refuses
// a headless chooser, and dispatches here. Nothing here logs in.
import { codexUserAgent } from "../codex/user_agent.ts";
import { Credential } from "../copilot_api/credential.ts";
import { trackedDaemonAlive } from "../copilot_api/daemon.ts";
import {
  CODEX_IDENTITY_NAME,
  configKeyDef,
  configSetCommand,
  CopilotEnvConfig,
  parseIntegrationIdPin,
} from "../copilot_api/env_config.ts";
import { CopilotEnvState, type StoredDirectPair } from "../copilot_api/env_state.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  directIdentity,
  identityCandidates,
  type IdentityHostSurvey,
  type IdentitySurvey,
  type IdentityVerdict,
  INTEGRATION_ID_HEADER,
  type IntegrationIdentity,
  pinnedIdentityCandidates,
  selectDirectIdentityAndHost,
  surveyIntegrationIdentities,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../copilot_api/integration_identity.ts";
import { agentStartCommand, agentStopCommand, type Profile } from "../copilot_api/profile.ts";
import { colorEnabled, paintFor } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { dryRunActive } from "../utils/fs_facade.ts";
import { createStderrLogger, prompt } from "../utils/logger.ts";
import { formatTable, terminalWidth, wrapLine } from "../utils/table.ts";

// Narration to stderr; the table is the stdout.
const logger = createStderrLogger();

/** `auto` has its own variant so clearing the pin never depends on a credential resolving; `pin`
 *  carries a domain-validated id. */
export type IdentityChoice = { kind: "pin"; id: string } | { kind: "auto" };

export function parseIdentityChoice(raw: string): IdentityChoice {
  const id = parseIntegrationIdPin(raw);
  return id.toLowerCase() === "auto" ? { kind: "auto" } : { kind: "pin", id };
}

const IDENTITY_NOTES: Record<string, string> = {
  [CODEX_IDENTITY_NAME]: `the default: no ${INTEGRATION_ID_HEADER} header (auto only)`,
  [COPILOT_CLI_INTEGRATION_ID]: "GitHub Copilot CLI; accepts fine-grained PATs",
  [VSCODE_CHAT_INTEGRATION_ID]: "copilot-api's former default",
};

/** The survey's palette, `agent config`'s: bold header, cyan names, green accepted, yellow
 *  rejected, dim for the rest. Resolved once at the command edge (colorEnabled()), so a test can
 *  force it on. */
type SurveyPaint = ReturnType<typeof paintFor>;
const plainText = (text: string): string => text;

function verdictOf(column: IdentityHostSurvey, name: string): IdentityVerdict | undefined {
  return column.verdicts.find((v) => v.name === name)?.verdict;
}

/** Every identity the survey probed, in first-seen order across the hosts. */
function surveyedNames(survey: IdentitySurvey): string[] {
  return [...new Set(survey.hosts.flatMap((h) => h.verdicts.map((v) => v.name)))];
}

/** The cell carries the verdict and a tag (status or "network error"); the full reason follows the
 *  table, so a 160-char rejection body never widens it. `mark` is `*` (in use) or `>` (the next
 *  landing's pick). */
function verdictCell(
  verdict: IdentityVerdict | undefined,
  mark: string,
  paint: SurveyPaint,
): string {
  const suffix = mark === "" ? "" : ` ${paint.green(mark)}`;
  if (verdict === undefined) return `${paint.dim("-")}${suffix}`;
  const tag = (detail: string): string =>
    detail.startsWith("network error") ? "network error" : detail.split(" ")[0] ?? "";
  switch (verdict.kind) {
    case "accepted":
      return `${
        paint.green(
          `accepted${
            verdict.models === null
              ? ""
              : ` (${verdict.models} ${verdict.models === 1 ? "model" : "models"})`
          }`,
        )
      }${suffix}`;
    case "rejected":
      return `${paint.yellow(`rejected (${tag(verdict.detail)})`)}${suffix}`;
    case "inconclusive":
      return `${paint.dim(`unclear (${tag(verdict.detail)})`)}${suffix}`;
    default:
      return assertNever(verdict);
  }
}

/** Why a column is shown (and whether it is the host in use). The configured column is the `host`
 *  literal, or under `auto` the slot's stored host. */
function hostTags(column: IdentityHostSurvey, inUse: boolean, literal: boolean): string[] {
  const tags: string[] = [];
  if (column.role === "designated") tags.push("account");
  if (column.role === "configured") tags.push(literal ? "host" : "stored");
  if (inUse) tags.push("in use");
  return tags;
}

/** A column's header: the host, its tags in `paint`. A reason line, dim as a whole, passes none, so
 *  dim never nests in dim. */
function hostLabel(
  column: IdentityHostSurvey,
  inUse = false,
  literal = true,
  paint: (text: string) => string = plainText,
): string {
  const tags = hostTags(column, inUse, literal);
  const host = new URL(column.apiBase).host;
  return tags.length === 0 ? host : `${host} ${paint(`(${tags.join(", ")})`)}`;
}

function sameOrigin(a: string, b: string): boolean {
  return URL.canParse(a) && URL.canParse(b) && new URL(a).origin === new URL(b).origin;
}

/** What the slot decides for this credential, resolved once where the pair is read (surveyAndTable)
 *  so the table never re-derives it from the halves. */
type SlotReading =
  /** Both halves known: the pin over the stored identity, on the literal over the stored host;
   *  what every Direct re-render bakes AND what a daemon launch sends. */
  | { kind: "in-use"; identity: string }
  /** No pin and nothing stored: the next landing selects afresh on the host in use, so its pick
   *  (the first candidate accepted there, in probe order; null when none is) can be previewed. */
  | { kind: "empty"; wouldPick: string | null }
  /** One half known (a pin without a stored host, or a stored half whose overlay cleared): the
   *  next landing probes again from the generic host, so there is no pick to preview here. */
  | { kind: "half"; missing: "identity" | "host" };

export interface IdentityTableInput {
  /** Every row under the one header set every mode sends (directClientHeaders). */
  survey: IdentitySurvey;
  pinned: string | null;
  /** The `host` literal, or null for `auto`. */
  configuredHost: string | null;
  /** The slot's probed halves; a half undefined while never probed. */
  stored: StoredDirectPair;
  /** The host every request goes to: the literal, else the stored host, else the generic host
   *  a first probe starts on. */
  hostInUse: string;
  slot: SlotReading;
  /** A running daemon keeps the identity and host it launched with, so the mark is not what is
   *  being sent right now. */
  daemonRunning: boolean;
  profile: Profile;
  /** colorEnabled() at the command edge; plain off a TTY. */
  color: boolean;
}

/** One column per host, one row per identity. `*` marks the one identity in use, on the host in
 *  use, or `>` the next landing's pick while the slot is empty; the notes name what would move it. */
export function identityTableLines(input: IdentityTableInput): string[] {
  const width = terminalWidth();
  const paint = paintFor(input.color);
  const { survey, pinned, configuredHost, stored, hostInUse, slot, daemonRunning } = input;
  const inUse = slot.kind === "in-use" ? slot.identity : null;
  const wouldPick = slot.kind === "empty" ? slot.wouldPick : null;
  const inUseColumn = survey.hosts.find((h) => sameOrigin(h.apiBase, hostInUse)) ?? null;
  const names = surveyedNames(survey);
  const mark = (column: IdentityHostSurvey, name: string): string => {
    if (column !== inUseColumn) return "";
    if (inUse === name) return "*";
    return wouldPick === name ? ">" : "";
  };
  const rows = names.map((name) => [
    paint.cyan(name),
    ...survey.hosts.map((c) => verdictCell(verdictOf(c, name), mark(c, name), paint)),
    IDENTITY_NOTES[name] ?? "",
  ]);
  // Every rejection behind a rendered cell.
  const reasons = names.flatMap((name) =>
    survey.hosts.flatMap((c) => {
      const verdict = verdictOf(c, name);
      return verdict === undefined || verdict.kind === "accepted" ? [] : wrapLine(
        paint.dim(`${name} on ${hostLabel(c, false, configuredHost !== null)}: ${verdict.detail}`),
        width,
        "  ",
        "    ",
      );
    })
  );
  const inUseHost = new URL(hostInUse).host;
  const start = agentStartCommand(input.profile);
  const restart = `\`${agentStopCommand(input.profile)}\`, then \`${start}\``;
  const landing = input.profile === null
    ? "`agent init`"
    : `\`agent profile ${input.profile} add --direct\``;
  const legend = "* = in use: the pin, else the slot's probed identity; what every Direct " +
    "re-render bakes and a daemon launch sends, on the host in use" +
    (wouldPick === null ? "" : "; > = would be picked by the next landing (nothing stored yet)");
  const notes = [
    ...(survey.designatedUnknown
      ? [
        "Host: the account's designated host could not be looked up (transient); only the hosts " +
        "above were surveyed.",
      ]
      : []),
    ...(slot.kind === "empty"
      ? [
        `Nothing stored yet for this profile: run ${landing} (or \`${start}\`) once; ` +
        "it probes on the host in use and stores the identity and host it lands on.",
      ]
      : slot.kind === "half"
      ? [
        `The ${slot.missing} is not stored yet for this profile: run ${landing} (or ` +
        `\`${start}\`) once; it probes and stores what it lands on.`,
      ]
      : pinned !== null && stored.integrationId !== undefined &&
          pinned !== (stored.integrationId ?? CODEX_IDENTITY_NAME)
      ? [
        `Slot: the probed identity is ${stored.integrationId ?? CODEX_IDENTITY_NAME}; the pin ` +
        `overlays it at every re-render and daemon start.`,
      ]
      : []),
    ...(daemonRunning
      ? [
        "Proxy: a daemon is running and keeps the identity and host it launched with; restart it " +
        `to apply a change: ${restart}.`,
      ]
      : []),
  ];
  return [
    ...wrapLine(
      pinned === null ? "identity: auto" : `identity: pinned to ${pinned}`,
      width,
      "",
      "  ",
    ),
    ...wrapLine(
      configuredHost === null ? `host: auto (${inUseHost} in use)` : `host: ${configuredHost}`,
      width,
      "",
      "  ",
    ),
    ...wrapLine(paint.dim(legend), width, "", "  "),
    ...formatTable(rows, {
      header: [
        paint.bold("identity"),
        ...survey.hosts.map((c) =>
          hostLabel(c, c === inUseColumn, configuredHost !== null, paint.dim)
        ),
        "note",
      ],
      wrap: [false, ...survey.hosts.map(() => false), true],
      indent: "",
      width,
      color: input.color,
    }),
    ...notes.flatMap((note) => wrapLine(paint.dim(note), width, "", "  ")),
    ...reasons,
  ];
}

/** `ids` not already among `builtins` are appended, so a row the star or the pin lands on always
 *  carries a probed verdict, whether or not it is a built-in candidate on that host. */
function withExtraCandidates(
  builtins: readonly IntegrationIdentity[],
  ids: readonly (string | null)[],
  build: (id: string) => IntegrationIdentity,
): IntegrationIdentity[] {
  const seen = new Set(builtins.map((c) => c.name));
  const extras: IntegrationIdentity[] = [];
  for (const id of ids) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    extras.push(build(id));
  }
  return [...builtins, ...extras];
}

/** The identity a landing on `hostInUse` would select from these verdicts: the first candidate
 *  accepted there, in candidate order (probeIntegrationIdentity's rule). Null when none is. */
function nextLandingPick(
  survey: IdentitySurvey,
  hostInUse: string,
  candidates: readonly IntegrationIdentity[],
): string | null {
  const column = survey.hosts.find((h) => sameOrigin(h.apiBase, hostInUse));
  if (column === undefined) return null;
  return candidates.find((c) => verdictOf(column, c.name)?.kind === "accepted")?.name ?? null;
}

async function surveyAndTable(
  profile: Profile,
  token: string,
  pinned: string | null,
): Promise<IdentitySurvey> {
  const userAgent = codexUserAgent();
  const configuredHost = new CopilotEnvConfig().copilotHost(profile);
  // THE identity in use and where, as every re-render and daemon launch read it: the pin over the
  // slot's stored pair, the literal over its host. The survey itself never probes to select and
  // never writes: a slot with no pair reads as none, and the landing that probes stores it.
  const stored = new CopilotEnvState().readProfileDirectPair(profile);
  const identity = pinned ?? stored.integrationId;
  const host = configuredHost ?? stored.host;
  const hostInUse = host ?? DEFAULT_COPILOT_API_BASE;
  // Rows: the candidates in the one header set every mode sends, plus the pin and the stored
  // identity when they are not candidates (a pin lands them there), so the row the mark lands on
  // always carries a probed verdict.
  const rows = withExtraCandidates(
    identityCandidates(userAgent),
    [
      pinned,
      stored.integrationId === undefined ? null : stored.integrationId ?? CODEX_IDENTITY_NAME,
    ],
    (id) => directIdentity(userAgent, id),
  );
  const survey = await surveyIntegrationIdentities(token, rows, { configuredHost: hostInUse });
  // A pinned landing stores only the host and a landing under a literal only the identity, so a
  // cleared overlay leaves ONE half: the next landing then re-selects from the generic host, not
  // the host in use, and only the empty slot's pick is previewed.
  const slot: SlotReading = identity !== undefined && host !== undefined
    ? { kind: "in-use", identity: identity ?? CODEX_IDENTITY_NAME }
    : pinned === null && stored.integrationId === undefined && stored.host === undefined
    ? {
      kind: "empty",
      wouldPick: nextLandingPick(survey, hostInUse, identityCandidates(userAgent)),
    }
    : { kind: "half", missing: host === undefined ? "host" : "identity" };
  for (
    const line of identityTableLines({
      survey,
      pinned,
      configuredHost,
      stored,
      hostInUse,
      slot,
      daemonRunning: trackedDaemonAlive(profile),
      profile,
      color: colorEnabled(),
    })
  ) {
    console.log(line);
  }
  return survey;
}

/** `agent profile [<name>] identity`: the survey of `token`, as a table; a read, never a write. */
export async function runIdentities(profile: Profile, token: string): Promise<void> {
  await surveyAndTable(profile, token, new CopilotEnvConfig().pinnedIntegrationId(profile));
}

/** The interactive pick, in a terminal: the survey shows the rows, then the picker offers every
 *  identity at least one host accepted, plus auto, each labelled with the same verdicts the table
 *  showed. `codex` is never offered: it is not a pin (see INTEGRATION_ID_DOMAIN), auto yields it. */
export async function chooseIdentity(profile: Profile, token: string): Promise<IdentityChoice> {
  const pinned = new CopilotEnvConfig().pinnedIntegrationId(profile);
  const survey = await surveyAndTable(profile, token, pinned);
  const names = surveyedNames(survey).filter((name) =>
    name !== CODEX_IDENTITY_NAME &&
    survey.hosts.some((c) => verdictOf(c, name)?.kind === "accepted")
  );
  const cell = (column: IdentityHostSurvey, name: string): string => {
    const verdict = verdictOf(column, name);
    return verdict === undefined ? "not probed" : verdictCell(verdict, "", paintFor(false));
  };
  const current = (name: string): string => name === pinned ? " (current pin)" : "";
  const value = await prompt("Which Copilot client identity should be pinned?", {
    type: "select",
    options: [
      {
        label: `auto - probe per credential${pinned === null ? " (current)" : ""}`,
        value: "auto",
      },
      ...names.map((name) => ({
        label: `${name} - ${
          survey.hosts.map((c) => `${hostLabel(c)} ${cell(c, name)}`).join(", ")
        }${current(name)}`,
        value: name,
      })),
    ],
    cancel: "reject",
  });
  return parseIdentityChoice(String(value));
}

function noteIdentityApplies(): void {
  const hint = configKeyDef("identity")?.applyHint;
  if (hint !== undefined) logger.info(hint);
}

/** Pins `id` unless the host its requests would go to rejects it definitively (the `host`
 *  literal, else the slot's stored host, else what `auto` selects for it), or every surveyed host
 *  does. Otherwise the other hosts' verdicts are narrated, and with no acceptance at all (an
 *  unresolvable credential, every probe inconclusive, the account's host unknown) the pin lands
 *  unverified and says so. */
async function pinIdentity(
  id: string,
  profile: Profile,
  credential: Credential,
): Promise<void> {
  const { token, reason } = credential.resolveWithReason();
  if (token === null) {
    logger.warn(`Pinning \`${id}\` unverified: ${reason}.`);
  } else {
    const configuredHost = new CopilotEnvConfig().copilotHost(profile);
    // The host the pin's requests go to: the `host` literal, else the slot's stored host (what
    // every re-render bakes under the pin), else the pin's own selection (a slot never probed: the
    // next re-render probes and stores). Surveyed as the configured column, so it always has a
    // row whatever the account lookup answers.
    const inUseHost = configuredHost ??
      new CopilotEnvState().readProfileDirectPair(profile)?.host ??
      (await selectDirectIdentityAndHost(token, codexUserAgent(), {
        pinned: id,
        fixedHost: configuredHost,
        narrator: logger,
      })).apiBase;
    const survey = await surveyIntegrationIdentities(
      token,
      pinnedIdentityCandidates(id, codexUserAgent()),
      { configuredHost: inUseHost },
    );
    const inUseIndex = survey.hosts.findIndex((h) => sameOrigin(h.apiBase, inUseHost));
    const hosts = survey.hosts.map((column, i) => ({
      // Under `auto` the selection's host rides in as the configured column; its label says so.
      label: configuredHost === null && column.role === "configured"
        ? `${new URL(column.apiBase).host} (in use for this identity)`
        : hostLabel(column, configuredHost !== null && i === inUseIndex),
      verdict: column.verdicts[0]?.verdict,
    }));
    // "Every host" needs the account's host to be known: a transient lookup failure hides that
    // column, so the surveyed hosts' rejections alone cannot say so.
    if (!survey.designatedUnknown && hosts.every((h) => h.verdict?.kind === "rejected")) {
      throw new Error(
        [
          `every host rejects this credential under \`${id}\`; not pinned:`,
          ...hosts.map((h) =>
            `  - ${h.label}: ${h.verdict?.kind === "rejected" ? h.verdict.detail : ""}`
          ),
        ].join("\n"),
      );
    }
    // The host in use decides alone: acceptance elsewhere cannot carry a pin its requests never reach.
    const inUse = hosts[inUseIndex];
    if (inUse?.verdict?.kind === "rejected") {
      const why = configuredHost === null
        ? "the host auto selects for this identity"
        : "the host in use";
      throw new Error(
        `${inUse.label} rejects this credential under \`${id}\`; not pinned, every request ` +
          `goes to ${why}: ${inUse.verdict.detail}`,
      );
    }
    const accepted = hosts.filter((h) => h.verdict?.kind === "accepted").map((h) => h.label);
    const ground = accepted.length === 0
      ? "pinning unverified"
      : `pinning on ${accepted.join(" and ")} accepting it`;
    if (survey.designatedUnknown) {
      logger.warn(`The account's designated host could not be looked up (transient); ${ground}.`);
    }
    for (const h of hosts) {
      if (h.verdict === undefined || h.verdict.kind === "accepted") continue;
      const outcome = h.verdict.kind === "rejected" ? "rejects" : "could not verify";
      logger.warn(`${h.label}: ${outcome} \`${id}\` (${h.verdict.detail}); ${ground}.`);
    }
  }
  new CopilotEnvConfig().setProfile(profile, { identity: id });
  if (dryRunActive()) return;
  logger.success(
    `identity = ${id} (pinned; \`${
      configSetCommand("identity", "auto", profile)
    }\` restores probing).`,
  );
  noteIdentityApplies();
}

/** `set identity <id|auto>` and the chooser's pick: the pin, or the return to probing. */
export async function runIdentity(profile: Profile, choice: IdentityChoice): Promise<void> {
  switch (choice.kind) {
    case "auto":
      // The same literal `agent profile set identity auto` stores; the store reads it as no pin.
      new CopilotEnvConfig().setProfile(profile, { identity: "auto" });
      // A dry run prints the plan in the landing's place.
      if (dryRunActive()) return;
      logger.success("identity = auto: the identity is probed per credential again.");
      noteIdentityApplies();
      return;
    case "pin":
      await pinIdentity(choice.id, profile, new Credential(undefined, profile));
      return;
    default:
      assertNever(choice);
  }
}
