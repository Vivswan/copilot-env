// The CLI reaches a fixed host list (deno.json `cli` permissions; a compiled binary cannot widen
// it). A `copilot-host` literal outside it is stored, since a build whose grant includes it honours
// it, but every request to it from THIS build fails with a permission error. Both writers of the
// key (`agent config --set` and `agent settings --import`) say so once, through this one function,
// so the two write paths cannot drift.
import { COPILOT_HOST_AUTO } from "./env_config.ts";

/** Null for `auto`, an unset key, or a host inside the grant. `granted` is the test seam for
 *  judging against a grant other than the running process's. */
export function copilotHostGrantWarning(
  stored: string | undefined,
  granted: (origin: string) => boolean = netGranted,
): string | null {
  if (stored === undefined || stored === COPILOT_HOST_AUTO) return null;
  if (granted(stored)) return null;
  return `copilot-host ${stored} is not permitted by this build's network policy (deno.json \`cli\` ` +
    "permissions; githubcopilot.com hosts are); requests to it fail until a build whose grant " +
    "includes it runs them.";
}

/** A grant entry may carry the port (`host:443`), so both spellings are asked. */
function netGranted(origin: string): boolean {
  const url = new URL(origin);
  const port = url.port === "" ? "443" : url.port;
  return [url.hostname, `${url.hostname}:${port}`].some(
    (host) => Deno.permissions.querySync({ name: "net", host }).state === "granted",
  );
}
