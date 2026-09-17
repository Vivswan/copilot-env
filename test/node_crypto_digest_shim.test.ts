// The expected defaults were measured against Node 26: `crypto.sign` with no digest, then the
// explicit digest that verifies the signature. Deno 2.9 refuses an unspecified digest on a key
// whose signature takes one; Ed25519 takes none, so its undefined passes through unshimmed.
import crypto from "node:crypto";
import { defaultDigestFor, unshimmedVerify } from "../src/utils/node_crypto_digest_shim.ts";
import { describe, expect, test } from "./helpers/testing.ts";

const DATA = Buffer.from("the bytes under signature");

function ecPair(namedCurve: string) {
  return crypto.generateKeyPairSync("ec", { namedCurve });
}

/** A DSA key pair (the slowest generation here, about a second under Deno). */
function dsaPair(): crypto.KeyPairKeyObjectResult {
  return crypto.generateKeyPairSync("dsa", { modulusLength: 2048, divisorLength: 256 });
}

/** An RSA-PSS key pair restricted to `hashAlgorithm`. Deno's node typings lack
 *  the "rsa-pss" overload that Node (and Deno's runtime) support. */
function rsaPssPair(hashAlgorithm: string): crypto.KeyPairKeyObjectResult {
  const generate = crypto.generateKeyPairSync as unknown as (
    type: string,
    options: Record<string, unknown>,
  ) => crypto.KeyPairKeyObjectResult;
  return generate("rsa-pss", { modulusLength: 2048, hashAlgorithm, saltLength: 48 });
}

describe("node:crypto digest shim", () => {
  test("canary: Deno still refuses an unspecified digest on an EC key (else delete the shim)", () => {
    const { privateKey, publicKey } = ecPair("prime256v1");
    const signature = crypto.sign("sha256", DATA, privateKey);
    expect(() => unshimmedVerify(undefined, DATA, publicKey, signature)).toThrow(
      /no default digest/,
    );
  });

  test("defaultDigestFor infers Node's default per key type, from every key form verify() accepts", () => {
    const ec = ecPair("prime256v1").publicKey;
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rows: Array<[string, Parameters<typeof defaultDigestFor>[0], string | undefined]> = [
      // Node uses SHA-256 for every EC curve, not the curve-matched hash.
      ["prime256v1", ec, "sha256"],
      ["secp384r1", ecPair("secp384r1").publicKey, "sha256"],
      ["secp521r1", ecPair("secp521r1").publicKey, "sha256"],
      ["rsa", rsa.publicKey, "sha256"],
      [
        "rsa pss padding",
        { key: rsa.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
        "sha256",
      ],
      // A restricted RSA-PSS key dictates its own hash; SHA-256 would be rejected.
      ["rsa-pss sha384", rsaPssPair("sha384").publicKey, "sha384"],
      ["ed25519", crypto.generateKeyPairSync("ed25519").publicKey, undefined],
      ["dsa", dsaPair().publicKey, "sha256"],
      ["pem", ec.export({ type: "spki", format: "pem" }) as string, "sha256"],
      [
        "der",
        { key: ec.export({ type: "spki", format: "der" }), format: "der", type: "spki" },
        "sha256",
      ],
      ["jwk", { key: ec.export({ format: "jwk" }), format: "jwk" }, "sha256"],
      ["not a key", "not a key", undefined],
    ];
    for (const [label, key, digest] of rows) {
      expect(defaultDigestFor(key), label).toBe(digest);
    }
  });

  test("shimmed verify accepts an unspecified digest for every key type Node does", () => {
    const p384 = ecPair("secp384r1");
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pss = rsaPssPair("sha384");
    const ed = crypto.generateKeyPairSync("ed25519");

    // Node signs P-384 with SHA-256 when no digest is given; so must the verify.
    expect(
      crypto.verify(undefined, DATA, p384.publicKey, crypto.sign("sha256", DATA, p384.privateKey)),
    ).toBe(true);
    expect(
      crypto.verify(undefined, DATA, rsa.publicKey, crypto.sign("sha256", DATA, rsa.privateKey)),
    ).toBe(true);
    expect(
      crypto.verify(undefined, DATA, pss.publicKey, crypto.sign("sha384", DATA, pss.privateKey)),
    ).toBe(true);
    expect(crypto.verify(undefined, DATA, ed.publicKey, crypto.sign(null, DATA, ed.privateKey)))
      .toBe(true);
    const dsa = dsaPair();
    expect(
      crypto.verify(undefined, DATA, dsa.publicKey, crypto.sign("sha256", DATA, dsa.privateKey)),
    ).toBe(true);
    const rsaSig = crypto.sign("sha256", DATA, rsa.privateKey);
    expect(
      crypto.verify(
        undefined,
        DATA,
        { key: rsa.publicKey.export({ type: "spki", format: "der" }), format: "der", type: "spki" },
        rsaSig,
      ),
    ).toBe(true);
    expect(
      crypto.verify(
        undefined,
        DATA,
        { key: rsa.publicKey.export({ format: "jwk" }), format: "jwk" },
        rsaSig,
      ),
    ).toBe(true);
  });

  test("the callback overload still reports through the callback and returns undefined", async () => {
    const { privateKey, publicKey } = ecPair("prime256v1");
    const signature = crypto.sign("sha256", DATA, privateKey);
    const reported = new Promise<[Error | null, boolean]>((resolve) => {
      const returned = crypto.verify(undefined, DATA, publicKey, signature, (error, result) => {
        resolve([error, result]);
      });
      expect(returned).toBeUndefined();
    });
    expect(await reported).toEqual([null, true]);
  });

  test("a bad signature is still false, and an explicit digest passes through untouched", () => {
    const { privateKey, publicKey } = ecPair("prime256v1");
    const signature = crypto.sign("sha256", DATA, privateKey);
    expect(crypto.verify(undefined, Buffer.from("other bytes"), publicKey, signature)).toBe(false);
    expect(crypto.verify("sha256", DATA, publicKey, signature)).toBe(true);
    // An explicit digest that does not match the signature's is a false, not a
    // silently corrected true.
    expect(crypto.verify("sha384", DATA, publicKey, signature)).toBe(false);
  });
});
