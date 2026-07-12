# Windows parity of proxy-token.sh: ensure the local copilot-api proxy is up (per the rules
# in the .sh), then print its API key on stdout. Used by Codex's `auth.command` and the
# Windows cl/cx launchers. `--yes` selects the HEADLESS path (no prompt); without it, an
# unmanaged + down proxy prompts. Auto-start is gated on the managed lifecycle (the
# `auto-start` config key, queried via `config --get auto-start`). Keep feature-matched with proxy-token.sh.
#
# Each `agent.ps1` call is a CHILD powershell -- agent.ps1 ends with `exit`, so invoking it
# in this host would terminate the script. Start/prompt noise goes to stderr; only the key
# reaches stdout. This script lives at src/scripts/, so the repo root is three levels up.
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$agent = Join-Path $repo 'bin/agent.ps1'
$ps = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $agent)
$yes = ($args.Count -ge 1 -and $args[0] -eq '--yes')
$suppressedStart = $false

& powershell @ps start --check *> $null
if ($LASTEXITCODE -ne 0) {
  $autoStart = (& powershell @ps config --get auto-start 2> $null | Out-String).Trim()
  if ($autoStart -eq 'true') {
    # Managed lifecycle on (config auto-start): auto-start without asking. Piping $null gives the
    # child an empty (non-TTY) stdin so `agent start` runs NON-interactively -- otherwise, with no
    # stored credential, it would render an auth prompt whose output is suppressed here (an
    # invisible hang). Output suppressed so it can't pollute the eval'd token; remember we tried,
    # to surface a hard failure below (else cl/cx exit silently on a bad credential).
    $null | & powershell @ps start *> $null
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
      & powershell @ps start | ForEach-Object { [Console]::Error.WriteLine($_) }
    } else {
      [Console]::Error.WriteLine("Continuing without the proxy; proxy-backed agents need it (run 'agent start').")
    }
  }
  # Unmanaged + --yes (headless): never auto-start.
}

# Record the activity heartbeat, then print the key only if the proxy is actually up.
& powershell @ps start --record-event *> $null
& powershell @ps start --check *> $null
if ($LASTEXITCODE -eq 0) {
  & powershell @ps auth --print-proxy-token
  exit $LASTEXITCODE
}
# Proxy still down. If we auto-started with output suppressed, the daemon's own error was hidden,
# so surface a one-line pointer -- otherwise cl/cx exit silently with no clue why.
if ($suppressedStart) {
  [Console]::Error.WriteLine("copilot proxy failed to start (run 'agent start' to see the error).")
}
exit 1
