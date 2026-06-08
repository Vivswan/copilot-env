#!/usr/bin/env bash
# copilot-env installer (Linux + macOS).
#
# Bootstrap only: ensure bun, download/extract the selected copilot-env GitHub
# release source archive, then hand off to the release-bundled TypeScript
# installer. Optional CLIs and launchers are managed after install with
# `agent setup clis --launchers`.

set -eu

INSTALL_REF="${COPILOT_ENV_INSTALL_REF:-latest}"
RESOLVER_URL="https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/resolve-release.ts"
VERIFIER_URL="https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/verify-source-archive.ts"
INSTALL_DIR_ARG=""
SKIP_SHELL_INTEGRATION=false

usage() {
    cat <<'EOF'
Usage: install.sh [--dir DIR] [--no-shell-integration]

Installs copilot-env into ~/.copilot-env by downloading the selected GitHub
release source archive, bootstraps its dependencies, and wires shell integration
by default. Optional agent CLIs and launchers are configured after install:

  agent setup clis [--cooldown[=DAYS]] [--no-sudo] [--no-prereqs] [--launchers]

Options:
  --dir DIR              Install target (default ~/.copilot-env). Takes
                         precedence over $COPILOT_ENV_DIR. Ignored when run
                         from an existing checkout.
  --no-shell-integration Do not wire ~/.bashrc / ~/.zshrc. Run
                         `agent setup shell` later to enable it.

To install a specific copilot-env version, download install.sh from that
GitHub Release and run it. The main-branch installer resolves latest; release
assets are pinned to their release tag.
EOF
}

die() {
    echo "ERROR: $*" >&2
    exit 2
}

json_field() {
    bun -e "const d=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d['$1'] ?? ''))"
}

retry() {
    _label="$1"
    shift
    _try=1
    while :; do
        if "$@"; then
            return 0
        fi
        if [ "$_try" -ge 3 ]; then
            return 1
        fi
        echo "$_label failed; retrying ($_try/3) ..." >&2
        sleep $(( _try * 2 ))
        _try=$(( _try + 1 ))
    done
}

refuse_dangerous_install_dir() {
    if [ -z "$INSTALL_DIR" ] || [ "$INSTALL_DIR" = "/" ] || [ "$INSTALL_DIR" = "$HOME" ]; then
        die "refusing to replace unsafe install directory '$INSTALL_DIR'."
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --dir)
            shift
            [ $# -gt 0 ] || die "--dir needs a directory argument."
            INSTALL_DIR_ARG="$1" ;;
        --dir=*)
            INSTALL_DIR_ARG="${1#*=}"
            [ -n "$INSTALL_DIR_ARG" ] || die "--dir= needs a value, e.g. --dir=/opt/copilot-env." ;;
        --no-shell-integration) SKIP_SHELL_INTEGRATION=true ;;
        *) die "unknown argument '$1' (try --help)" ;;
    esac
    shift
done

INSTALL_DIR="${INSTALL_DIR_ARG:-${COPILOT_ENV_DIR:-$HOME/.copilot-env}}"

if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
    echo "Installing bun ..."
    retry "Bun install" bash -c 'set -o pipefail; curl -fsSL https://bun.sh/install | bash >/dev/null'
fi
[ -x "$HOME/.bun/bin/bun" ] && case ":$PATH:" in
    *":$HOME/.bun/bin:"*) ;;
    *) PATH="$HOME/.bun/bin:$PATH" ;;
esac
export PATH

SELF_DIR=""
case "${0:-}" in
    bash|sh|-bash|-sh|"") ;;
    *) SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)" ;;
esac

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/shell/agents.bashrc" ]; then
    REPO_DIR="$SELF_DIR"
    echo "Using existing checkout at $REPO_DIR"
else
    refuse_dangerous_install_dir
    _tmp="$(mktemp -d)"
    trap 'rm -rf "$_tmp"' EXIT
    echo "Resolving the copilot-env release ..."
    retry "Download release resolver" curl -fsSL -H "User-Agent: copilot-env" "$RESOLVER_URL" -o "$_tmp/resolve-release.ts"
    retry "Download archive verifier" curl -fsSL -H "User-Agent: copilot-env" "$VERIFIER_URL" -o "$_tmp/verify-source-archive.ts"
    RESOLVER_ARGS=(--json)
    if [ "$INSTALL_REF" != "latest" ]; then
        RESOLVER_ARGS+=(--tag "$INSTALL_REF")
    fi
    _target="$(bun "$_tmp/resolve-release.ts" "${RESOLVER_ARGS[@]}")" \
        || { echo "ERROR: no copilot-env release found (or the GitHub API is unreachable)." >&2; exit 1; }
    _url="$(printf %s "$_target" | json_field tarballUrl)"
    _sha="$(printf %s "$_target" | json_field sourceSha)"
    [ -n "$_url" ] && [ -n "$_sha" ] || {
        echo "ERROR: release resolver returned incomplete metadata." >&2
        exit 1
    }
    _ref="${_url##*/}"
    echo "Downloading copilot-env $_ref into $INSTALL_DIR ..."
    retry "Download copilot-env release" curl -fsSL -H "User-Agent: copilot-env" "$_url" -o "$_tmp/release.tgz"
    bun "$_tmp/verify-source-archive.ts" "$_tmp/release.tgz" "$_sha"
    if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
        echo "Removing previous copilot-env install at $INSTALL_DIR ..."
        rm -rf -- "$INSTALL_DIR"
    fi
    mkdir -p "$INSTALL_DIR"
    tar -xzf "$_tmp/release.tgz" --strip-components=1 -C "$INSTALL_DIR"
    REPO_DIR="$INSTALL_DIR"
fi

[ -f "$REPO_DIR/src/install/installer.ts" ] || {
    echo "ERROR: could not find bundled installer at $REPO_DIR/src/install/installer.ts" >&2
    exit 1
}

INSTALLER_ARGS=(install)
if [ "$SKIP_SHELL_INTEGRATION" = true ]; then
    INSTALLER_ARGS+=(--no-shell-integration)
fi

bun "$REPO_DIR/src/install/installer.ts" "${INSTALLER_ARGS[@]}"
