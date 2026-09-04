// What a release attestation says, and who may have signed it -- the pure half
// of provenance verification, free of any sigstore import so the update
// pipeline (src/autoupdate/apply.ts) can name the asset and render the messages
// without loading the verification stack. The crypto lives in ./provenance.ts.
//
// checksums.txt travels with the binary, so matching it proves the download is
// intact, not who built it: anyone who can swap release assets can swap the
// manifest too. Every release also carries ONE Sigstore bundle
// (`attestation.json`) in which GitHub Actions attests the sha256 of every
// asset it published, signed under the release workflow's OIDC identity.
//
// Two failure classes, told apart by their messages because the right next
// step differs: "cannot verify" (the bundle could not be fetched or the
// Sigstore trust root could not be refreshed) names the opt-outs; "verification
// FAILED" (the bytes are not attested, the signer is not our release workflow,
// the bundle is not a bundle) does not -- that download must not be installed.

/** The release asset carrying the Sigstore bundle (uploaded by the managed
 *  release.yml's publish stage). */
export const ATTESTATION_NAME = "attestation.json";

/**
 * The ONLY identity allowed to sign a release: the release workflow, on the
 * default branch, as GitHub Actions names it in the signing certificate's SAN.
 * `.github/workflows/release.yml` is a repo-platform MANAGED file, so a rename
 * or a default-branch move there changes this identity and fails every update
 * as a mismatch until a release carrying the new constant ships FIRST. That
 * coupling is deliberate: a policy that accepted "any workflow in the repo"
 * would also accept a workflow a pull request added.
 *
 * The SAN alone is NOT enough: release.yml is a reusable (`workflow_call`)
 * workflow, and a reusable workflow's SAN names the CALLED workflow, so any
 * other repository invoking ours would be issued the same SAN for its own
 * assets. The source-repository pins below close that: they name the caller.
 */
export const RELEASE_SIGNER_SAN =
  "https://github.com/Vivswan/copilot-env/.github/workflows/release.yml@refs/heads/main";

/** GitHub Actions' OIDC issuer, as recorded in the signing certificate. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** The repository the release workflow must have run IN (the caller), by its
 *  immutable numeric id (a rename or transfer cannot inherit it) and the ref the
 *  release job runs on. Both are certificate extensions GitHub's OIDC token
 *  carries into the Fulcio certificate. */
export const SOURCE_REPOSITORY_ID = "1258991131";
export const SOURCE_REPOSITORY_REF = "refs/heads/main";

/** Fulcio's GitHub Actions certificate extensions (1.3.6.1.4.1.57264.1.*), the
 *  two this policy pins: 14 = Source Repository Ref, 15 = Source Repository
 *  Identifier. Their values are DER UTF8Strings. */
export const FULCIO_OID_SOURCE_REPOSITORY_REF = [1, 3, 6, 1, 4, 1, 57264, 1, 14] as const;
export const FULCIO_OID_SOURCE_REPOSITORY_ID = [1, 3, 6, 1, 4, 1, 57264, 1, 15] as const;

/** DER-encode `text` as an ASN.1 UTF8String (tag 0x0C), the shape Fulcio's
 *  v2 extensions carry their values in; a policy value must match it byte for
 *  byte. Lengths up to 65535 cover any repository ref or id. */
export function derUtf8String(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const length = bytes.length < 0x80
    ? [bytes.length]
    : bytes.length < 0x100
    ? [0x81, bytes.length]
    : [0x82, bytes.length >> 8, bytes.length & 0xff];
  return new Uint8Array([0x0c, ...length, ...bytes]);
}

/** The DSSE payload type of an in-toto statement. */
export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** The in-toto statement envelope and the SLSA predicate GitHub attests with. */
export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

/** Who may have signed the bundle. */
export interface SignerPolicy {
  /** The exact certificate SAN (matched anchored, never as a pattern). */
  subjectAlternativeName: string;
  /** The exact OIDC issuer extension. */
  issuer: string;
  /** The exact source repository id (Fulcio extension 15). */
  sourceRepositoryId: string;
  /** The exact source repository ref (Fulcio extension 14). */
  sourceRepositoryRef: string;
}

export const RELEASE_SIGNER_POLICY: SignerPolicy = {
  subjectAlternativeName: RELEASE_SIGNER_SAN,
  issuer: GITHUB_OIDC_ISSUER,
  sourceRepositoryId: SOURCE_REPOSITORY_ID,
  sourceRepositoryRef: SOURCE_REPOSITORY_REF,
};

/** One attested artifact: the name is informational, the digest is what matches. */
export interface AttestedSubject {
  name: string;
  sha256: string;
}

export interface ProvenanceStatement {
  predicateType: string;
  subjects: AttestedSubject[];
}

/** The fail-closed wording, the ONE place it lives: the check could not run, so
 *  the user gets the cause and both ways to proceed without it. */
export function cannotVerifyMessage(tag: string, cause: string): string {
  return `cannot verify the build provenance of ${tag}: ${cause}. ` +
    "To update without provenance verification, re-run with --no-verify, or persist the " +
    "opt-out with 'agent config --set verify-provenance false'.";
}

/** The mismatch wording: the check ran and the download is not what our release
 *  workflow built. Deliberately silent about the opt-outs. */
export function verificationFailedMessage(tag: string, detail: string): string {
  return `build provenance verification FAILED for ${tag}: ${detail}; the download is not ` +
    "what GitHub Actions built from Vivswan/copilot-env. Do not install it.";
}

/** Decode a DSSE payload as an in-toto v1 statement carrying SLSA provenance.
 *  Throws the mismatch DETAIL (the caller wraps it with the tag). */
export function parseStatement(payload: Uint8Array): ProvenanceStatement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error("the attestation payload is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the attestation payload is not an in-toto statement");
  }
  const statement = parsed as Record<string, unknown>;
  if (statement._type !== IN_TOTO_STATEMENT_V1) {
    throw new Error(
      `unexpected statement type ${String(statement._type)} (expected ${IN_TOTO_STATEMENT_V1})`,
    );
  }
  if (statement.predicateType !== SLSA_PROVENANCE_V1) {
    throw new Error(
      `unexpected predicate type ${
        String(statement.predicateType)
      } (expected ${SLSA_PROVENANCE_V1})`,
    );
  }
  if (!Array.isArray(statement.subject)) {
    throw new Error("the attestation statement has no subject list");
  }
  const subjects: AttestedSubject[] = [];
  for (const entry of statement.subject as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, digest } = entry as { name?: unknown; digest?: unknown };
    const sha256 = typeof digest === "object" && digest !== null
      ? (digest as { sha256?: unknown }).sha256
      : undefined;
    if (typeof name !== "string" || typeof sha256 !== "string") continue;
    subjects.push({ name, sha256: sha256.toLowerCase() });
  }
  return { predicateType: SLSA_PROVENANCE_V1, subjects };
}

/** Every required digest must be an attested subject. Throws the mismatch DETAIL. */
export function assertSubjectsAttested(
  statement: ProvenanceStatement,
  required: readonly AttestedSubject[],
): void {
  const attested = new Set(statement.subjects.map((s) => s.sha256));
  for (const { name, sha256 } of required) {
    if (!attested.has(sha256.toLowerCase())) {
      throw new Error(`the sha256 of ${name} (${sha256}) is not among the attested subjects`);
    }
  }
}
