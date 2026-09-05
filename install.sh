#!/usr/bin/env bash
# copilot-env installer (Linux + macOS).
#
# Bootstrap only: pick this platform's compiled agent binary from the selected
# copilot-env GitHub release, verify its SHA256 against the release's
# checksums.txt, install it as <install-dir>/bin/copilot-env, then hand off to
# the binary's own `install` subcommand (it materializes the runtime assets,
# the bin/agent launcher shims, and the shell integration). Optional CLIs and
# launchers are managed after install (`agent shell --clis`, `agent config --set launchers true`).

set -eu

# The next line is rewritten to the release tag by .github/scripts/release-assets.ts
# (byte-exact needle; test/installer_pinning.test.ts guards the match).
INSTALL_REF="${COPILOT_ENV_INSTALL_REF:-latest}"
REPO="Vivswan/copilot-env"
BINARY_NAME="copilot-env"
INSTALL_DIR_ARG=""
VERSION_ARG=""
SKIP_SHELL_INTEGRATION=false
EXEC_SHELL=true
[ -n "${COPILOT_ENV_NO_EXEC_SHELL:-}" ] && EXEC_SHELL=false
# The Authorization header goes only to api.github.com (tag resolution);
# release-asset downloads ride the public URL (curl >= 7.58 would drop the
# header on the cross-host CDN redirect anyway).
AUTH_CURL_ARGS=(-H "User-Agent: copilot-env" -H "Accept: application/vnd.github+json")
PUBLIC_CURL_ARGS=(-H "User-Agent: copilot-env")

usage() {
    cat <<'EOF'
Usage: install.sh [--dir DIR] [--version TAG] [--no-shell-integration] [--no-exec-shell]

Installs copilot-env into ~/.copilot-env by downloading the compiled agent
binary for this platform from the selected GitHub release, verifying its
SHA256, and wiring shell integration by default. Optional agent CLIs and
launchers are configured after install:

  agent shell --clis [--cooldown[=DAYS]] [--no-sudo] [--no-prereqs]
  agent config --set launchers true

Options:
  --dir DIR              Install target (default ~/.copilot-env). Takes
                         precedence over $COPILOT_ENV_DIR.
  --version TAG          Install a specific release tag (e.g. v3.5.6) instead
                         of the default. Takes precedence over
                         $COPILOT_ENV_INSTALL_REF.
  --no-shell-integration Do not wire ~/.bashrc / ~/.zshrc. Run
                         `agent shell` later to enable it.
  --no-exec-shell        Do not offer to reload your shell at the end. The
                         offer is also skipped when non-interactive or under CI,
                         or when $COPILOT_ENV_NO_EXEC_SHELL is set.

Environment:
  COPILOT_ENV_DOWNLOAD_BASE  Directory or URL to fetch the agent binary and
                             checksums.txt from instead of the GitHub release
                             (CI uses this to smoke draft releases).

The main-branch installer resolves the latest release; release assets are
pinned to their release tag.
EOF
}

die() {
    echo "ERROR: $*" >&2
    exit 2
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

# Lexically absolutize $1 into INSTALL_DIR and refuse the obviously unsafe
# targets (empty, "/", the user's home, any "."/".." component). Deliberately
# minimal and purely lexical: the binary's own `install` re-checks the
# CANONICAL path (symlinks resolved) when it plans the install
# (src/install/installer.ts); this pre-check only keeps the bootstrap's
# mkdir/mv away from the worst targets. Mirrors Resolve-SafeInstallDir in
# install.ps1 (whose GetFullPath collapses dot components instead).
resolve_safe_install_dir() {
    INSTALL_DIR="$1"
    case "$INSTALL_DIR" in
        /*) ;;
        "") die "refusing to use unsafe install directory '$1'." ;;
        *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
    esac
    # Collapse consecutive slashes on both sides of the compare: without this,
    # "/Users//me" is a distinct string that slips past the home refusal below
    # (the ps1 twin's GetFullPath collapses separators the same way).
    INSTALL_DIR=$(printf '%s' "$INSTALL_DIR" | sed 's://*:/:g')
    _home=$(printf '%s' "$HOME" | sed 's://*:/:g')
    # Refuse "."/".." components outright rather than resolving them: resolved
    # lexically they could alias "/" or "$HOME" past the checks below.
    case "$INSTALL_DIR/" in
        */./* | */../*) die "refusing to use unsafe install directory '$1'." ;;
    esac
    # Trim trailing slashes ("/opt/ce/" and "$HOME/" compare clean; "/" trims
    # to empty and is refused).
    while [ "$INSTALL_DIR" != "${INSTALL_DIR%/}" ]; do
        INSTALL_DIR="${INSTALL_DIR%/}"
    done
    while [ -n "$_home" ] && [ "$_home" != "${_home%/}" ]; do
        _home="${_home%/}"
    done
    if [ -z "$INSTALL_DIR" ] || [ "$INSTALL_DIR" = "$_home" ]; then
        die "refusing to use unsafe install directory '$1'."
    fi
}

# The ONE platform -> release-target mapping (mirrors the release-asset names
# produced by scripts/compile.ts; install.ps1 carries the Windows entry).
resolve_target() {
    _os="$(uname -s)"
    _arch="$(uname -m)"
    case "$_os/$_arch" in
        Darwin/x86_64) TARGET="x86_64-apple-darwin" ;;
        Darwin/arm64) TARGET="aarch64-apple-darwin" ;;
        Linux/x86_64 | Linux/amd64) TARGET="x86_64-unknown-linux-gnu" ;;
        Linux/aarch64 | Linux/arm64) TARGET="aarch64-unknown-linux-gnu" ;;
        *) die "no prebuilt copilot-env binary for $_os/$_arch." ;;
    esac
}

# Verify one "<sha256>  <name>" checksums.txt line against the file of that
# name inside $1, with whichever sha256 tool this system has.
sha256_check_line() {
    _dir="$1"
    _line="$2"
    if command -v sha256sum >/dev/null 2>&1; then
        ( cd "$_dir" && printf '%s\n' "$_line" | sha256sum -c - >/dev/null )
    elif command -v shasum >/dev/null 2>&1; then
        ( cd "$_dir" && printf '%s\n' "$_line" | shasum -a 256 -c - >/dev/null )
    else
        die "need sha256sum or shasum on PATH to verify the download."
    fi
}

resolve_release_tag() {
    if [ -n "$VERSION_ARG" ]; then
        TAG="$VERSION_ARG"
    elif [ "$INSTALL_REF" != "latest" ]; then
        TAG="$INSTALL_REF"
    elif [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
        # A token raises the API rate limit and sees private repos, so resolve
        # `latest` through the API when one is available.
        _json="$(retry "Resolve latest release" curl -fsSL "${AUTH_CURL_ARGS[@]}" \
            "https://api.github.com/repos/$REPO/releases/latest")" \
            || die "could not resolve the latest copilot-env release."
        TAG="$(printf '%s' "$_json" \
            | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    else
        # Tokenless: follow the /releases/latest redirect to the tag page
        # instead of burning the 60/hour unauthenticated API quota.
        _url="$(retry "Resolve latest release" curl -fsSL -o /dev/null -w '%{url_effective}' \
            "${PUBLIC_CURL_ARGS[@]}" "https://github.com/$REPO/releases/latest")" \
            || die "could not resolve the latest copilot-env release."
        TAG="${_url##*/}"
    fi
    case "$TAG" in
        v[0-9]*) ;;
        *) die "could not resolve a release tag (got '$TAG')." ;;
    esac
}

# Fetch one release file into $2: from the override directory, the override
# URL, or the resolved GitHub release download URL.
fetch_release_file() {
    _name="$1"
    _dest="$2"
    if [ -n "$DOWNLOAD_DIR" ]; then
        cp -- "$DOWNLOAD_DIR/$_name" "$_dest"
    else
        retry "Download $_name" curl -fsSL "${PUBLIC_CURL_ARGS[@]}" \
            "$DOWNLOAD_URL_BASE/$_name" -o "$_dest"
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
        --version)
            shift
            [ $# -gt 0 ] || die "--version needs a release tag argument."
            VERSION_ARG="$1" ;;
        --version=*)
            VERSION_ARG="${1#*=}"
            [ -n "$VERSION_ARG" ] || die "--version= needs a value, e.g. --version=v3.5.6." ;;
        --no-shell-integration) SKIP_SHELL_INTEGRATION=true ;;
        --no-exec-shell) EXEC_SHELL=false ;;
        *) die "unknown argument '$1' (try --help)" ;;
    esac
    shift
done

INSTALL_DIR="${INSTALL_DIR_ARG:-${COPILOT_ENV_DIR:-$HOME/.copilot-env}}"
resolve_safe_install_dir "$INSTALL_DIR"

# A source checkout must never be an install target: checkout markers plus .git
# (a directory, or a file in a worktree) mirrors the binary's own plan-time
# refusal (CHECKOUT_MARKERS in src/install/installer.ts), before the bin write
# touches the root. Markers without .git are a legacy source install, whose
# superseded artifacts the binary sweeps.
if [ -e "$INSTALL_DIR/.git" ]; then
    for _marker in package.json deno.json; do
        if [ -e "$INSTALL_DIR/$_marker" ]; then
            die "refusing to install into $INSTALL_DIR: it holds $_marker and .git, so it is a source checkout; choose another target with --dir or COPILOT_ENV_DIR."
        fi
    done
fi

_tmp="$(mktemp -d)"
trap 'rm -rf "$_tmp"' EXIT

# A GH token (higher rate limits / private access) must stay off curl's command
# line: argv is world-readable via `ps`/`/proc/<pid>/cmdline` while curl runs, so
# write it to a 0600 header file and pass `-H @file` (curl >= 7.55).
if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    _hdr="$_tmp/auth-header"
    _old_umask="$(umask)"
    umask 0177
    printf 'Authorization: Bearer %s\n' "${GH_TOKEN:-$GITHUB_TOKEN}" > "$_hdr"
    umask "$_old_umask"
    AUTH_CURL_ARGS+=(-H "@$_hdr")
fi

resolve_target
ASSET="copilot-env-$TARGET"

DOWNLOAD_DIR=""
DOWNLOAD_URL_BASE=""
if [ -n "${COPILOT_ENV_DOWNLOAD_BASE:-}" ]; then
    # Override for CI draft-release smokes and mirrors: a local directory or a
    # base URL that holds the agent binary and checksums.txt.
    if [ -d "$COPILOT_ENV_DOWNLOAD_BASE" ]; then
        DOWNLOAD_DIR="$COPILOT_ENV_DOWNLOAD_BASE"
    else
        DOWNLOAD_URL_BASE="$COPILOT_ENV_DOWNLOAD_BASE"
    fi
    echo "Downloading copilot-env ($ASSET) from $COPILOT_ENV_DOWNLOAD_BASE into $INSTALL_DIR ..."
else
    echo "Resolving the copilot-env release ..."
    resolve_release_tag
    DOWNLOAD_URL_BASE="https://github.com/$REPO/releases/download/$TAG"
    echo "Downloading copilot-env $TAG ($ASSET) into $INSTALL_DIR ..."
fi

fetch_release_file "$ASSET" "$_tmp/$ASSET"
fetch_release_file "checksums.txt" "$_tmp/checksums.txt"

# Verify against the one checksums.txt line for this asset (a leading "*"
# marks binary mode in shasum output; accept both forms).
_line="$(awk -v name="$ASSET" '$2 == name || $2 == ("*" name) { print }' "$_tmp/checksums.txt" | head -n 1)"
[ -n "$_line" ] || die "checksums.txt has no entry for $ASSET."
sha256_check_line "$_tmp" "$_line" || die "SHA256 verification failed for $ASSET."

mkdir -p "$INSTALL_DIR/bin"
# mv (rename) rather than cp: replacing a running copilot-env binary in place would
# fail with ETXTBSY; a rename swaps the inode out from under it safely.
mv -f "$_tmp/$ASSET" "$INSTALL_DIR/bin/$BINARY_NAME"
chmod 0755 "$INSTALL_DIR/bin/$BINARY_NAME"

INSTALLER_ARGS=(install)
if [ "$SKIP_SHELL_INTEGRATION" = true ]; then
    INSTALLER_ARGS+=(--no-shell-integration)
fi

"$INSTALL_DIR/bin/$BINARY_NAME" "${INSTALLER_ARGS[@]}"

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
            rm -rf "$_tmp"
            _reload_shell="${SHELL:-/bin/sh}"
            echo "Reloading $_reload_shell ..." >/dev/tty
            # Interactive (no -l): a login bash reads .bash_profile, NOT the .bashrc we
            # wired; an interactive shell attached to the tty reads .bashrc / .zshrc.
            exec "$_reload_shell" </dev/tty >/dev/tty 2>/dev/tty
            ;;
    esac
fi
