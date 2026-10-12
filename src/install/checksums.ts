// The release's checksums.txt: the `shasum -a 256`-form manifest scripts/compile.ts emits next
// to the binaries. install.sh / install.ps1 verify the same file with the platform's own sha256
// tool before the binary lands; this module is the in-process twin `agent update` uses.
import { sha256Hex } from "../utils/digest.ts";
import * as fs from "../utils/fs_facade.ts";

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

export function expectedDigest(checksums: Checksums, name: string): string {
  const digest = checksums.get(name);
  if (!digest) throw new Error(`checksums.txt has no entry for ${name}`);
  return digest;
}

/** The disk's in every mode: no run plans the file it streams. */
export async function fileSha256(path: string): Promise<string> {
  return await sha256Hex(await fs.openReadable(path));
}
