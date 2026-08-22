#!/usr/bin/env bash
# Compile the copilot-env agent binary for the release targets (all five by
# default, or a subset via --target), then emit dist/checksums.txt. Runs from
# anywhere; operates on the repo root.

set -euo pipefail
export DENO_NO_UPDATE_CHECK=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- the single source of truth for the compile inputs -------------------------
# TARGETS mirrors RELEASE_TARGETS in src/install/targets.ts and INCLUDES mirrors
# EMBEDDED_ASSET_DIRS + EMBEDDED_ASSET_FILES in src/install/installer.ts. Shell
# cannot import those, so test/release_targets.test.ts parses this block and
# fails the PR when the two drift: anything `agent install` expects to find in
# the compiled VFS but that was never embedded would only surface as a broken
# install at release time.
TARGETS=(
    x86_64-apple-darwin
    aarch64-apple-darwin
    x86_64-unknown-linux-gnu
    aarch64-unknown-linux-gnu
    x86_64-pc-windows-msvc
)
PERMISSION_SET="cli"
INCLUDES=(src/scripts shell skills .claude-plugin deno.json deno.lock .dvmrc copilot-env.config)
ENTRY="src/cli.ts"
APP_NAME="copilot-env"
OUT_DIR="dist"
DENO_BIN="${DENO_BIN:-deno}"

usage() {
    cat <<EOF
Usage: scripts/compile.sh [--target TRIPLE]...

Compiles $ENTRY for every release target into $OUT_DIR/ and writes
$OUT_DIR/checksums.txt. --target (repeatable) restricts the build to the
given triple(s), e.g. for a quick local host build:

  scripts/compile.sh --target aarch64-apple-darwin

Targets: ${TARGETS[*]}
EOF
}

die() {
    echo "ERROR: $*" >&2
    exit 2
}

known_target() {
    for _kt in "${TARGETS[@]}"; do
        [ "$_kt" = "$1" ] && return 0
    done
    return 1
}

SELECTED=()
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --target)
            shift
            [ $# -gt 0 ] || die "--target needs a target triple argument."
            known_target "$1" || die "unknown target '$1' (known: ${TARGETS[*]})."
            SELECTED+=("$1") ;;
        --target=*)
            _t="${1#*=}"
            known_target "$_t" || die "unknown target '$_t' (known: ${TARGETS[*]})."
            SELECTED+=("$_t") ;;
        *) die "unknown argument '$1' (try --help)" ;;
    esac
    shift
done
if [ "${#SELECTED[@]}" -eq 0 ]; then
    SELECTED=("${TARGETS[@]}")
fi

INCLUDE_ARGS=()
for _inc in "${INCLUDES[@]}"; do
    INCLUDE_ARGS+=(--include "$_inc")
done

mkdir -p "$OUT_DIR"
for _target in "${SELECTED[@]}"; do
    _out="$OUT_DIR/agent-$_target"
    case "$_target" in
        *windows*) _out="$_out.exe" ;;
    esac
    echo "==> deno compile --target $_target -> $_out" >&2
    # --node-modules-dir=none resolves npm through the global cache instead of
    # the checkout's node_modules. That is what makes --exclude-unused-npm work
    # at all (it is silently a no-op while a local node_modules exists), and it
    # is worth a lot: the checkout's node_modules carries the proxy's own
    # dependency tree, which the daemon resolves for itself and this binary
    # never imports. Embedding it whole costs ~78MB per target.
    "$DENO_BIN" compile \
        --target "$_target" \
        --no-check \
        --node-modules-dir=none \
        --exclude-unused-npm \
        -P="$PERMISSION_SET" \
        "${INCLUDE_ARGS[@]}" \
        --app-name "$APP_NAME" \
        -o "$_out" \
        "$ENTRY"
done

# checksums.txt covers every binary currently in dist/ (so a filtered build
# still emits verifiable lines), in `shasum -a 256 -c` compatible form.
(
    cd "$OUT_DIR"
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 agent-* > checksums.txt
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum agent-* > checksums.txt
    else
        die "need shasum or sha256sum on PATH to emit checksums.txt."
    fi
)
echo "==> wrote $OUT_DIR/checksums.txt" >&2
