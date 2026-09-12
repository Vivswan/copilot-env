// The release's checksums.txt: the `shasum -a 256`-form manifest scripts/compile.ts emits next
// to the binaries. install.sh / install.ps1 verify the same file with the platform's own sha256
// tool before the binary lands; this module is the in-process twin `agent update` uses.
import { crypto } from "@std/crypto";

/** One parsed manifest line: the expected lowercase hex digest for a file. */
export type Checksums = ReadonlyMap<string, string>;

/** A leading `*` on the name marks binary mode in both tools' output and is not part of the file
 *  name. Malformed lines are skipped rather than throwing: the caller fails on the ONE name it
 *  needs being absent, the error a user can act on. */
export function parseChecksums(text: string): Checksums {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S.*)$/i);
    const [, digest, name] = match ?? [];
    if (digest && name) entries.set(name, digest.toLowerCase());
  }
  return entries;
}

/** The expected digest for `name`, or a throw naming what the manifest lacked. */
export function expectedDigest(checksums: Checksums, name: string): string {
  const digest = checksums.get(name);
  if (!digest) throw new Error(`checksums.txt has no entry for ${name}`);
  return digest;
}

/** SHA256 of a file on disk as lowercase hex, hashed by streaming it rather
 *  than reading it whole: release binaries run to tens of megabytes. */
export async function fileSha256(path: string): Promise<string> {
  using file = await Deno.open(path, { read: true });
  const digest = await crypto.subtle.digest("SHA-256", file.readable);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
