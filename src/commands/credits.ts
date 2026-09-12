// `agent credits`: this month's Copilot AI credits, spent and projected, against the
// plan's entitlement and the optional `credits-target`. One live read of GitHub's
// meter for the default credential; no local log is touched.
import {
  type CredentialLook,
  type CreditsFetch,
  creditsJson,
  loadCreditsPace,
  renderCredits,
  resolveCreditsTarget,
} from "../usage/credits.ts";

export interface CreditsArgs {
  json?: boolean;
  /** The per-run `--target`; unset defers to COPILOT_CREDITS_TARGET, then the config key. */
  creditsTarget?: string;
}

/** Test seams; production takes every default. */
export interface CreditsDeps {
  fetchImpl?: CreditsFetch;
  credential?: CredentialLook;
  nowMs?: () => number;
}

export async function runCredits(args: CreditsArgs, deps: CreditsDeps = {}): Promise<void> {
  const target = resolveCreditsTarget(args.creditsTarget);
  const pace = await loadCreditsPace(target, deps);
  if (args.json) {
    console.log(JSON.stringify(creditsJson(pace), null, 2));
    return;
  }
  for (const line of renderCredits(pace)) console.log(line);
}
