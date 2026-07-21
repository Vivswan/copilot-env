// The named-profile vocabulary, shared by every layer (store, paths, CLI,
// config writers). A profile is an OPT-IN named credential + wiring slot beside
// the default: `null` IS the default profile, so every API takes `Profile` and
// treats both cases through one code path. Named profiles NEVER fall back to
// the default credential (ask, never silently fall back).
//
// This module is dependency-free on purpose -- everything imports it, so it
// must import nothing.

/** A named profile, or `null` for the default (unnamed) profile. */
export type Profile = string | null;

/** Lowercase kebab, 1-32 chars, starting alphanumeric: `work`, `gh-alt`, ... */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// `default` is the implicit unnamed profile (omit --profile instead); the rest
// collide with mode-flag/`stop --all` vocabulary and would only breed confusion.
const RESERVED_PROFILE_NAMES = ["default", "direct", "proxy", "all"] as const;

// Windows reserved device names cannot become `profiles/<name>` directories there
// (CreateFile treats them specially even with an extension), and cross-platform is
// non-negotiable -- so they are invalid everywhere, not just on win32.
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** True when `name` is a syntactically valid, non-reserved profile name. */
export function isValidProfileName(name: string): boolean {
  return (
    PROFILE_NAME_RE.test(name) &&
    !WINDOWS_DEVICE_NAME_RE.test(name) &&
    !(RESERVED_PROFILE_NAMES as readonly string[]).includes(name)
  );
}

/** Validate a user-supplied profile name; throws with a usable hint. */
export function assertProfileName(name: string): void {
  if ((RESERVED_PROFILE_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `profile name '${name}' is reserved${name === "default" ? " (omit --profile for the default profile)" : ""}`,
    );
  }
  if (WINDOWS_DEVICE_NAME_RE.test(name)) {
    throw new Error(
      `profile name '${name}' is a Windows reserved device name and cannot be a directory there`,
    );
  }
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `invalid profile name '${name}' (want 1-32 chars of [a-z0-9-], starting with a letter or digit)`,
    );
  }
}

/** Human label for messages: `default` or `profile 'work'`. */
export function profileLabel(profile: Profile): string {
  return profile === null ? "default" : `profile '${profile}'`;
}
