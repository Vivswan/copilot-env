// Installs PSScriptAnalyzer for the PowerShell lint step (checks.yml, windows-latest) through pwsh.
// The second attempt is for the runner's transient gallery failure (NuGet "Missing option value
// for: '-source'", then "No repository with the name 'PSGallery'"); the lint itself, in the next
// step, is never retried.
import { spawnSync } from "node:child_process";
import { RetryError, retry } from "@std/async";
import { errMessage } from "../../src/utils/error.ts";

/** Two attempts, ten seconds apart: the second is for the gallery failure the header names. */
const RETRY = { maxAttempts: 2, minTimeout: 10_000, jitter: 0 };

/** One module download from the gallery, well under a minute on a healthy runner. */
const PWSH_TIMEOUT_MS = 300_000;

/** Registers PSGallery when the runner left none, trusts it, installs; 'Stop' makes any error a nonzero exit. */
const SETUP = [
  "$ErrorActionPreference = 'Stop'",
  "if (-not (Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue)) { Register-PSRepository -Default }",
  "Set-PSRepository -Name PSGallery -InstallationPolicy Trusted",
  "Install-Module PSScriptAnalyzer -Force -Scope CurrentUser -SkipPublisherCheck",
].join("; ");

/** Only the last stderr line travels in the error: a GitHub annotation ends at a newline. */
function installPsScriptAnalyzer(): void {
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", SETUP], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "pipe"],
    timeout: PWSH_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;

  const stderr = result.stderr.trim();
  process.stderr.write(`${stderr}\n`);
  throw new Error(stderr.split("\n").at(-1) ?? "");
}

try {
  await retry(installPsScriptAnalyzer, RETRY);
} catch (e) {
  const cause = e instanceof RetryError ? e.cause : e;
  console.error(
    `::error::PSScriptAnalyzer did not install in ${RETRY.maxAttempts} attempts: ${errMessage(cause)}`,
  );
  process.exit(1);
}
