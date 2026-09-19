// `agent profile [<name>] credits` and `agent credits`: this month's Copilot AI credits, spent and
// projected, against the plan's entitlement and the optional `cost.credits-target`. One live read
// of GitHub's meter per account; no local log is touched.
import { Credential } from "../copilot_api/credential.ts";
import { allProfileNames, DEFAULT_PROFILE_KEY, knownProfile } from "../copilot_api/env_state.ts";
import { type Profile, profileLabel } from "../copilot_api/profile.ts";
import {
  type CreditsFetch,
  creditsJson,
  type CreditsPace,
  creditsPace,
  fetchCopilotCredits,
  loadCreditsPace,
  renderCredits,
  resolveCreditsTarget,
} from "../usage/credits.ts";
import { createStderrLogger } from "../utils/logger.ts";

// Narration to stderr, so the block and the `--json` payload own stdout.
const logger = createStderrLogger();

interface CreditsArgs {
  json?: boolean;
  /** The per-run `--target`; unset defers to COPILOT_CREDITS_TARGET, then the config key. */
  creditsTarget?: string;
  /** The profile whose account is metered; unset is the default profile. */
  profile?: string;
}

/** Test seams; production takes every default. */
interface CreditsDeps {
  fetchImpl?: CreditsFetch;
  /** The credential look for one profile (the default is null). */
  credential?: (profile: Profile) => ReturnType<Credential["resolveWithReason"]>;
  nowMs?: () => number;
}

const resolveCredential: NonNullable<CreditsDeps["credential"]> = (profile) =>
  new Credential(undefined, profile).resolveWithReason();

/** One profile's account: no credential is the command's error. */
export async function runCredits(args: CreditsArgs, deps: CreditsDeps = {}): Promise<void> {
  const profile = knownProfile(args.profile);
  const target = resolveCreditsTarget(args.creditsTarget);
  const look = deps.credential ?? resolveCredential;
  const pace = await loadCreditsPace(target, { ...deps, credential: () => look(profile) });
  if (args.json) {
    console.log(JSON.stringify(creditsJson(pace), null, 2));
    return;
  }
  for (const line of renderCredits(pace)) console.log(line);
}

interface AccountMeter {
  pace: CreditsPace;
  /** The profiles on this account, `default` first, in profile order. */
  profiles: string[];
}

/** Every distinct account across the profiles: one meter per account, naming the profiles on it.
 *  Profiles holding the same token are one account before any fetch; two tokens the endpoint
 *  reports under one login are one account after it. A profile whose credential does not resolve
 *  is said on stderr and left out; none resolving is the error. */
export async function runCreditsEverywhere(
  args: Omit<CreditsArgs, "profile">,
  deps: CreditsDeps = {},
): Promise<void> {
  const target = resolveCreditsTarget(args.creditsTarget);
  const look = deps.credential ?? resolveCredential;
  const byToken = new Map<string, string[]>();
  for (const profile of [null, ...allProfileNames()]) {
    const { token, reason } = look(profile);
    if (token === null) {
      logger.warn(`${profileLabel(profile)}: ${reason}`);
      continue;
    }
    byToken.set(token, [...(byToken.get(token) ?? []), profile ?? DEFAULT_PROFILE_KEY]);
  }
  if (byToken.size === 0) {
    throw new Error(
      "no profile has a credential that resolves; run `agent auth` or `agent profile <name> auth`",
    );
  }
  // Every account's read at once (one timeout budget, not one per account), folded in the order
  // the tokens were met (profile order), so a slow account never reorders the meters.
  const fetched = await Promise.all(
    [...byToken].map(async ([token, profiles]) => ({
      profiles,
      credits: await fetchCopilotCredits(token, deps.fetchImpl ?? fetch),
    })),
  );
  const meters: AccountMeter[] = [];
  for (const { profiles, credits } of fetched) {
    const pace = creditsPace(credits, target, (deps.nowMs ?? Date.now)());
    const same = pace.login === null
      ? undefined
      : meters.find((meter) => meter.pace.login === pace.login);
    if (same === undefined) meters.push({ pace, profiles });
    else same.profiles.push(...profiles);
  }
  // A merge appends the later token's profiles after the earlier's: the list is profile order
  // (the default, then the names sorted) whatever order the tokens were met in.
  for (const meter of meters) {
    meter.profiles.sort((a, b) =>
      a === DEFAULT_PROFILE_KEY ? -1 : b === DEFAULT_PROFILE_KEY ? 1 : a.localeCompare(b)
    );
  }
  if (args.json) {
    console.log(
      JSON.stringify(
        meters.map((meter) => ({ profiles: meter.profiles, ...creditsJson(meter.pace) })),
        null,
        2,
      ),
    );
    return;
  }
  meters.forEach((meter, index) => {
    if (index > 0) console.log("");
    console.log(`profiles: ${meter.profiles.join(", ")}`);
    for (const line of renderCredits(meter.pace)) console.log(line);
  });
}
