// Hostname normalization helpers for per-host runtime and Codex directories.
import os from "node:os";

export const HOME: string = process.env.HOME || os.homedir();

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
