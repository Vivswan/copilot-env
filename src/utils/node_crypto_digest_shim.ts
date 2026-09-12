// Node's `crypto.verify(undefined, data, key, sig)` infers the digest from the key; Deno 2.9 throws
// "no default digest" instead, and the Sigstore stack (tuf-js, @sigstore/core) calls it that way
// throughout. Import for the side effect before the first sigstore import;
// src/install/provenance.ts does.
//
// Retire when Deno infers the digest itself: the canary in test/node_crypto_digest_shim.test.ts
// asserts the unshimmed call still throws, so its failure is the signal to delete this file and its
// import.
import crypto from "node:crypto";

type VerifyFn = typeof crypto.verify;
type VerifyKey = Parameters<VerifyFn>[2];

/** The runtime's own `verify`, kept for the canary test. */
export const unshimmedVerify: VerifyFn = crypto.verify;

/** Node's own defaults, measured against Node 26. Exported for tests. */
export function defaultDigestFor(key: VerifyKey): string | undefined {
  const keyObject = toKeyObject(key);
  if (!keyObject) return undefined;
  switch (keyObject.asymmetricKeyType) {
    case "ec":
    case "rsa":
    case "dsa":
      return "sha256";
    case "rsa-pss":
      return keyObject.asymmetricKeyDetails?.hashAlgorithm ?? "sha256";
    default:
      return undefined;
  }
}

/** createPublicKey ignores the extra signature options on a `{ key, format, ... }` wrapper, so the
 *  whole wrapper can be handed to it. */
function toKeyObject(key: VerifyKey): crypto.KeyObject | null {
  if (key instanceof crypto.KeyObject) return key;
  if (typeof key === "object" && key !== null && !Buffer.isBuffer(key) && "key" in key) {
    const inner = (key as { key: unknown }).key;
    if (inner instanceof crypto.KeyObject) return inner;
  }
  try {
    return crypto.createPublicKey(key as crypto.PublicKeyInput);
  } catch {
    return null;
  }
}

const shimmedVerify: VerifyFn = ((
  algorithm: Parameters<VerifyFn>[0],
  data: Parameters<VerifyFn>[1],
  key: VerifyKey,
  signature: Parameters<VerifyFn>[3],
  callback?: (error: Error | null, result: boolean) => void,
) => {
  const digest = algorithm ?? defaultDigestFor(key);
  return callback === undefined
    ? unshimmedVerify(digest, data, key, signature)
    : unshimmedVerify(digest, data, key, signature, callback);
}) as VerifyFn;

// A plain assignment is a type error on a module namespace member; the CJS
// module object the sigstore packages `require()` is this same object, and its
// `verify` property is writable.
Object.defineProperty(crypto, "verify", {
  value: shimmedVerify,
  writable: true,
  configurable: true,
});
