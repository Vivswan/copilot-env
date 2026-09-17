// What a release attestation says and who may have signed it: the pure half of provenance
// verification, free of any sigstore import so src/autoupdate/apply.ts can name the asset and
// render the messages without loading the verification stack (./provenance.ts has the crypto).
//
// checksums.txt travels with the binary, so matching it proves the download is intact, not who
// built it: whoever can swap release assets can swap the manifest too. Every release also
// carries ONE Sigstore bundle (`attestation.json`) in which GitHub Actions attests the sha256 of
// every asset it published, signed under the publishing workflow's OIDC identity.
//
// Two failure classes, told apart because the right next step differs:
//   "cannot verify"        -> the bundle or trust root could not be fetched; names the opt-outs
//   "verification FAILED"  -> the bytes are not attested or the signer is wrong; never names them
import { configSetCommand } from "../copilot_api/env_config.ts";
import { isRecord } from "../utils/json.ts";

/** The release asset carrying the Sigstore bundle (uploaded by the release workflow's publish
 *  stage). */
export const ATTESTATION_NAME = "attestation.json";

/**
 * The certificate SAN names the workflow that ran the attest step (`<workflow url>@<ref>`). Any
 * workflow of any repository under Vivswan's GitHub account may publish a release, at any ref:
 * the fleet's publish leg runs in another repository and from a tag. The certificate proves that
 * GitHub Actions under this account signed the bytes; the release download URL, not the
 * certificate, pins the repository.
 */
export const RELEASE_SIGNER_SAN =
  /^https:\/\/github\.com\/Vivswan\/[^/]+\/\.github\/workflows\/[^@]+@refs\/.+$/;

/** GitHub Actions' OIDC issuer, as recorded in the signing certificate. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** The DSSE payload type of an in-toto statement. */
export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** The in-toto statement envelope and the SLSA predicate GitHub attests with. */
export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

/** Who may have signed the bundle. */
export interface SignerPolicy {
  /** The anchored pattern the certificate SAN must match. */
  signerSan: RegExp;
  /** The exact OIDC issuer extension. */
  issuer: string;
}

export const RELEASE_SIGNER_POLICY: SignerPolicy = {
  signerSan: RELEASE_SIGNER_SAN,
  issuer: GITHUB_OIDC_ISSUER,
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
    `opt-out with '${configSetCommand("update.verify-provenance", "false")}'.`;
}

/** The mismatch wording: the check ran and the bytes or the signer failed it. Deliberately
 *  silent about the opt-outs. */
export function verificationFailedMessage(tag: string, detail: string): string {
  return `build provenance verification FAILED for ${tag}: ${detail}. Do not install it.`;
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
  if (!isRecord(parsed)) {
    throw new Error("the attestation payload is not an in-toto statement");
  }
  const statement = parsed;
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
    if (!isRecord(entry)) continue;
    const { name, digest } = entry;
    const sha256 = isRecord(digest) ? digest.sha256 : undefined;
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
