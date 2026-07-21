# Windows parity of proxy-token.sh: ensure the local copilot-api proxy is up (per the rules
# in the .sh), then print its API key on stdout. Used by Codex's `auth.command` and the
# Windows cl/cx launchers. `--yes` selects the HEADLESS path (no prompt); without it, an
# unmanaged + down proxy prompts. Auto-start is gated on the managed lifecycle (the
# `auto-start` config key, queried via `config --get auto-start`). `--profile <name>` routes
# everything daemon-scoped at that NAMED profile's isolated daemon. Keep feature-matched with
# proxy-token.sh.
#
# Each `agent.ps1` call is a CHILD powershell -- agent.ps1 ends with `exit`, so invoking it
# in this host would terminate the script. Start/prompt noise goes to stderr; only the key
# reaches stdout. This script lives at src/scripts/, so the repo root is three levels up.
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$agent = Join-Path $repo 'bin/agent.ps1'
$ps = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $agent)
$yes = $false
$profileName = ''
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    '--yes' { $yes = $true }
    '--profile' { $i++; if ($i -lt $args.Count) { $profileName = $args[$i] } }
  }
}
# Daemon-scoped calls carry the profile selector; the auto-start gate (`config`) is the one
# account-wide preference and takes none.
$scope = @()
if ($profileName -ne '') { $scope = @('--profile', $profileName) }
# Human-facing hints must name the profile's daemon, or they'd point at the default one.
$startHint = 'agent start'
if ($profileName -ne '') { $startHint = "agent start --profile $profileName" }
$suppressedStart = $false

& powershell @ps start --check @scope *> $null
if ($LASTEXITCODE -ne 0) {
  $autoStart = (& powershell @ps config --get auto-start 2> $null | Out-String).Trim()
  if ($autoStart -eq 'true') {
    # Managed lifecycle on (config auto-start): auto-start without asking. Piping $null gives the
    # child an empty (non-TTY) stdin so `agent start` runs NON-interactively -- otherwise, with no
    # stored credential, it would render an auth prompt whose output is suppressed here (an
    # invisible hang). Output suppressed so it can't pollute the eval'd token; remember we tried,
    # to surface a hard failure below (else cl/cx exit silently on a bad credential).
    $null | & powershell @ps start @scope *> $null
    $suppressedStart = $true
  } elseif (-not $yes) {
    # Unmanaged + interactive (launcher): offer to start.
    [Console]::Error.Write('copilot proxy not running. Start it now? [Y/n] ')
    $ans = Read-Host
    if ($ans -eq '' -or $ans -match '^(y|Y|yes|Yes)$') {
      # Send the child's stdout (success stream, where consola progress goes) to OUR stderr so
      # it stays VISIBLE while our stdout stays clean for the key -- matching the .sh twin's
      # `>&2`. `1>&2` is INVALID in Windows PowerShell (you can only merge into stream 1), so
      # pipe stdout through [Console]::Error.WriteLine (the repo's established pattern).
      & powershell @ps start @scope | ForEach-Object { [Console]::Error.WriteLine($_) }
    } else {
      [Console]::Error.WriteLine("Continuing without the proxy; proxy-backed agents need it (run '$startHint').")
    }
  }
  # Unmanaged + --yes (headless): never auto-start.
}

# Record the activity heartbeat, then print the key only if the proxy is actually up.
& powershell @ps start --record-event @scope *> $null
& powershell @ps start --check @scope *> $null
if ($LASTEXITCODE -eq 0) {
  & powershell @ps auth --print-proxy-token @scope
  exit $LASTEXITCODE
}
# Proxy still down. If we auto-started with output suppressed, the daemon's own error was hidden,
# so surface a one-line pointer -- otherwise cl/cx exit silently with no clue why.
if ($suppressedStart) {
  [Console]::Error.WriteLine("copilot proxy failed to start (run '$startHint' to see the error).")
}
exit 1
