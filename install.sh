#!/usr/bin/env bash
# copilot-env installer (Linux + macOS).
#
# Bootstrap only: ensure bun, download/extract the selected copilot-env GitHub
# release source archive, then hand off to the release-bundled TypeScript
# installer. Optional CLIs and launchers are managed after install with
# `agent shell --clis --launchers`.

set -eu

INSTALL_REF="${COPILOT_ENV_INSTALL_REF:-latest}"
RESOLVER_URL="https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/resolve-release.ts"
VERIFIER_URL="https://raw.githubusercontent.com/Vivswan/copilot-env/main/src/install/verify-source-archive.ts"
INSTALL_DIR_ARG=""
SKIP_SHELL_INTEGRATION=false
EXEC_SHELL=true
[ -n "${COPILOT_ENV_NO_EXEC_SHELL:-}" ] && EXEC_SHELL=false
AUTH_CURL_ARGS=(-H "User-Agent: copilot-env")
# A GH token (for higher rate limits / private access) is passed to curl via a 0600 header
# FILE below, never on the command line -- a bearer token in argv is world-readable via
# `ps`/`/proc/<pid>/cmdline` while curl runs. Only detect it here; the file is written once
# $_tmp exists. (The PowerShell installer already keeps it off argv via a headers hashtable.)
if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    AUTH_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"
fi
ASSET_CURL_ARGS=("${AUTH_CURL_ARGS[@]}" -H "Accept: application/octet-stream")

usage() {
    cat <<'EOF'
Usage: install.sh [--dir DIR] [--no-shell-integration]

Installs copilot-env into ~/.copilot-env by downloading the selected GitHub
release source archive, bootstraps its dependencies, and wires shell integration
by default. Optional agent CLIs and launchers are configured after install:

  agent shell --clis [--cooldown[=DAYS]] [--no-sudo] [--no-prereqs] [--launchers]

Options:
  --dir DIR              Install target (default ~/.copilot-env). Takes
                         precedence over $COPILOT_ENV_DIR. Ignored when run
                         from an existing checkout.
  --no-shell-integration Do not wire ~/.bashrc / ~/.zshrc. Run
                         `agent shell` later to enable it.
  --no-exec-shell        Do not offer to reload your shell at the end. The
                         offer is also skipped when non-interactive or under CI,
                         or when $COPILOT_ENV_NO_EXEC_SHELL is set.

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

# Canonicalize a directory for the safety guard below: return a clean ABSOLUTE path with
# the existing prefix resolved via cd+pwd -P (so symlinks and the "//" root alias collapse)
# and any not-yet-existing trailing components re-appended. Rejects an unresolved "."/".."
# component and returns empty when it cannot canonicalize, so the guard refuses rather than
# risk `rm -rf` on the wrong target. `set -e`-safe: every command substitution that can fail
# is guarded, so a missing parent never aborts the script.
canonical_dir() {
    _p="$1"
    [ -n "$_p" ] || { printf '\n'; return 0; }
    case "$_p" in
        /*) ;;
        *) _p="$PWD/$_p" ;;
    esac
    # Peel not-yet-existing trailing components (rejecting . and ..) down to an existing dir.
    _tail=""
    while [ ! -d "$_p" ]; do
        _leaf=$(basename -- "$_p")
        case "$_leaf" in
            .|..) printf '\n'; return 0 ;;
        esac
        if [ -n "$_tail" ]; then _tail="$_leaf/$_tail"; else _tail="$_leaf"; fi
        _next=$(dirname -- "$_p")
        [ "$_next" != "$_p" ] || { printf '\n'; return 0; } # walked off the root, nothing existed
        _p="$_next"
    done
    # Resolve the existing base; collapse any "//" (POSIX root alias) to "/".
    _base=$( CDPATH= cd -- "$_p" 2>/dev/null && pwd -P ) || { printf '\n'; return 0; }
    _base=$(printf '%s' "$_base" | sed 's://*:/:g')
    if [ -n "$_tail" ]; then
        printf '%s/%s\n' "$_base" "$_tail"
    else
        printf '%s\n' "$_base"
    fi
}

refuse_dangerous_install_dir() {
    _canon=$(canonical_dir "$INSTALL_DIR")
    _home=$(canonical_dir "$HOME")
    # Refuse anything that is not a clean absolute path (empty => could not canonicalize),
    # any filesystem root (a path that is its own parent, covering "/", "//", drive roots),
    # and the user's home directory.
    case "$_canon" in
        /*) ;;
        *) die "refusing to replace unsafe install directory '$INSTALL_DIR'." ;;
    esac
    if [ "$_canon" = "$(dirname -- "$_canon")" ] || [ "$_canon" = "$_home" ]; then
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
        --no-exec-shell) EXEC_SHELL=false ;;
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
    # Canonicalize to a clean absolute path BEFORE the guard and the destructive
    # `rm -rf`/`mkdir`/`tar` below all use the same safe value (only on this download
    # path; the existing-checkout branch above ignores --dir entirely).
    INSTALL_DIR="$(canonical_dir "$INSTALL_DIR")"
    refuse_dangerous_install_dir
    _tmp="$(mktemp -d)"
    trap 'rm -rf "$_tmp"' EXIT
    # Write the bearer token to a 0600 header file and hand it to curl with `-H @file`
    # (curl >= 7.55) so it stays off the world-readable command line.
    if [ -n "${AUTH_TOKEN:-}" ]; then
        _hdr="$_tmp/auth-header"
        _old_umask="$(umask)"
        umask 0177
        printf 'Authorization: Bearer %s\n' "$AUTH_TOKEN" > "$_hdr"
        umask "$_old_umask"
        AUTH_CURL_ARGS+=(-H "@$_hdr")
        ASSET_CURL_ARGS+=(-H "@$_hdr")
    fi
    echo "Resolving the copilot-env release ..."
    retry "Download release resolver" curl -fsSL "${AUTH_CURL_ARGS[@]}" "$RESOLVER_URL" -o "$_tmp/resolve-release.ts"
    retry "Download archive verifier" curl -fsSL "${AUTH_CURL_ARGS[@]}" "$VERIFIER_URL" -o "$_tmp/verify-source-archive.ts"
    RESOLVER_ARGS=(--json)
    if [ "$INSTALL_REF" != "latest" ]; then
        RESOLVER_ARGS+=(--tag "$INSTALL_REF")
    fi
    _target="$(bun "$_tmp/resolve-release.ts" "${RESOLVER_ARGS[@]}")" \
        || { echo "ERROR: no copilot-env release found (or the GitHub API is unreachable)." >&2; exit 1; }
    _url="$(printf %s "$_target" | json_field tarballUrl)"
    _sha="$(printf %s "$_target" | json_field sourceSha)"
    _sha256="$(printf %s "$_target" | json_field sourceSha256)"
    [ -n "$_url" ] && [ -n "$_sha" ] || {
        echo "ERROR: release resolver returned incomplete metadata." >&2
        exit 1
    }
    _ref="${_url##*/}"
    echo "Downloading copilot-env $_ref into $INSTALL_DIR ..."
    retry "Download copilot-env release" curl -fsSL "${ASSET_CURL_ARGS[@]}" "$_url" -o "$_tmp/release.tgz"
    VERIFY_ARGS=("$_tmp/release.tgz" "$_sha")
    if [ -n "$_sha256" ]; then
        VERIFY_ARGS+=("$_sha256")
    fi
    bun "$_tmp/verify-source-archive.ts" "${VERIFY_ARGS[@]}"
    # Preserve opt-in autoupdate state and the user's local `.env` overrides across the
    # destructive replace below (both are gitignored, so a release tree never ships them).
    if [ -d "$INSTALL_DIR/.autoupdate" ]; then
        cp -a "$INSTALL_DIR/.autoupdate" "$_tmp/.autoupdate-backup"
    fi
    if [ -f "$INSTALL_DIR/.env" ]; then
        cp -a "$INSTALL_DIR/.env" "$_tmp/.env-backup"
    fi
    if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
        echo "Removing previous copilot-env install at $INSTALL_DIR ..."
        rm -rf -- "$INSTALL_DIR"
    fi
    mkdir -p "$INSTALL_DIR"
    tar -xzf "$_tmp/release.tgz" --strip-components=1 -C "$INSTALL_DIR"
    # Restore preserved autoupdate state. The release never ships .autoupdate (it's
    # gitignored), so the freshly-extracted tree has none — copy the backup's
    # contents into a fresh dir (no destructive pre-clean of $INSTALL_DIR needed).
    if [ -d "$_tmp/.autoupdate-backup" ]; then
        mkdir -p "$INSTALL_DIR/.autoupdate"
        cp -a "$_tmp/.autoupdate-backup/." "$INSTALL_DIR/.autoupdate/"
    fi
    # Restore the preserved .env (the documented supply-chain pin / env overrides).
    if [ -f "$_tmp/.env-backup" ]; then
        cp -a "$_tmp/.env-backup" "$INSTALL_DIR/.env"
    fi
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

# Offer to reload the shell so the freshly-wired integration takes effect without the
# user opening a new terminal. Only when integration was wired, we are attached to a
# real terminal, not under CI, and the caller did not opt out. A child process can't
# source into its parent shell, so we hand off with `exec`: replacing this process with
# an interactive shell attached to the tty makes it read the user's rc (where the
# integration now lives). exec skips the EXIT trap, so clean up the temp dir first.
if [ "$SKIP_SHELL_INTEGRATION" = false ] && [ "$EXEC_SHELL" = true ] && [ -z "${CI:-}" ] \
    && [ -e /dev/tty ] && { [ -t 0 ] || [ -t 1 ]; }; then
    printf 'Reload your shell now to activate copilot-env? [Y/n] ' >/dev/tty
    _ans=""
    IFS= read -r _ans </dev/tty || _ans="n"
    case "$_ans" in
        [Nn]*) : ;;
        *)
            [ -n "${_tmp:-}" ] && rm -rf "$_tmp"
            _reload_shell="${SHELL:-/bin/sh}"
            echo "Reloading $_reload_shell ..." >/dev/tty
            # Interactive (no -l): a login bash reads .bash_profile, NOT the .bashrc we
            # wired; an interactive shell attached to the tty reads .bashrc / .zshrc.
            exec "$_reload_shell" </dev/tty >/dev/tty 2>/dev/tty
            ;;
    esac
fi
