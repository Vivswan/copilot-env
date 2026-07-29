// Hostname normalization helpers for per-host runtime and Codex directories.
import os from "node:os";
import path from "node:path";

/** The user's home directory, process.env.HOME first (the per-host Codex farm's
 *  contract). Resolved per call so a retargeted HOME sees the live value. */
export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/** The per-host Codex farm root (~/.codex/hosts) holding every per-host home. The one
 *  spelling of the hosts subdirectory: the builder (src/codex/host.ts) and cleanup
 *  sweeps (knownCodexHomes) both derive from it, so moving it can never leave the
 *  sweeps deleting from the old directory. (The bare ~/.codex shared root is still
 *  spelled at its own read sites.) */
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
  // os.hostname() returns the FQDN on some systems; take the short form
  // (everything before the first dot) to match `hostname -s`.
  const raw = os.hostname().split(".")[0] ?? "";
  return normalizeHostnameValue(raw) || "host";
}
