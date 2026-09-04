// Release provenance verification, offline: the real v4.0.0 bundle, the
// checksums.txt it attests, and a Sigstore trust-root snapshot as fixtures.
// Sigstore judges the certificate at the log-integrated time, not now, so the
// fixtures do not expire. The test permission set has no network, which is
// what keeps every case here pinned to the trust root passed in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { fileSha256 } from "../src/install/checksums.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertSubjectsAttested,
  ATTESTATION_NAME,
  cannotVerifyMessage,
  derUtf8String,
  IN_TOTO_STATEMENT_V1,
  parseStatement,
  RELEASE_SIGNER_POLICY,
  RELEASE_SIGNER_SAN,
  SLSA_PROVENANCE_V1,
  verificationFailedMessage,
} from "../src/install/attestation.ts";
import { tufCachePath, verifyReleaseProvenance } from "../src/install/provenance.ts";
import { describe, expect, test } from "./helpers/testing.ts";

const FIXTURES = join(import.meta.dirname!, "fixtures", "provenance", "v4.0.0");
const BUNDLE = readFileSync(join(FIXTURES, ATTESTATION_NAME), "utf8");
const TRUSTED_ROOT = TrustedRoot.fromJSON(
  JSON.parse(readFileSync(join(FIXTURES, "trusted_root.json"), "utf8")),
);
const TAG = "v4.0.0";

async function checksumsSubject() {
  return { name: "checksums.txt", sha256: await fileSha256(join(FIXTURES, "checksums.txt")) };
}

function statementOf(overrides: Record<string, unknown>): Uint8Array {
  const statement = {
    _type: IN_TOTO_STATEMENT_V1,
    predicateType: SLSA_PROVENANCE_V1,
    subject: [{ name: "a", digest: { sha256: "A".repeat(64) } }],
    predicate: {},
    ...overrides,
  };
  return new TextEncoder().encode(JSON.stringify(statement));
}

describe("verifyReleaseProvenance", () => {
  test("verifies the real release bundle under the default policy and matches by digest", async () => {
    const result = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
      trustedRoot: TRUSTED_ROOT,
    });
    expect(result.signerIdentity).toBe(RELEASE_SIGNER_SAN);
  });

  test("a digest the bundle does not attest is a FAILED verdict that withholds the opt-outs", async () => {
    const bogus = { name: "copilot-env-x86_64-unknown-linux-gnu", sha256: "f".repeat(64) };
    const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject(), bogus], {
      trustedRoot: TRUSTED_ROOT,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("verification FAILED for v4.0.0");
    expect(message).toContain(bogus.name);
    expect(message).toContain("Do not install it.");
    expect(message).not.toContain("--no-verify");
    expect(message).not.toContain("verify-provenance");
  });

  test("another repository's workflow identity is rejected", async () => {
    const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
      trustedRoot: TRUSTED_ROOT,
      policy: {
        ...RELEASE_SIGNER_POLICY,
        subjectAlternativeName:
          "https://github.com/someone-else/copilot-env/.github/workflows/release.yml@refs/heads/main",
      },
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("not signed by the release workflow");
    expect((err as Error).message).not.toContain("--no-verify");
  });

  test("the SAN is matched exactly, not as a pattern", async () => {
    // A regex-meaningful superset of the real SAN must NOT be accepted.
    const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
      trustedRoot: TRUSTED_ROOT,
      policy: { ...RELEASE_SIGNER_POLICY, subjectAlternativeName: RELEASE_SIGNER_SAN + ".*" },
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("not signed by the release workflow");
  });

  test("a different OIDC issuer is rejected", async () => {
    const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
      trustedRoot: TRUSTED_ROOT,
      policy: { ...RELEASE_SIGNER_POLICY, issuer: "https://accounts.google.com" },
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("not signed by the release workflow");
  });

  test("the same signer SAN from another repository or ref is rejected (reusable-workflow caller pin)", async () => {
    // release.yml is a reusable workflow: a caller elsewhere gets the same SAN.
    // The source-repository id and ref name the caller, so each alone must fail.
    for (
      const override of [
        { sourceRepositoryId: "1" },
        { sourceRepositoryId: RELEASE_SIGNER_POLICY.sourceRepositoryId + "1" },
        { sourceRepositoryRef: "refs/heads/feature" },
        { sourceRepositoryRef: "refs/pull/1/merge" },
      ]
    ) {
      const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
        trustedRoot: TRUSTED_ROOT,
        policy: { ...RELEASE_SIGNER_POLICY, ...override },
      }).catch((e: unknown) => e as Error);
      expect((err as Error).message, JSON.stringify(override)).toContain(
        "not signed by the release workflow",
      );
    }
  });

  test("a signed envelope whose payload or payload type was altered is a FAILED verdict", async () => {
    const original = JSON.parse(BUNDLE) as {
      dsseEnvelope: { payload: string; payloadType: string };
    };
    // Same signature, different bytes: the signature check must reject it.
    const tamperedPayload = structuredClone(original);
    const statement = JSON.parse(atob(original.dsseEnvelope.payload));
    statement.subject.push({ name: "evil", digest: { sha256: "e".repeat(64) } });
    tamperedPayload.dsseEnvelope.payload = btoa(JSON.stringify(statement));
    const err1 = await verifyReleaseProvenance(
      TAG,
      JSON.stringify(tamperedPayload),
      [{ name: "evil", sha256: "e".repeat(64) }],
      { trustedRoot: TRUSTED_ROOT },
    ).catch((e: unknown) => e as Error);
    expect((err1 as Error).message).toContain("verification FAILED");
    expect((err1 as Error).message).toContain("not signed by the release workflow");

    // A different payload type is refused before the signature is even checked.
    const otherType = structuredClone(original);
    otherType.dsseEnvelope.payloadType = "application/vnd.example+json";
    const err2 = await verifyReleaseProvenance(TAG, JSON.stringify(otherType), [], {
      trustedRoot: TRUSTED_ROOT,
    }).catch((e: unknown) => e as Error);
    expect((err2 as Error).message).toContain("unexpected attestation payload type");
    expect((err2 as Error).message).toContain("verification FAILED");
  });

  test("text that is not a Sigstore bundle is a FAILED verdict, decided before any network", async () => {
    // No trustedRoot and an empty cache: reaching for the trust root would need
    // the network the test permission set denies, and would surface as the
    // "cannot verify" message instead (the control below proves that path).
    const cachePath = mkdtempSync(join(tmpdir(), "copilot-tuf-"));
    try {
      for (const text of ["not json", "{}", JSON.stringify({ mediaType: "x" })]) {
        const err = await verifyReleaseProvenance(TAG, text, [], { cachePath })
          .catch((e: unknown) => e as Error);
        expect((err as Error).message).toContain("verification FAILED");
        expect((err as Error).message).toContain("attestation.json is not a Sigstore bundle");
      }
    } finally {
      rmSync(cachePath, { recursive: true, force: true });
    }
  });

  test("control: a valid bundle with no reachable trust root is the fail-closed message", async () => {
    const cachePath = mkdtempSync(join(tmpdir(), "copilot-tuf-"));
    try {
      const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
        cachePath,
      }).catch((e: unknown) => e as Error);
      expect((err as Error).message).toContain("cannot verify the build provenance of v4.0.0");
      expect((err as Error).message).toContain("trust root could not be refreshed");
      expect((err as Error).message).toContain("--no-verify");
    } finally {
      rmSync(cachePath, { recursive: true, force: true });
    }
  });

  test("an empty trust root fails the signature check, not the fetch", async () => {
    const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
      trustedRoot: TrustedRoot.fromJSON({}),
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("verification FAILED");
  });
});

describe("parseStatement / assertSubjectsAttested", () => {
  test("reads the subjects of a SLSA v1 statement, lower-casing digests", () => {
    const statement = parseStatement(statementOf({}));
    expect(statement.predicateType).toBe(SLSA_PROVENANCE_V1);
    expect(statement.subjects).toEqual([{ name: "a", sha256: "a".repeat(64) }]);
  });

  test("rejects the wrong statement or predicate type and a missing subject list", () => {
    expect(() => parseStatement(statementOf({ _type: "https://in-toto.io/Statement/v0.1" })))
      .toThrow(/unexpected statement type/);
    expect(() => parseStatement(statementOf({ predicateType: "https://slsa.dev/provenance/v0.2" })))
      .toThrow(/unexpected predicate type/);
    expect(() => parseStatement(statementOf({ subject: undefined }))).toThrow(/no subject list/);
    expect(() => parseStatement(new TextEncoder().encode("nope"))).toThrow(/not JSON/);
  });

  test("skips malformed subject entries instead of attesting them", () => {
    const statement = parseStatement(
      statementOf({ subject: [{ name: "x" }, { digest: { sha256: "b".repeat(64) } }, null, 4] }),
    );
    expect(statement.subjects).toEqual([]);
  });

  test("every required digest must be attested", () => {
    const statement = parseStatement(statementOf({}));
    expect(() => assertSubjectsAttested(statement, [{ name: "a", sha256: "A".repeat(64) }]))
      .not.toThrow();
    expect(() => assertSubjectsAttested(statement, [{ name: "bin", sha256: "c".repeat(64) }]))
      .toThrow(/the sha256 of bin \(c+\) is not among the attested subjects/);
  });
});

describe("derUtf8String", () => {
  test("encodes short, 128..255, and longer strings with DER lengths", () => {
    expect([...derUtf8String("1258991131")]).toEqual([
      0x0c,
      10,
      ...new TextEncoder().encode("1258991131"),
    ]);
    expect([...derUtf8String("a".repeat(200)).slice(0, 3)]).toEqual([0x0c, 0x81, 200]);
    expect([...derUtf8String("a".repeat(300)).slice(0, 4)]).toEqual([0x0c, 0x82, 1, 44]);
    expect(derUtf8String("a".repeat(300)).length).toBe(304);
  });
});

describe("messages and paths", () => {
  test("the fail-closed message names both opt-outs", () => {
    const message = cannotVerifyMessage("v1.2.3", "attestation.json could not be fetched");
    expect(message).toContain("cannot verify the build provenance of v1.2.3");
    expect(message).toContain("--no-verify");
    expect(message).toContain("agent config --set verify-provenance false");
  });

  test("the mismatch message names the tag and forbids the install", () => {
    const message = verificationFailedMessage("v1.2.3", "detail");
    expect(message).toContain("FAILED for v1.2.3: detail");
    expect(message).toContain("Do not install it.");
    expect(message).not.toContain("--no-verify");
  });

  test("the TUF cache lives under the root home", () => {
    expect(tufCachePath("/x/home")).toBe(join("/x/home", "sigstore", "tuf"));
  });
});
