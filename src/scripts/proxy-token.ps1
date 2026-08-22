# Forwarder: the proxy-mode credential resolver moved into the CLI as `agent proxy-token`
# (src/commands/proxy_token.ts). Kept ONE release for configs written by pre-move releases
# (a re-install over an old root whose Codex/Claude wiring still runs this script); delete
# next release. This script lives at src\scripts\, so the repo root is three levels up.
# agent.ps1 ends with `exit`, which here terminates this forwarder's own powershell with
# the right code -- exactly what a forwarder wants, so no child-powershell hop is needed.
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
& (Join-Path $repo 'bin/agent.ps1') proxy-token @args
