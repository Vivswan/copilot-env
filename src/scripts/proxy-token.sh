#!/bin/sh
# Proxy-mode credential resolver, SHARED by Codex's `auth.command`, Claude's `apiKeyHelper`,
# and the cl/cx shell launchers. It ensures the local copilot-api proxy is up (per the rules
# below), then prints its API key on stdout. src/scripts/proxy-token.ps1 is the Windows
# parity copy -- keep the two feature-matched.
#
# `--yes` selects the HEADLESS path: Codex/Claude run this on a timer and can't answer a
# prompt, so they pass `--yes`. Without it (the cl/cx launcher), an unmanaged + down proxy
# prompts the user. Auto-start is gated on the managed lifecycle (the `auto-start` config key,
# queried via `config --get auto-start`) -- so the opt-in is honored on the headless path.
#
# Calls go through bin/agent (NOT `bun src/cli.ts`) so bun + node_modules are bootstrapped
# first. Start/prompt noise goes to stderr; only the key reaches stdout. This script lives at
# src/scripts/, so the repo root is two levels up.
dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
agent="$dir/bin/agent"

yes=0
[ "$1" = "--yes" ] && yes=1
suppressed_start=0

if ! "$agent" start --check >/dev/null 2>&1; then
  if [ "$("$agent" config --get auto-start 2>/dev/null)" = "true" ]; then
    # Managed lifecycle on (config auto-start): auto-start the proxy without asking. Output is
    # suppressed so it can't pollute the eval'd token; remember we tried, to surface a hard
    # failure below (else cl/cx would just exit silently on e.g. a bad credential).
    "$agent" start >/dev/null 2>&1
    suppressed_start=1
  elif [ "$yes" -ne 1 ]; then
    # Unmanaged + interactive (launcher): offer to start.
    printf 'copilot proxy not running. Start it now? [Y/n] ' >&2
    read -r ans
    case "$ans" in
      ''|y|Y|yes|Yes) "$agent" start >&2 ;;
      *) echo "Continuing without the proxy; proxy-backed agents need it (run 'agent start')." >&2 ;;
    esac
  fi
  # Unmanaged + --yes (headless): never auto-start.
fi

# Record the activity heartbeat (keeps an open agent's proxy alive), then print the key only
# if the proxy is actually up. Down => non-zero exit and no token.
"$agent" start --record-event >/dev/null 2>&1
if "$agent" start --check >/dev/null 2>&1; then
  exec "$agent" auth --print-proxy-token
fi
# Proxy still down. If we auto-started with output suppressed, the daemon's own error was hidden,
# so surface a one-line pointer -- otherwise cl/cx exit silently with no clue why.
[ "$suppressed_start" -eq 1 ] &&
  echo "copilot proxy failed to start (run 'agent start' to see the error)." >&2
exit 1
