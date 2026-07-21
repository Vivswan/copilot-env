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
# `--profile <name>` routes everything daemon-scoped (the liveness check, the start, the
# heartbeat, the key) at that NAMED profile's isolated daemon; the auto-start gate stays the
# one account-wide preference.
#
# Calls go through bin/agent (NOT `bun src/cli.ts`) so bun + node_modules are bootstrapped
# first. Start/prompt noise goes to stderr; only the key reaches stdout. This script lives at
# src/scripts/, so the repo root is two levels up.
dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
agent="$dir/bin/agent"

yes=0
profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) yes=1 ;;
    --profile)
      shift
      profile="$1"
      ;;
  esac
  shift
done
suppressed_start=0
# Human-facing hints must name the profile's daemon, or they'd point at the default one.
start_hint="agent start"
[ -n "$profile" ] && start_hint="agent start --profile $profile"

# Run `agent <args...>`, appending `--profile <name>` when one was selected. Every call
# below is daemon-scoped, so the selector applies uniformly (the auto-start gate goes
# through `config`, which takes no profile).
agent_scoped() {
  if [ -n "$profile" ]; then
    "$agent" "$@" --profile "$profile"
  else
    "$agent" "$@"
  fi
}

if ! agent_scoped start --check >/dev/null 2>&1; then
  if [ "$("$agent" config --get auto-start 2>/dev/null)" = "true" ]; then
    # Managed lifecycle on (config auto-start): auto-start the proxy without asking. stdin is
    # redirected from /dev/null so `agent start` runs NON-interactively -- otherwise, with no
    # stored credential, it would render an auth prompt whose output is suppressed here (an
    # invisible hang). Output is suppressed so it can't pollute the eval'd token; remember we
    # tried, to surface a hard failure below (else cl/cx would exit silently on a bad credential).
    agent_scoped start </dev/null >/dev/null 2>&1
    suppressed_start=1
  elif [ "$yes" -ne 1 ]; then
    # Unmanaged + interactive (launcher): offer to start.
    printf 'copilot proxy not running. Start it now? [Y/n] ' >&2
    read -r ans
    case "$ans" in
      ''|y|Y|yes|Yes) agent_scoped start >&2 ;;
      *) echo "Continuing without the proxy; proxy-backed agents need it (run '$start_hint')." >&2 ;;
    esac
  fi
  # Unmanaged + --yes (headless): never auto-start.
fi

# Record the activity heartbeat (keeps an open agent's proxy alive), then print the key only
# if the proxy is actually up. Down => non-zero exit and no token.
agent_scoped start --record-event >/dev/null 2>&1
if agent_scoped start --check >/dev/null 2>&1; then
  if [ -n "$profile" ]; then
    exec "$agent" auth --print-proxy-token --profile "$profile"
  fi
  exec "$agent" auth --print-proxy-token
fi
# Proxy still down. If we auto-started with output suppressed, the daemon's own error was hidden,
# so surface a one-line pointer -- otherwise cl/cx exit silently with no clue why.
[ "$suppressed_start" -eq 1 ] &&
  echo "copilot proxy failed to start (run '$start_hint' to see the error)." >&2
exit 1
