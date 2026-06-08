// Standalone source archive verifier for install.sh / install.ps1.
//
// This file is SELF-CONTAINED (no repo-internal imports, no dependencies) on purpose:
// installers download it before the release archive is extracted. It verifies the
// GitHub source archive wrapper dir includes a SHA prefix matching release metadata.
//
// Direct run:
//   bun src/install/verify-source-archive.ts <release.tgz> <expected-full-sha> [expected-sha256-or-file]
//
// Arguments:
//   <release.tgz>         GitHub release source archive downloaded by the installer.
//   <expected-full-sha>   40-character release target commit SHA from GitHub metadata.
//   [expected-sha256]     Optional 64-character SHA256, or a checksum file whose
//                         first 64-character hex token is the expected SHA256.
//
// This gives the shell/PowerShell bootstrappers a small standalone integrity gate
// before they delete/replace an existing install directory: full archive SHA256
// when GitHub reports an asset digest, plus the GitHub source archive root SHA
// marker in every case.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function sourceArchivePrefix(entryPath: string): string | null {
  const [root] = entryPath.split("/");
  const maybeSha = root?.split("-").pop()?.toLowerCase();
  return maybeSha && /^[0-9a-f]{7,40}$/.test(maybeSha) ? maybeSha : null;
}

export function verifySourceArchiveEntry(firstEntry: string, expectedSha: string): string {
  const prefix = sourceArchivePrefix(firstEntry);
  if (!prefix || !expectedSha.toLowerCase().startsWith(prefix)) {
    throw new Error(
      `release archive checksum mismatch: archive root '${firstEntry}' does not match ${expectedSha}`,
    );
  }
  return prefix;
}

export function parseSha256Checksum(text: string): string {
  const match = text.match(/\b[0-9a-f]{64}\b/i);
  if (!match) throw new Error("expected SHA256 checksum must contain a 64-character hex value");
  return match[0].toLowerCase();
}

function expectedSha256(value: string): string {
  return /^[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : parseSha256Checksum(existsSync(value) ? readFileSync(value, "utf8") : value);
}

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifySourceArchiveSha256(archive: string, expected: string): string {
  const wanted = parseSha256Checksum(expected);
  const actual = fileSha256(archive);
  if (actual !== wanted) {
    throw new Error(`release archive SHA256 mismatch: expected ${wanted}, got ${actual}`);
  }
  return actual;
}

function firstTarEntry(archive: string): string {
  const result = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || "release archive is unreadable").trim());
  }
  const firstEntry = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstEntry) throw new Error("release archive is empty");
  return firstEntry;
}

if (import.meta.main) {
  const [archive, expectedSha, expectedSha256Arg, ...extra] = process.argv.slice(2);
  if (!archive || !expectedSha || extra.length > 0) {
    process.stderr.write(
      "usage: bun verify-source-archive.ts release.tgz <expected-full-sha> [expected-sha256-or-file]\n",
    );
    process.exit(2);
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
    process.stderr.write(`expected SHA must be a 40-character hex string (got '${expectedSha}')\n`);
    process.exit(2);
  }
  try {
    if (expectedSha256Arg) {
      const hash = verifySourceArchiveSha256(archive, expectedSha256(expectedSha256Arg));
      process.stdout.write(`Verified release archive SHA256: ${hash}\n`);
    }
    const prefix = verifySourceArchiveEntry(firstTarEntry(archive), expectedSha);
    process.stdout.write(`Verified release archive source marker: ${prefix}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
