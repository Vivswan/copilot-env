#!/usr/bin/env bash
# End-to-end daemon lifecycle smoke, run by CI on every OS (git-bash on the
# Windows runner) with COPILOT_API_ENTRY pointing at the fake proxy
# (test/copilot-api-fake.mjs) so no Copilot auth is needed. process.ts spawns a
# detached daemon, `start` waits for it to listen + syncs aliases, `stop`
# verifies the tracked pid is ours and signals it. `health --scope runtime` is
# the cross-check: it must pass (exit 0) while the daemon is up and fail (exit
# 1) once it's down, so start/stop and the runtime probe verify each other.
# -e is on, so any unexpected non-zero (and the inverted post-stop checks)
# fails the run. `::error::` lines surface as GitHub annotations.
set -euo pipefail

# This script rewires agent configs and manages real daemons in whatever HOME
# it sees, so it refuses to start outside a container or a disposable CI
# runner. On a developer machine, run it through the container:
#   deno task test:docker --lifecycle
if [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ] && [ "${GITHUB_ACTIONS:-}" != "true" ]; then
    echo "::error::lifecycle-smoke.sh mutates the HOME it runs in; use 'deno task test:docker --lifecycle' on a developer machine" >&2
    exit 1
fi

cli() {
    deno run -P=test src/cli.ts "$@"
}

fail() {
    echo "::error::$1 on ${RUNNER_OS:-$(uname)}"
    exit 1
}

readpid() {
    deno eval 'import {CopilotEnvRunState} from "./src/copilot_api/state.ts"; process.stdout.write(String(new CopilotEnvRunState().read().pid))'
}
readprofilepid() {
    deno eval 'import {CopilotEnvRunState} from "./src/copilot_api/state.ts"; process.stdout.write(String(CopilotEnvRunState.forProfile("work").read().pid))'
}
pidalive() {
    deno eval 'try { process.kill(Number(Deno.args[0]), 0); Deno.exit(0); } catch { Deno.exit(1); }' "$1"
}

cli start
cli health --scope runtime

# Managed-lifecycle idempotency (auto-start on): a redundant `start` is a no-op -- it must
# keep the SAME daemon pid (not restart and disrupt a connected agent); `--force` launches
# a fresh daemon (new pid). In the default/unmanaged mode `start` still restarts. Capture
# `start` output (so a nonzero exit fails the run, not just grep) and gate on the
# "[start:noop]" machine marker (an external contract emitted by src/commands/start.ts,
# so the human wording around it can change freely).
cli config --set auto-start true
pid_before=$(readpid)
out=$(cli start)
echo "$out" | grep -qF "[start:noop]" || fail "managed redundant start did not no-op"
pid_after=$(readpid)
[ "$pid_before" = "$pid_after" ] || fail "managed redundant start changed the pid ($pid_before -> $pid_after)"
cli health --scope runtime
cli start --force
pid_forced=$(readpid)
[ "$pid_after" != "$pid_forced" ] || fail "start --force did not relaunch a fresh daemon"
cli health --scope runtime
cli config --del auto-start

cli codex --proxy
cli claude --proxy
cli health --scope setup
echo "health OK while running on ${RUNNER_OS:-$(uname)}"

# Named-profile daemon BESIDE the default: one `agent profile --add` wires its own
# credential + mode + BOTH agents; its daemon gets an isolated home and reserved
# port; stopping/deleting it must leave the default daemon untouched.
cli profile --add work --proxy --provider gh-token --set fake-profile-token
cli profile --list | grep -q "work" || fail "profile --list did not report the work profile"
cli auth --list | grep -q "work" || fail "auth --list did not report the work profile"
rc=0
cli profile --check work || rc=$?
[ "$rc" -eq 2 ] || fail "profile --check work should exit 2 (proxy), got $rc"
cli start --profile work
cli start --check --profile work
cli start --check
[ "$(readpid)" != "$(readprofilepid)" ] || fail "profile daemon shares the default pid"
work_pid=$(readprofilepid)
cli stop --profile work
# `stop` clears the tracked pid, so `start --check` alone can't prove the PROCESS
# died -- assert on the saved pid directly (SIGTERM is async; allow a short grace).
for _ in 1 2 3 4 5; do
    pidalive "$work_pid" || break
    sleep 1
done
if pidalive "$work_pid"; then
    fail "profile daemon (pid $work_pid) survived stop --profile"
fi
if cli start --check --profile work; then
    fail "profile daemon still up after stop --profile"
fi
cli start --check || fail "default daemon died with the profile daemon"
cli profile --del work
if cli profile --check work >/dev/null 2>&1; then
    fail "profile still exists after profile --del"
fi
echo "profile daemon lifecycle OK on ${RUNNER_OS:-$(uname)}"

cli stop
if cli health --scope runtime; then
    fail "health reported healthy after stop"
fi
echo "start/stop + health OK on ${RUNNER_OS:-$(uname)}"
