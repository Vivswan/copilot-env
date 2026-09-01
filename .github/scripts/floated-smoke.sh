#!/usr/bin/env bash
# Floated-proxy smoke: the ONE run that uses the REAL @jeffreycao/copilot-api
# instead of test/copilot-api-fake.mjs.
#
# It cannot complete a lifecycle, because the real proxy needs a Copilot
# credential and there is none here. What it CAN prove, and what nothing else
# covers, is everything up to that point: the float resolves a version against
# the live registry and installs it, the daemon spawns under the production
# permission set with its `--preload` shims, and it runs far enough to start
# resolving an auth provider. The daemon dying for want of a credential after
# that is the expected end state, not a failure.
#
# Run it through the container, which is where the throwaway HOME comes from:
#   deno task test:docker --floated-lifecycle
set -euo pipefail

if [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ] && [ "${GITHUB_ACTIONS:-}" != "true" ]; then
    echo "::error::floated-smoke.sh floats a real proxy into the HOME it runs in; use 'deno task test:docker --floated-lifecycle' on a developer machine" >&2
    exit 1
fi

fail() {
    echo "::error::$1"
    exit 1
}

start_output="$(mktemp)"
# Expected to exit non-zero: no credential. The assertions are on what it got
# through first, so the exit code alone tells us nothing.
deno run -P=cli src/cli.ts start >"$start_output" 2>&1 || true
echo "--- agent start output ---"
cat "$start_output"

# 1. The float actually reached the registry, picked a version, and installed it.
#    This is the only run that exercises that path end to end.
grep -q "now using @jeffreycao/copilot-api@" "$start_output" ||
    fail "the proxy float did not resolve and install a version"

proxy_log="$(find "${HOME}/.local/share/copilot-env" -name '.log' -print -quit 2>/dev/null || true)"
[ -n "$proxy_log" ] || fail "the daemon never wrote a proxy log"
echo "--- proxy log ---"
cat "$proxy_log"

# The daemon must run against OUR home, not the npm package's own default: a
# recreated legacy dir means the spawn stopped pinning COPILOT_API_HOME.
[ ! -d "${HOME}/.local/share/copilot-api" ] ||
    fail "the daemon recreated the legacy copilot-api home"

# 2. THE regression this job exists for: the daemon must not die on a permission
#    the production grant list cannot express. The real proxy's dependency tree
#    probes the environment in ways the fake never does -- that is how the
#    /proc read that needs node_compat_preload.ts was found in the first place.
if grep -qE "NotCapable|Requires all access" "$proxy_log"; then
    fail "the daemon hit a permission error under the production grant set"
fi

# 3. It ran far enough to start resolving a credential. Matched loosely on
#    purpose: the wording belongs to upstream copilot-api, and this job should
#    fail for our regressions, not for their copy edits.
grep -qiE "provider|auth" "$proxy_log" ||
    fail "the daemon never reached auth-provider resolution; see the log above"

rm -f "$start_output"
echo "floated proxy smoke OK on ${RUNNER_OS:-$(uname)}: float installed a version, daemon started under the production permissions and reached auth"
