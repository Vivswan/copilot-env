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

fail() {
    echo "::error::$1 on ${RUNNER_OS:-$(uname)}"
    exit 1
}

readpid() {
    bun -e 'import {CopilotEnvRunState} from "./src/copilot_api/state.ts"; process.stdout.write(String(new CopilotEnvRunState().read().pid))'
}
readprofilepid() {
    bun -e 'import {CopilotEnvRunState} from "./src/copilot_api/state.ts"; process.stdout.write(String(CopilotEnvRunState.forProfile("work").read().pid))'
}
pidalive() {
    bun -e 'try { process.kill(Number(process.argv[1]), 0); process.exit(0); } catch { process.exit(1); }' "$1"
}

bun src/cli.ts start
bun src/cli.ts health --scope runtime

# Managed-lifecycle idempotency (auto-start on): a redundant `start` is a no-op -- it must
# keep the SAME daemon pid (not restart and disrupt a connected agent); `--force` launches
# a fresh daemon (new pid). In the default/unmanaged mode `start` still restarts. Capture
# `start` output (so a nonzero exit fails the run, not just grep) and compare pids.
bun src/cli.ts config --set auto-start true
pid_before=$(readpid)
out=$(bun src/cli.ts start)
echo "$out" | grep -q "already running" || fail "managed redundant start did not no-op"
pid_after=$(readpid)
[ "$pid_before" = "$pid_after" ] || fail "managed redundant start changed the pid ($pid_before -> $pid_after)"
bun src/cli.ts health --scope runtime
bun src/cli.ts start --force
pid_forced=$(readpid)
[ "$pid_after" != "$pid_forced" ] || fail "start --force did not relaunch a fresh daemon"
bun src/cli.ts health --scope runtime
bun src/cli.ts config --del auto-start

bun src/cli.ts codex --proxy
bun src/cli.ts claude --proxy
bun src/cli.ts health --scope setup
echo "health OK while running on ${RUNNER_OS:-$(uname)}"

# Named-profile daemon BESIDE the default: one `agent profile --add` wires its own
# credential + mode + BOTH agents; its daemon gets an isolated home and reserved
# port; stopping/deleting it must leave the default daemon untouched.
bun src/cli.ts profile --add work --proxy --provider gh-token --set fake-profile-token
bun src/cli.ts profile --list | grep -q "work" || fail "profile --list did not report the work profile"
bun src/cli.ts auth --list | grep -q "work" || fail "auth --list did not report the work profile"
rc=0
bun src/cli.ts profile --check work || rc=$?
[ "$rc" -eq 2 ] || fail "profile --check work should exit 2 (proxy), got $rc"
bun src/cli.ts start --profile work
bun src/cli.ts start --check --profile work
bun src/cli.ts start --check
[ "$(readpid)" != "$(readprofilepid)" ] || fail "profile daemon shares the default pid"
work_pid=$(readprofilepid)
bun src/cli.ts stop --profile work
# `stop` clears the tracked pid, so `start --check` alone can't prove the PROCESS
# died -- assert on the saved pid directly (SIGTERM is async; allow a short grace).
for _ in 1 2 3 4 5; do
    pidalive "$work_pid" || break
    sleep 1
done
if pidalive "$work_pid"; then
    fail "profile daemon (pid $work_pid) survived stop --profile"
fi
if bun src/cli.ts start --check --profile work; then
    fail "profile daemon still up after stop --profile"
fi
bun src/cli.ts start --check || fail "default daemon died with the profile daemon"
bun src/cli.ts profile --del work
if bun src/cli.ts profile --check work >/dev/null 2>&1; then
    fail "profile still exists after profile --del"
fi
echo "profile daemon lifecycle OK on ${RUNNER_OS:-$(uname)}"

bun src/cli.ts stop
if bun src/cli.ts health --scope runtime; then
    fail "health reported healthy after stop"
fi
echo "start/stop + health OK on ${RUNNER_OS:-$(uname)}"
