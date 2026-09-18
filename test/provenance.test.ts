// Sigstore judges the certificate at the log-integrated time, not now, so the v4.0.0 fixtures never
// expire. The test permission set has no network, which pins every case to the trust root passed in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { fileSha256 } from "../src/install/checksums.ts";
import { rmSync } from "node:fs";
import {
  assertSubjectsAttested,
  ATTESTATION_NAME,
  cannotVerifyMessage,
  IN_TOTO_STATEMENT_V1,
  parseStatement,
  RELEASE_SIGNER_POLICY,
  SLSA_PROVENANCE_V1,
  verificationFailedMessage,
} from "../src/install/attestation.ts";
import { tufCachePath, verifyReleaseProvenance } from "../src/install/provenance.ts";
import { describe, expect, tempDir, test } from "./helpers/testing.ts";

const FIXTURES = join(import.meta.dirname!, "fixtures", "provenance", "v4.0.0");
const BUNDLE = readFileSync(join(FIXTURES, ATTESTATION_NAME), "utf8");
const TRUSTED_ROOT = TrustedRoot.fromJSON(
  JSON.parse(readFileSync(join(FIXTURES, "trusted_root.json"), "utf8")),
);
const TAG = "v4.0.0";
/** The identity that signed the fixture: the repository's own release workflow on main. */
const FIXTURE_SIGNER =
  "https://github.com/Vivswan/copilot-env/.github/workflows/release.yml@refs/heads/main";
/** The fleet publish leg that signs releases now: another repository of the same owner, a tag. */
const FLEET_SIGNER =
  "https://github.com/Vivswan/repo-platform/.github/workflows/fleet-release-publish.yml@refs/tags/stable";

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
    expect(result.signerIdentity).toBe(FIXTURE_SIGNER);
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

  test("the verifier judges the signer SAN by the policy pattern: another owner's workflows are rejected", async () => {
    const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
      trustedRoot: TRUSTED_ROOT,
      policy: {
        ...RELEASE_SIGNER_POLICY,
        signerSan:
          /^https:\/\/github\.com\/someone-else\/[^/]+\/\.github\/workflows\/[^@]+@refs\/.+$/,
      },
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain(
      "not signed by a GitHub Actions workflow of Vivswan's account",
    );
    expect((err as Error).message).not.toContain("--no-verify");
  });

  test("the SAN pattern accepts any workflow of any Vivswan repository at any ref, and nothing else", () => {
    // The fixture pins one signer; the owner-wide freedom is judged on the pattern itself.
    const pattern = RELEASE_SIGNER_POLICY.signerSan;
    for (
      const accepted of [
        FIXTURE_SIGNER,
        FLEET_SIGNER, // the v4.0.9 identity the workflow allow-list refused
        "https://github.com/Vivswan/Vivswan-evil/.github/workflows/anything.yaml@refs/pull/1/merge",
      ]
    ) expect(pattern.test(accepted), accepted).toBe(true);
    for (
      const rejected of [
        "https://github.com/someone-else/copilot-env/.github/workflows/release.yml@refs/heads/main",
        "https://github.com/Vivswanx/copilot-env/.github/workflows/release.yml@refs/heads/main", // owner as a prefix
        "https://github.com/xVivswan/copilot-env/.github/workflows/release.yml@refs/heads/main", // owner as a suffix
        "https://github.com/Vivswan/.github/workflows/release.yml@refs/heads/main", // no repository segment
        FIXTURE_SIGNER.slice(0, FIXTURE_SIGNER.indexOf("@")), // no ref at all
        FIXTURE_SIGNER.replace(/@.*$/, "@main"), // a ref outside refs/
        `${FIXTURE_SIGNER}\ninvalid`, // trailing text past the end anchor
      ]
    ) expect(pattern.test(rejected), rejected).toBe(false);
  });

  test("a different OIDC issuer is rejected", async () => {
    const err = await verifyReleaseProvenance(TAG, BUNDLE, [await checksumsSubject()], {
      trustedRoot: TRUSTED_ROOT,
      policy: { ...RELEASE_SIGNER_POLICY, issuer: "https://accounts.google.com" },
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain(
      "not signed by a GitHub Actions workflow of Vivswan's account",
    );
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
    expect((err1 as Error).message).toContain(
      "not signed by a GitHub Actions workflow of Vivswan's account",
    );

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
    const cachePath = tempDir("copilot-tuf-");
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
    // Unreachable by construction, not by permission set: under a wider grant (`-A`, an IDE
    // runner) the empty cache would refresh from the mirror and the real bundle would verify.
    expect((await Deno.permissions.revoke({ name: "net" })).state).not.toBe("granted");
    const cachePath = tempDir("copilot-tuf-");
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

describe("messages and paths", () => {
  test("the fail-closed message names both opt-outs", () => {
    const message = cannotVerifyMessage("v1.2.3", "attestation.json could not be fetched");
    expect(message).toContain("cannot verify the build provenance of v1.2.3");
    expect(message).toContain("--no-verify");
    expect(message).toContain("agent config set update.verify-provenance false");
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
