#!/usr/bin/env bash
# copilot-env installer (Linux + macOS).
#
# Clones (or updates) the copilot-env repo, installs prerequisites (Node via nvm,
# bun via its official installer) and the agent CLIs (claude / copilot / codex),
# then wires the shell integration into ~/.bashrc and/or ~/.zshrc. Runs two ways:
#
#   # one-liner -- no local checkout needed:
#   curl -fsSL https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.sh | bash
#
#   # from an existing checkout:
#   ./install.sh
#
# Env:
#   COPILOT_ENV_DIR   clone target when fetching fresh (default ~/.copilot-env);
#                     the --dir flag takes precedence over it.

set -eu

REPO_URL="https://github.com/Vivswan/copilot-env.git"
INSTALL_DIR_ARG=""        # set by --dir; takes precedence over $COPILOT_ENV_DIR
SKIP_PREREQS=false        # --no-prereqs: verify tools, never install them
LOCAL_INSTALL=false       # --local-install: install only via curl/npm, never sudo/pkg-mgr
SKIP_SHELL_INTEGRATION=false  # --no-shell-integration: don't wire the integration into rc files
NVM_VERSION="v0.40.1"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
COOLDOWN_DEFAULT_DAYS=7   # matches bunfig.toml install.minimumReleaseAge (604800s)
COOLDOWN_DAYS=""          # empty = disabled (install the npm `latest` tag)
COOLDOWN_REPO_SHA=""      # set when --cooldown rolls the repo back to an aged commit
COOLDOWN_REPO_MIN_SHA=""
COOLDOWN_REPO_MAX_SHA=""

usage() {
    cat <<'EOF'
Usage: install.sh [--dir DIR] [--cooldown[=DAYS]] [--no-prereqs] [--local-install] [--no-shell-integration]

Installs Node (via nvm), bun, and the agent CLIs, clones/updates copilot-env,
and adds its shell integration to ~/.bashrc / ~/.zshrc.

Options:
  --dir DIR           Clone target when fetching fresh (default ~/.copilot-env).
                      Takes precedence over $COPILOT_ENV_DIR. Ignored when run
                      from an existing checkout (that checkout is reused).
  --cooldown[=DAYS]   Supply-chain cooldown for the agent CLIs (claude / copilot
                      / codex): instead of npm's `latest`, install the newest
                      release that has been public for at least DAYS days, so a
                      compromised just-published version has time to be caught
                      and yanked before any user adopts it. Bare --cooldown uses
                      7 days, matching the gateway's bunfig.toml cooldown.
  --no-prereqs        Do not install any prerequisites (git, Node, bun) or the
                      agent CLIs -- only verify them. A missing *necessary* tool
                      (bun; git when a clone is needed) is a fatal error; a
                      missing *optional* tool (Node/npm, the agent CLIs) is a
                      warning. The repo clone/update and shell wiring still run.
  --local-install     Install prerequisites only via user-local methods (the
                      curl/npm installers); never use sudo or a system package
                      manager (brew/apt/dnf/...). Node (nvm), bun, and the agent
                      CLIs install as usual; git cannot be installed this way, so
                      a missing git is a fatal error when a clone is needed.
                      Mutually exclusive with --no-prereqs.
  --no-shell-integration
                      Do everything except wire the shell integration into your
                      rc files (~/.bashrc / ~/.zshrc). The repo, prerequisites,
                      and agent CLIs still install; you source agents.bashrc
                      yourself. Useful for CI or a hand-managed shell rc.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --cooldown) COOLDOWN_DAYS="$COOLDOWN_DEFAULT_DAYS" ;;
        --cooldown=*)
            COOLDOWN_DAYS="${1#*=}"
            [ -n "$COOLDOWN_DAYS" ] || { echo "ERROR: --cooldown= needs a value, e.g. --cooldown=7." >&2; exit 2; } ;;
        --dir)
            shift
            [ $# -gt 0 ] || { echo "ERROR: --dir needs a directory argument." >&2; exit 2; }
            INSTALL_DIR_ARG="$1" ;;
        --dir=*)
            INSTALL_DIR_ARG="${1#*=}"
            [ -n "$INSTALL_DIR_ARG" ] || { echo "ERROR: --dir= needs a value, e.g. --dir=/opt/copilot-env." >&2; exit 2; } ;;
        --no-prereqs) SKIP_PREREQS=true ;;
        --local-install) LOCAL_INSTALL=true ;;
        --no-shell-integration) SKIP_SHELL_INTEGRATION=true ;;
        *) echo "ERROR: unknown argument '$1' (try --help)" >&2; exit 2 ;;
    esac
    shift
done

if [ "$SKIP_PREREQS" = true ] && [ "$LOCAL_INSTALL" = true ]; then
    echo "ERROR: --no-prereqs and --local-install are mutually exclusive." >&2
    exit 2
fi

# Precedence: --dir flag > $COPILOT_ENV_DIR > default.
INSTALL_DIR="${INSTALL_DIR_ARG:-${COPILOT_ENV_DIR:-$HOME/.copilot-env}}"

case "$COOLDOWN_DAYS" in
    "") ;;            # disabled
    *[!0-9]*) echo "ERROR: --cooldown expects a whole number of days (got '$COOLDOWN_DAYS')." >&2; exit 2 ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }

# --no-prereqs: note an absent *optional* tool (we proceed without installing it).
warn_missing() {  # <cmd> <description>
    have "$1" || echo "WARNING: $2 ('$1') is not installed; skipping. Install it yourself to use it." >&2
}

load_project_config() { # <repo-dir>
    _config="$1/copilot-env.config"
    [ -f "$_config" ] || { echo "ERROR: missing project config at $_config" >&2; return 1; }

    COOLDOWN_REPO_MIN_SHA=""
    COOLDOWN_REPO_MAX_SHA=""
    while IFS= read -r _line || [ -n "$_line" ]; do
        case "$_line" in
            ""|\#*) continue ;;
        esac
        _key="${_line%%=*}"
        [ "$_key" != "$_line" ] || { echo "ERROR: $_config must use KEY=value lines." >&2; return 1; }
        _value="${_line#*=}"
        case "$_key" in
            CooldownRepoMinSha) COOLDOWN_REPO_MIN_SHA="$_value" ;;
            CooldownRepoMaxSha) COOLDOWN_REPO_MAX_SHA="$_value" ;;
            GATEWAY_MIN_VERSION|GATEWAY_MAX_VERSION) ;;
        esac
    done < "$_config"

    [ "$COOLDOWN_REPO_MAX_SHA" = "null" ] && COOLDOWN_REPO_MAX_SHA=""
    [ -n "$COOLDOWN_REPO_MIN_SHA" ] || { echo "ERROR: CooldownRepoMinSha is required in $_config" >&2; return 1; }
}

# Resolve the copilot-env commit to pin under --cooldown: the newest commit on
# origin/main that is >= <days> old, clamped to the config [MIN, MAX] window. A
# MAX ceiling limits the search to that commit's ancestors; if nothing past the
# floor has aged in yet, we pin MIN exactly (cooldown bypassed for the floor), so
# the known-good baseline is always available. Mirrors floatGateway in src/gateway_float.ts.
# NOTE: `--before` filters on the *commit date*, which (unlike npm's registry
# publish time) is advisory and can be backdated. The manually-vetted MIN floor is
# therefore the hard anchor -- the cooldown only ever advances past it as commits
# age in. Assumes a linear main (squash-only merges + required_linear_history), so
# for ALL aged commits the floor fallback is exactly right.
resolve_aged_commit() {  # <repo-dir> <days> -> prints a commit SHA on stdout
    _repo="$1"; _days="$2"; _upper="origin/main"
    if [ -n "$COOLDOWN_REPO_MAX_SHA" ]; then
        git -C "$_repo" merge-base --is-ancestor "$COOLDOWN_REPO_MIN_SHA" "$COOLDOWN_REPO_MAX_SHA" 2>/dev/null \
            || { echo "ERROR: COOLDOWN_REPO_MIN_SHA is not an ancestor of COOLDOWN_REPO_MAX_SHA." >&2; return 1; }
        _upper="$COOLDOWN_REPO_MAX_SHA"
    fi
    _aged="$(git -C "$_repo" rev-list -1 --before="${_days} days ago" "$_upper" 2>/dev/null || true)"
    # Floor: never older than MIN. If nothing past the floor has aged in, pin MIN.
    if [ -z "$_aged" ] || ! git -C "$_repo" merge-base --is-ancestor "$COOLDOWN_REPO_MIN_SHA" "$_aged" 2>/dev/null; then
        _aged="$(git -C "$_repo" rev-parse --verify --quiet "${COOLDOWN_REPO_MIN_SHA}^{commit}" || true)"
        [ -n "$_aged" ] || { echo "ERROR: COOLDOWN_REPO_MIN_SHA (${COOLDOWN_REPO_MIN_SHA}) not found in copilot-env history." >&2; return 1; }
    fi
    printf '%s\n' "$_aged"
}

# Deferred repo-cooldown rollback, armed via an EXIT trap once the aged commit is
# resolved: on ANY exit -- clean finish or a mid-install failure (npm/bun/bootstrap
# error, interrupt) -- roll the installer-managed clone back to the aged commit, so
# under --cooldown it is never left running on fresh origin/main. Preserves the
# original exit status so failures still surface.
apply_repo_cooldown() {
    _rc=$?
    trap - EXIT
    if [ -n "$COOLDOWN_REPO_SHA" ]; then
        echo "Cooldown: pinning copilot-env to ${COOLDOWN_REPO_SHA} (>=${COOLDOWN_DAYS}d old) ..."
        git -C "$REPO_DIR" reset --hard "$COOLDOWN_REPO_SHA" || true
    fi
    exit "$_rc"
}

# --- git (needed to clone; the one prereq that may want the system pkg mgr) -
as_root() {
    if [ "$(id -u)" -eq 0 ]; then "$@"
    elif have sudo; then sudo "$@"
    else echo "ERROR: need root to run: $*" >&2; return 1; fi
}

ensure_git() {
    have git && return 0
    echo "Installing git ..."
    if   have brew;    then brew install git
    elif have apt-get; then as_root apt-get update -y && as_root apt-get install -y git
    elif have dnf;     then as_root dnf install -y git
    elif have yum;     then as_root yum install -y git
    elif have pacman;  then as_root pacman -Sy --noconfirm git
    elif have zypper;  then as_root zypper install -y git
    else
        echo "ERROR: git is required but no supported package manager was found." >&2
        echo "       Install git manually, then re-run install.sh." >&2
        return 1
    fi
}

if [ "$SKIP_PREREQS" = true ] || [ "$LOCAL_INSTALL" = true ]; then
    # Neither --no-prereqs nor --local-install may install git (it needs a system
    # package manager / sudo). git is necessary only when a fresh clone/update is
    # needed (checked at the fetch site below); a reused checkout doesn't need it.
    have git || echo "Note: git not found; required only to clone/update copilot-env." >&2
else
    ensure_git
fi

# --- locate or fetch the repo ---------------------------------------------
# When piped through `curl | bash`, $0 is the shell name and there is no script
# file on disk, so we clone. When run as ./install.sh from a checkout, reuse it.
SELF_DIR=""
case "${0:-}" in
    bash|sh|-bash|-sh|"") ;;
    *) SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)" ;;
esac

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/agents.bashrc" ]; then
    REPO_DIR="$SELF_DIR"
    echo "Using existing checkout at $REPO_DIR"
    load_project_config "$REPO_DIR" || exit 1
else
    if ! have git; then
        echo "ERROR: git is required to clone/update copilot-env into $INSTALL_DIR, but it is not installed (and --no-prereqs / --local-install may not install it). Install git, or run from an existing checkout." >&2
        exit 1
    fi
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo "Updating copilot-env in $INSTALL_DIR ..."
        if [ -n "$COOLDOWN_DAYS" ]; then
            # --cooldown resolves an aged commit by walking history, so it needs a
            # full clone; deepen a previously-shallow checkout, else a plain fetch.
            if [ -f "$INSTALL_DIR/.git/shallow" ]; then
                git -C "$INSTALL_DIR" fetch --unshallow origin main
            else
                git -C "$INSTALL_DIR" fetch origin main
            fi
        else
            git -C "$INSTALL_DIR" fetch --depth 1 origin main
        fi
        git -C "$INSTALL_DIR" reset --hard origin/main
    else
        echo "Cloning copilot-env into $INSTALL_DIR ..."
        # Shallow clone for a fast one-liner install; --cooldown needs full history
        # to resolve an aged commit (resolve_aged_commit), so clone fully for it.
        if [ -n "$COOLDOWN_DAYS" ]; then
            git clone "$REPO_URL" "$INSTALL_DIR"
        else
            git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
        fi
    fi
    REPO_DIR="$INSTALL_DIR"
    load_project_config "$REPO_DIR" || exit 1
    # With --cooldown, hold the copilot-env checkout itself back to the newest
    # commit on main that is >= COOLDOWN_DAYS old (clamped to [MIN, MAX]) -- the
    # same supply-chain delay we apply to npm packages, here defending against a
    # compromised just-pushed commit to this very repo. We resolve the SHA now
    # (off the fresh origin/main we just fetched) but defer the actual rollback to
    # the end of the script: the steps below run from this checkout (e.g. the
    # agent-CLI cooldown resolver in src/install/) and need not exist in that
    # older commit.
    if [ -n "$COOLDOWN_DAYS" ]; then
        COOLDOWN_REPO_SHA="$(resolve_aged_commit "$INSTALL_DIR" "$COOLDOWN_DAYS")" || exit 1
        trap apply_repo_cooldown EXIT
    fi
fi

AGENTS_BASHRC="${REPO_DIR}/agents.bashrc"
[ -f "$AGENTS_BASHRC" ] || { echo "ERROR: Could not find agents.bashrc at $AGENTS_BASHRC" >&2; exit 1; }

# --- Node.js (needed only for the agent CLIs) -----------------------------
# Respect the user's toolchain: if node + npm are already on PATH, use them as-is
# and install nothing. Only when node is absent do we install a user-local nvm LTS
# (no sudo) -- nvm's installer also wires its loader into your shell rc so `node`
# is available in new shells (the gateway daemon needs it). Mirrors install.ps1,
# whose winget Node step likewise no-ops when node is already present.
if [ "$SKIP_PREREQS" = true ]; then
    # Node/npm are optional (they only power the agent CLIs; the gateway runs on
    # bun). Warn if absent, never install.
    warn_missing node "Node.js"
    warn_missing npm "npm"
elif have node && have npm; then
    # User already has a node -- don't dictate their toolchain. The `npm install -g`
    # below targets whatever prefix that node uses (which may need sudo on a system
    # node; that's the user's environment to manage).
    echo "Using existing Node.js ($(node --version 2>/dev/null), npm $(npm --version 2>/dev/null)) -- skipping nvm/node install."
else
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        echo "Installing nvm ($NVM_VERSION) ..."
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
    fi
    # Guard against a silently-empty `curl | bash` (no pipefail): nvm.sh must exist.
    [ -s "$NVM_DIR/nvm.sh" ] || { echo "ERROR: nvm install failed ($NVM_DIR/nvm.sh missing)." >&2; exit 1; }

    # nvm.sh and its commands aren't written for `set -eu`; relax around them, capture
    # the combined status, then re-assert strict mode. An nvm-managed LTS keeps npm
    # global installs in nvm's user-local prefix -- no sudo.
    export NVM_DIR
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    echo "Installing/activating Node.js LTS via nvm ..."
    # `nvm install --lts` already activates the version it installs (even when it's
    # "already installed"), so no separate `nvm use` -- that only re-prints "Now
    # using node ...".
    nvm install --lts && nvm alias default 'lts/*'
    nvm_status=$?
    set -eu
    [ "$nvm_status" -eq 0 ] || { echo "ERROR: nvm failed to install/activate Node LTS." >&2; exit 1; }

    # Confirm the *active* node and npm are the nvm ones we just installed, so
    # `npm install -g` below lands in nvm's user-local prefix (no sudo).
    for _bin in node npm; do
        case "$(command -v "$_bin" 2>/dev/null)" in
            "$NVM_DIR"/*) ;;
            *) echo "ERROR: active $_bin is not nvm-managed ($(command -v "$_bin" 2>/dev/null || echo 'not found'))." >&2; exit 1 ;;
        esac
    done
fi

# --- bun via its official installer (user-local, no sudo) -----------------
if [ "$SKIP_PREREQS" = true ]; then
    # bun is the gateway runtime -- necessary. Fail loudly if it is absent.
    if ! have bun && [ ! -x "$HOME/.bun/bin/bun" ]; then
        echo "ERROR: bun is required to run copilot-env, but it is not installed (--no-prereqs). Install bun (https://bun.sh) and re-run." >&2
        exit 1
    fi
else
    if ! have bun && [ ! -x "$HOME/.bun/bin/bun" ]; then
        echo "Installing bun ..."
        curl -fsSL https://bun.sh/install | bash >/dev/null
    fi
fi
[ -x "$HOME/.bun/bin/bun" ] && case ":$PATH:" in
    *":$HOME/.bun/bin:"*) ;;
    *) PATH="$HOME/.bun/bin:$PATH" ;;
esac
export PATH

# --- agent CLIs (npm install -g into the active node's global prefix) ------
# With --cooldown, resolve the newest published release of <pkg> that is at
# least COOLDOWN_DAYS old (excluding prereleases) and pin to it, instead of
# trusting npm's `latest` tag -- the same supply-chain delay bunfig.toml gives
# the gateway's deps. The resolution lives in src/install/aged-version.ts (shared
# verbatim with install.ps1, and unit-tested) and runs under the bun we just
# installed; here we only feed it `npm view <pkg> time`.
resolve_aged_version() {  # <pkg> <days> -> prints a pinned version on stdout
    npm view "$1" time --json 2>/dev/null \
        | bun "${REPO_DIR}/src/install/aged-version.ts" --days "$2"
}

ensure_cli() {  # ensure_cli <command> <description> <npm-package>
    # --cooldown governs FRESH installs only: an already-present CLI is left as-is
    # (we never downgrade a CLI the user installed themselves). Re-run after
    # uninstalling, or `npm i -g <pkg>@<version>` manually, to change a pinned one.
    if have "$1"; then echo "$2 already installed."; return 0; fi
    spec="$3"
    if [ -n "$COOLDOWN_DAYS" ]; then
        if ! ver="$(resolve_aged_version "$3" "$COOLDOWN_DAYS")" || [ -z "$ver" ]; then
            echo "ERROR: no release of $3 is >=${COOLDOWN_DAYS} days old (or npm/registry unreachable)." >&2
            return 1
        fi
        spec="$3@$ver"
        echo "Installing $2 ($spec, cooled down >=${COOLDOWN_DAYS}d) ..."
    else
        echo "Installing $2 ..."
    fi
    npm install -g "$spec"
}
if [ "$SKIP_PREREQS" = true ]; then
    # The agent CLIs are optional (they back cl/co/cx). Warn if absent, never install.
    warn_missing claude "Claude Code CLI"
    warn_missing copilot "GitHub Copilot CLI"
    warn_missing codex "Codex CLI"
else
    ensure_cli claude "Claude Code CLI" "@anthropic-ai/claude-code"
    ensure_cli copilot "GitHub Copilot CLI" "@github/copilot"
    ensure_cli codex "Codex CLI" "@openai/codex"
fi

# --- wire the shell integration -------------------------------------------
SOURCE_BLOCK="AGENTS_BASHRC=\"${AGENTS_BASHRC}\"
"'[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"'

MARKER="# copilot-env shell integration"

already_installed() { grep -qF "$MARKER" "$1" 2>/dev/null; }

install_to() {
    rc="$1"
    if already_installed "$rc"; then
        echo "Already installed in $rc -- skipping."
        return
    fi
    printf '\n# copilot-env shell integration\n%s\n' "$SOURCE_BLOCK" >> "$rc"
    echo "Installed to $rc"
}

installed=false
if [ "$SKIP_SHELL_INTEGRATION" = true ]; then
    echo "Skipping shell wiring (--no-shell-integration)."
else
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [ -f "$rc" ]; then
            install_to "$rc"
            installed=true
        fi
    done

    # No rc file yet -- create one matching the login shell (curl|bash-safe: no prompt).
    if [ "$installed" = false ]; then
        case "$(basename "${SHELL:-/bin/bash}")" in
            zsh) rc="$HOME/.zshrc" ;;
            *)   rc="$HOME/.bashrc" ;;
        esac
        touch "$rc"
        install_to "$rc"
    fi
fi

# Clean-finish repo-cooldown rollback: disarm the failure trap and roll the
# managed clone back to the aged commit now (before "Done"), so its output
# doesn't trail the final message. The trap still covers any earlier failure.
if [ -n "$COOLDOWN_REPO_SHA" ]; then
    trap - EXIT
    echo "Cooldown: pinning copilot-env to ${COOLDOWN_REPO_SHA} (>=${COOLDOWN_DAYS}d old) ..."
    git -C "$REPO_DIR" reset --hard "$COOLDOWN_REPO_SHA"
fi

echo ""
if [ "$SKIP_SHELL_INTEGRATION" = true ]; then
    echo "Done. Shell wiring was skipped (--no-shell-integration). To enable it, add to your rc:"
    echo "  AGENTS_BASHRC=\"${AGENTS_BASHRC}\""
    echo '  [ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"'
else
    echo "Done. Restart your shell or run: source ~/.bashrc  (or ~/.zshrc)"
fi
echo "Then use 'agent start' to launch the gateway, or cl / co / cx to launch an agent."
