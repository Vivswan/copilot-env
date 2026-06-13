#!/bin/sh
# Proxy-mode credential resolver, SHARED by Codex's `auth.command` and Claude's
# `apiKeyHelper`: ensure the local copilot-api proxy is running (start it if down), then
# print its API key. The `&&` prints a key only once `start --ensure` confirms the proxy
# is up (its non-zero exit on failure skips the print). scripts/proxy-token.ps1 is the
# Windows parity copy -- keep the two feature-matched.
#
# Goes through bin/agent (NOT `bun src/cli.ts` directly) so bun + node_modules are
# bootstrapped first -- bin/agent installs bun when it is only at ~/.bun/bin and not on
# PATH, and (re)installs deps when node_modules is missing or stale. Its install chatter
# goes to stderr, so the `auth --print-proxy-token` stdout stays a clean key.
dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$dir/bin/agent" start --ensure >/dev/null 2>&1 && exec "$dir/bin/agent" auth --print-proxy-token
