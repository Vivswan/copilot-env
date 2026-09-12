// `null` IS the default profile, so every API takes `Profile` and treats both through one code path.
//   a named profile without its own credential  -> ask; it NEVER falls back to the default's
//   everything imports this module              -> it imports nothing, and must stay that way

/** Only `parseProfileName` mints one, so holding the type IS the proof of validation and the
 *  path/store/config sinks accept it without re-checking. */
export type ProfileName = string & {
  readonly __brand: "ProfileName";
};

export type Profile = ProfileName | null;

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// `default` is the implicit unnamed profile (omit --profile instead); the rest collide with the
// mode-flag and `stop --all` vocabulary.
const RESERVED_PROFILE_NAMES = ["default", "direct", "proxy", "all"] as const;

/** Windows cannot create a `profiles/<name>` directory under these names (CreateFile treats them
 *  specially even with an extension), and cross-platform is non-negotiable, so they are invalid
 *  everywhere. Exported for every consumer that turns external strings into filenames (Desktop entry ids). */
export const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function isValidProfileName(name: string): boolean {
  return (
    PROFILE_NAME_RE.test(name) &&
    !WINDOWS_DEVICE_NAME_RE.test(name) &&
    !(RESERVED_PROFILE_NAMES as readonly string[]).includes(name)
  );
}

/** THE smart constructor: the cast below is the brand's single minting point. */
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

/** The one place the undefined-means-default rule is spelled; a supplied empty string is still parsed and rejected. */
export function parseProfileFlag(raw: string | undefined): Profile {
  return raw === undefined ? null : parseProfileName(raw);
}

export function profileLabel(profile: Profile): string {
  return profile === null ? "default" : `profile '${profile}'`;
}
