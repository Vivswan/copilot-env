# Windows parity of proxy-token.sh: ensure the local copilot-api proxy is running, then
# print its API key. Used by Codex's `auth.command` (and, on POSIX, Claude's helper uses
# the .sh). `if ($LASTEXITCODE -ne 0)` is the `&&` gate (Windows PowerShell 5.1 lacks
# `&&`); the script `exit`s with the failing code so Codex sees a failed auth command
# rather than an empty successful one.
#
# Goes through bin/agent.ps1 (NOT `bun src/cli.ts` directly) so bun + node_modules are
# bootstrapped first. agent.ps1 ends with `exit`, so each call is a CHILD powershell --
# invoking it in this host would terminate the script before the gate/print.
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$agent = Join-Path $repo 'bin/agent.ps1'
& powershell -NoProfile -ExecutionPolicy Bypass -File $agent start --ensure *> $null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell -NoProfile -ExecutionPolicy Bypass -File $agent auth --print-proxy-token
exit $LASTEXITCODE
