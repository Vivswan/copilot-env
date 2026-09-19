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

  test("shimmed verify infers Node's default digest for every key type, from every key form verify() accepts", () => {
    const ec = ecPair("prime256v1");
    const p384 = ecPair("secp384r1");
    const p521 = ecPair("secp521r1");
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pss = rsaPssPair("sha384");
    const ed = crypto.generateKeyPairSync("ed25519");
    const dsa = dsaPair();
    const pssPadding = { padding: crypto.constants.RSA_PKCS1_PSS_PADDING };
    const ecSig = crypto.sign("sha256", DATA, ec.privateKey);
    const rsaSig = crypto.sign("sha256", DATA, rsa.privateKey);
    const rows: Array<{
      label: string;
      key: Parameters<typeof defaultDigestFor>[0];
      digest: string | undefined;
      /** Node's signature for the key under its default digest; null where none can be made: a
       *  value that is no key, or a curve Deno cannot sign with. */
      signature: Buffer | null;
    }> = [
      // Node uses SHA-256 for every EC curve, not the curve-matched hash.
      { label: "prime256v1", key: ec.publicKey, digest: "sha256", signature: ecSig },
      {
        label: "secp384r1",
        key: p384.publicKey,
        digest: "sha256",
        signature: crypto.sign("sha256", DATA, p384.privateKey),
      },
      {
        label: "secp521r1",
        key: p521.publicKey,
        digest: "sha256",
        signature: null,
      },
      { label: "rsa", key: rsa.publicKey, digest: "sha256", signature: rsaSig },
      {
        label: "rsa pss padding",
        key: { key: rsa.publicKey, ...pssPadding },
        digest: "sha256",
        signature: crypto.sign("sha256", DATA, { key: rsa.privateKey, ...pssPadding }),
      },
      // A restricted RSA-PSS key dictates its own hash; SHA-256 would be rejected.
      {
        label: "rsa-pss sha384",
        key: pss.publicKey,
        digest: "sha384",
        signature: crypto.sign("sha384", DATA, pss.privateKey),
      },
      // Ed25519 takes no digest: the undefined passes through unshimmed.
      {
        label: "ed25519",
        key: ed.publicKey,
        digest: undefined,
        signature: crypto.sign(null, DATA, ed.privateKey),
      },
      {
        label: "dsa",
        key: dsa.publicKey,
        digest: "sha256",
        signature: crypto.sign("sha256", DATA, dsa.privateKey),
      },
      {
        label: "pem",
        key: ec.publicKey.export({ type: "spki", format: "pem" }) as string,
        digest: "sha256",
        signature: ecSig,
      },
      {
        label: "ec der",
        key: {
          key: ec.publicKey.export({ type: "spki", format: "der" }),
          format: "der",
          type: "spki",
        },
        digest: "sha256",
        signature: ecSig,
      },
      {
        label: "rsa der",
        key: {
          key: rsa.publicKey.export({ type: "spki", format: "der" }),
          format: "der",
          type: "spki",
        },
        digest: "sha256",
        signature: rsaSig,
      },
      {
        label: "ec jwk",
        key: { key: ec.publicKey.export({ format: "jwk" }), format: "jwk" },
        digest: "sha256",
        signature: ecSig,
      },
      {
        label: "rsa jwk",
        key: { key: rsa.publicKey.export({ format: "jwk" }), format: "jwk" },
        digest: "sha256",
        signature: rsaSig,
      },
      { label: "not a key", key: "not a key", digest: undefined, signature: null },
    ];
    for (const { label, key, digest, signature } of rows) {
      expect(defaultDigestFor(key), label).toBe(digest);
      if (signature !== null) {
        expect(crypto.verify(undefined, DATA, key, signature), label).toBe(true);
      }
    }
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
