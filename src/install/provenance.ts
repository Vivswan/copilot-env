// Release build-provenance verification: the sigstore-backed half. What the
// attestation says and who may sign it is ./attestation.ts (pure, and the module
// the update pipeline imports statically); this one is loaded lazily by the
// pipeline's default verifier, because the sigstore stack is well over a
// megabyte of CommonJS and `agent env` runs at every shell start.
//
// The digest shim MUST load before the first sigstore import: tuf-js and
// @sigstore/core call node:crypto verify() without a digest, which Deno rejects.
import "../utils/node_crypto_digest_shim.ts";
import { bundleFromJSON } from "@sigstore/bundle";
import type { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { join } from "node:path";
import { resolveRootHome } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";
import {
  assertSubjectsAttested,
  ATTESTATION_NAME,
  type AttestedSubject,
  cannotVerifyMessage,
  derUtf8String,
  FULCIO_OID_SOURCE_REPOSITORY_ID,
  FULCIO_OID_SOURCE_REPOSITORY_REF,
  IN_TOTO_PAYLOAD_TYPE,
  parseStatement,
  RELEASE_SIGNER_POLICY,
  type SignerPolicy,
  verificationFailedMessage,
} from "./attestation.ts";

/** Sigstore's public-good TUF mirror, which the trust root is refreshed from.
 *  Passed explicitly (never the dependency's default) because deno.json's
 *  `permissions.cli.net` allows exactly this host. */
export const TUF_MIRROR_URL = "https://tuf-repo-cdn.sigstore.dev";

/** Where the TUF client caches the Sigstore trust-root metadata: a subsystem
 *  cache under copilot-env's own root home (like the proxy float's deno cache),
 *  so `agent uninstall`'s home sweep removes it. */
export function tufCachePath(rootHome: string = resolveRootHome()): string {
  return join(rootHome, "sigstore", "tuf");
}

export interface VerifyProvenanceOptions {
  /** A trust root to verify against instead of refreshing one over TUF (tests). */
  trustedRoot?: TrustedRoot;
  /** Who may have signed (default: the release workflow). */
  policy?: SignerPolicy;
  /** Where the TUF client keeps its metadata cache. */
  cachePath?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Verify `bundleJson` (the release's attestation.json) and require every
 * `required` digest to be attested in it. Resolves with the verified signer
 * identity; rejects with a "cannot verify" or "verification FAILED" message.
 */
export async function verifyReleaseProvenance(
  tag: string,
  bundleJson: string,
  required: readonly AttestedSubject[],
  opts: VerifyProvenanceOptions = {},
): Promise<{ signerIdentity: string }> {
  // Parse before any network: a corrupt bundle is a mismatch, not an outage.
  let bundle: ReturnType<typeof bundleFromJSON>;
  try {
    bundle = bundleFromJSON(JSON.parse(bundleJson));
  } catch (e) {
    throw new Error(
      verificationFailedMessage(
        tag,
        `${ATTESTATION_NAME} is not a Sigstore bundle (${errMessage(e)})`,
      ),
    );
  }
  if (bundle.content.$case !== "dsseEnvelope") {
    throw new Error(
      verificationFailedMessage(tag, `${ATTESTATION_NAME} carries no attestation envelope`),
    );
  }
  const envelope = bundle.content.dsseEnvelope;
  // The payload type is under the signature, but the signature only proves the
  // signer meant THIS type; the statement parser assumes in-toto, so pin it.
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    throw new Error(
      verificationFailedMessage(
        tag,
        `unexpected attestation payload type ${envelope.payloadType} (expected ${IN_TOTO_PAYLOAD_TYPE})`,
      ),
    );
  }

  let trustedRoot: TrustedRoot;
  try {
    trustedRoot = opts.trustedRoot ??
      await getTrustedRoot({
        mirrorURL: TUF_MIRROR_URL,
        cachePath: opts.cachePath ?? tufCachePath(),
      });
  } catch (e) {
    throw new Error(
      cannotVerifyMessage(
        tag,
        `the Sigstore trust root could not be refreshed from ${TUF_MIRROR_URL} (${errMessage(e)})`,
      ),
    );
  }

  const policy = opts.policy ?? RELEASE_SIGNER_POLICY;
  let signerIdentity: string;
  try {
    const signer = new Verifier(toTrustMaterial(trustedRoot)).verify(toSignedEntity(bundle), {
      // sigstore-js matches the SAN as a regular expression even when given a
      // string, so an exact identity has to be escaped and anchored.
      subjectAlternativeName: new RegExp(`^${escapeRegExp(policy.subjectAlternativeName)}$`),
      extensions: { issuer: policy.issuer },
      // Byte-for-byte against the certificate's extension values (DER UTF8Strings).
      oids: [
        {
          oid: { id: [...FULCIO_OID_SOURCE_REPOSITORY_ID] },
          value: Buffer.from(derUtf8String(policy.sourceRepositoryId)),
        },
        {
          oid: { id: [...FULCIO_OID_SOURCE_REPOSITORY_REF] },
          value: Buffer.from(derUtf8String(policy.sourceRepositoryRef)),
        },
      ],
    });
    signerIdentity = signer.identity?.subjectAlternativeName ?? policy.subjectAlternativeName;
  } catch (e) {
    throw new Error(
      verificationFailedMessage(tag, `not signed by the release workflow (${errMessage(e)})`),
    );
  }

  try {
    const statement = parseStatement(envelope.payload);
    assertSubjectsAttested(statement, required);
  } catch (e) {
    throw new Error(verificationFailedMessage(tag, errMessage(e)));
  }
  return { signerIdentity };
}
