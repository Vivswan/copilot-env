// Standalone source archive verifier for install.sh / install.ps1.
//
// This file is SELF-CONTAINED (no repo-internal imports, no dependencies) on purpose:
// installers download it before the release archive is extracted. It verifies the
// GitHub source archive wrapper dir includes a SHA prefix matching release metadata.
//
// Direct run:
//   bun src/install/verify-source-archive.ts <release.tgz> <expected-full-sha>
//
// Arguments:
//   <release.tgz>         GitHub release source archive downloaded by the installer.
//   <expected-full-sha>   40-character release target commit SHA from GitHub metadata.
//
// This gives the shell/PowerShell bootstrappers a small standalone checksum gate
// before they delete/replace an existing install directory.

import { spawnSync } from "node:child_process";

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
  const [archive, expectedSha, ...extra] = process.argv.slice(2);
  if (!archive || !expectedSha || extra.length > 0) {
    process.stderr.write("usage: bun verify-source-archive.ts release.tgz <expected-full-sha>\n");
    process.exit(2);
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
    process.stderr.write(`expected SHA must be a 40-character hex string (got '${expectedSha}')\n`);
    process.exit(2);
  }
  try {
    const prefix = verifySourceArchiveEntry(firstTarEntry(archive), expectedSha);
    process.stdout.write(`Verified release archive checksum: ${prefix}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
