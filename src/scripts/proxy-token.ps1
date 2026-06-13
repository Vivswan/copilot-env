# Windows parity of proxy-token.sh: ensure the local copilot-api proxy is up (per the rules
# in the .sh), then print its API key on stdout. Used by Codex's `auth.command` and the
# Windows cl/cx launchers. `--yes` selects the HEADLESS path (no prompt); without it, an
# unmanaged + down proxy prompts. Auto-start is gated on the managed lifecycle
# (`init --get-auto-start`). Keep feature-matched with proxy-token.sh.
#
# Each `agent.ps1` call is a CHILD powershell -- agent.ps1 ends with `exit`, so invoking it
# in this host would terminate the script. Start/prompt noise goes to stderr; only the key
# reaches stdout. This script lives at src/scripts/, so the repo root is three levels up.
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$agent = Join-Path $repo 'bin/agent.ps1'
$ps = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $agent)
$yes = ($args.Count -ge 1 -and $args[0] -eq '--yes')

& powershell @ps start --check *> $null
if ($LASTEXITCODE -ne 0) {
  & powershell @ps init --get-auto-start *> $null
  if ($LASTEXITCODE -eq 0) {
    # Managed lifecycle on: auto-start without asking.
    & powershell @ps start *> $null
  } elseif (-not $yes) {
    # Unmanaged + interactive (launcher): offer to start.
    [Console]::Error.Write('copilot proxy not running. Start it now? [Y/n] ')
    $ans = Read-Host
    if ($ans -eq '' -or $ans -match '^(y|Y|yes|Yes)$') {
      # Discard stdout (the success stream) so it can't mix with the key; the proxy's
      # progress goes to stderr (error stream), which stays visible. (`*>&2` is invalid
      # PowerShell -- only merge-to-success `*>&1` exists.)
      & powershell @ps start 1> $null
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
exit 1
