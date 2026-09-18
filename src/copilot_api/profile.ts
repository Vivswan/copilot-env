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

/** The words of `agent profile [<name>] <verb>`: the per-profile verbs and `list`. Every one
 *  matches the name grammar, so they are reserved names: `agent profile <word>` then routes one
 *  way, never by what profiles exist. */
export const PROFILE_VERBS = [
  "add",
  "del",
  "show",
  "auth",
  "set",
  "unset",
  "get",
  "identity",
  "sync",
  "check",
] as const;

/** The commands that take `--profile <name>` today and become profile verbs next: reserved
 *  now, so no profile takes one of their names first. */
export const PROFILE_VERBS_NEXT = [
  "launch",
  "env",
  "proxy-token",
  "mcp",
  "start",
  "stop",
  "health",
  "models",
  "credits",
  "settings",
] as const;

/** `list` is `agent list`, and bare `agent profile` lists too; a profile named `list` would make
 *  `agent profile list` ambiguous, so the word stays reserved beside the verbs. */
const RESERVED_PROFILE_WORDS = ["help", "list", ...PROFILE_VERBS, ...PROFILE_VERBS_NEXT] as const;

export type ProfileVerb = (typeof PROFILE_VERBS)[number];

/** The words `agent profile <word>` routes as something other than a name: the verbs and
 *  Commander's `help`. Reserved at CREATION (CopilotEnvState.commitProfile and the `add`
 *  boundary), not at the mint: a profile named before its word became a verb stays readable and
 *  reachable by `--profile <name>` until the 4.0.9 migration renames it. */
export function isReservedProfileWord(name: string): boolean {
  return (RESERVED_PROFILE_WORDS as readonly string[]).includes(name);
}

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

/** The `agent start` command addressed at a profile's own daemon; a bare `agent start` would leave
 *  a named profile's daemon down. */
export function agentStartCommand(profile: Profile): string {
  return profile === null ? "agent start" : `agent start --profile ${profile}`;
}
