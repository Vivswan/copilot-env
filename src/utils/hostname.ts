import os from "node:os";
import path from "node:path";

/** HOME before os.homedir(), the per-host Codex farm's contract; resolved per call so a retargeted
 *  HOME sees the live value. */
export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/** The one spelling of the hosts subdirectory: the builder (src/codex/host.ts) and the cleanup
 *  sweeps (knownCodexHomes) both derive from it, so a move can never leave a sweep deleting from
 *  the old directory. */
export function codexFarmHostsDir(): string {
  return path.join(homeDir(), ".codex", "hosts");
}

function normalizeHostnameValue(hostnameValue: string): string {
  hostnameValue = hostnameValue.replace(/[^A-Za-z0-9._-]/g, "-");

  while (hostnameValue) {
    if ("._-".includes(hostnameValue[0]!)) {
      hostnameValue = hostnameValue.slice(1);
    } else if ("._-".includes(hostnameValue[hostnameValue.length - 1]!)) {
      hostnameValue = hostnameValue.slice(0, -1);
    } else {
      break;
    }
  }

  if (hostnameValue.length > 64) {
    hostnameValue = hostnameValue.slice(0, 64);
    while (hostnameValue) {
      if ("._-".includes(hostnameValue[hostnameValue.length - 1]!)) {
        hostnameValue = hostnameValue.slice(0, -1);
      } else {
        break;
      }
    }
  }

  return hostnameValue;
}

export function getSanitizedHostname(): string {
  // os.hostname() returns the FQDN on some systems; the short form matches `hostname -s`.
  const raw = os.hostname().split(".")[0] ?? "";
  return normalizeHostnameValue(raw) || "host";
}
