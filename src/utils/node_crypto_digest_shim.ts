// Side-effect module: make node:crypto's `verify()` infer the digest from the key
// when the caller passes none, the way Node does.
//
// Node's `crypto.verify(undefined, data, key, sig)` picks the digest from the
// key: SHA-256 for EC and RSA keys, an RSA-PSS key's own hash restriction, and
// no digest at all for Ed25519/Ed448. Deno 2.9's node:crypto throws "no default
// digest" on the same call. The Sigstore verification stack (tuf-js for the
// trust-root metadata, @sigstore/core for the bundle signatures) calls verify
// that way throughout, so without this shim the provenance check cannot run
// under Deno at all.
//
// The shim ONLY fills in a missing algorithm; an explicit one passes through
// untouched, and `sign()` is not patched. It must be imported (for its side
// effect) before the first sigstore import -- src/install/provenance.ts does.
//
// Retire it when Deno infers the digest itself: the canary in
// test/node_crypto_digest_shim.test.ts asserts the unshimmed call still throws,
// so its failure is the signal to delete this file and its import.
import crypto from "node:crypto";

type VerifyFn = typeof crypto.verify;
type VerifyKey = Parameters<VerifyFn>[2];

/** The runtime's own `verify`, kept for the canary test. */
export const unshimmedVerify: VerifyFn = crypto.verify;

/** Node's default digest for `key` (measured against Node 26): SHA-256 for EC,
 *  RSA, and DSA, the key's own hash for a restricted RSA-PSS key, undefined for
 *  the digest-less Ed25519/Ed448 and for anything that is not a readable public
 *  key. Exported for tests. */
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

/** Read any accepted `verify()` key form as a public KeyObject: a KeyObject, a
 *  PEM string/Buffer, or a `{ key, format, type, ... }` wrapper (whose extra
 *  signature options `createPublicKey` ignores). */
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

// Both overloads are forwarded: the synchronous one returns the boolean, the
// callback one (a fifth argument) returns undefined and reports through it.
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
