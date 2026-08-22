#!/bin/sh
# Forwarder: the proxy-mode credential resolver moved into the CLI as `agent proxy-token`
# (src/commands/proxy_token.ts). Kept ONE release for configs written by pre-move releases
# (a re-install over an old root whose Codex/Claude wiring still execs this script); delete
# next release. This script lives at src/scripts/, so the repo root is two levels up.
dir=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
exec "$dir/bin/agent" proxy-token "$@"
