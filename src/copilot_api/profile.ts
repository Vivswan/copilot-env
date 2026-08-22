// The named-profile vocabulary, shared by every layer (store, paths, CLI,
// config writers). A profile is an OPT-IN named credential + wiring slot beside
// the default: `null` IS the default profile, so every API takes `Profile` and
// treats both cases through one code path. Named profiles NEVER fall back to
// the default credential (ask, never silently fall back).
//
// This module is dependency-free on purpose -- everything imports it, so it
// must import nothing.

/** A VALIDATED profile name: lowercase kebab, 1-32 chars, non-reserved, not a
 *  Windows device name. Only `parseProfileName` mints one (the brand is
 *  unforgeable elsewhere), so holding the type IS the proof of validation --
 *  the path/store/config sinks accept it without re-checking. */
export type ProfileName = string & {
  readonly __brand: "ProfileName";
};

/** A named profile, or `null` for the default (unnamed) profile. */
export type Profile = ProfileName | null;

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

/** Parse a raw profile name (CLI flag, state-file key, dirent) into a
 *  `ProfileName`; throws with a usable hint. THE smart constructor -- the cast
 *  below is the brand's single minting point. */
export function parseProfileName(name: string): ProfileName {
  if ((RESERVED_PROFILE_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `profile name '${name}' is reserved${
        name === "default" ? " (omit --profile for the default profile)" : ""
      }`,
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
  return name as ProfileName;
}

/** Parse an optional `--profile` flag value at a command boundary: an absent
 *  flag (`undefined`) means the default profile (`null`); anything supplied --
 *  the empty string included -- must be a valid name or `parseProfileName`
 *  throws. The one place the undefined-means-default rule is spelled. */
export function parseProfileFlag(raw: string | undefined): Profile {
  return raw === undefined ? null : parseProfileName(raw);
}

/** Human label for messages: `default` or `profile 'work'`. */
export function profileLabel(profile: Profile): string {
  return profile === null ? "default" : `profile '${profile}'`;
}
