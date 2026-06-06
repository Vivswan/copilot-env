#!/usr/bin/env bash
# copilot-env installer (Linux + macOS).
#
# First-time install: installs prerequisites (Node via nvm when absent, bun via its
# official installer) and the agent CLIs (claude / copilot / codex), clones the
# latest copilot-env *release*, then wires the shell integration by running
# `agent shell-integration`. Updates are NOT done here -- use `agent update`. Runs
# two ways:
#
#   # one-liner -- no local checkout needed:
#   curl -fsSL https://raw.githubusercontent.com/Vivswan/copilot-env/main/install.sh | bash
#
#   # from an existing checkout:
#   ./install.sh
#
# Env:
#   COPILOT_ENV_DIR   clone target (default ~/.copilot-env); --dir takes precedence.

set -eu

REPO_URL="https://github.com/Vivswan/copilot-env.git"
INSTALL_DIR_ARG=""        # set by --dir; takes precedence over $COPILOT_ENV_DIR
SKIP_PREREQS=false        # --no-prereqs: verify tools, never install them
LOCAL_INSTALL=false       # --local-install: install only via curl/npm, never sudo/pkg-mgr
SKIP_SHELL_INTEGRATION=false  # --no-shell-integration: don't wire the integration into rc files
NVM_VERSION="v0.40.1"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
COOLDOWN_DEFAULT_DAYS=7   # matches bunfig.toml install.minimumReleaseAge (604800s)
COOLDOWN_DAYS=""          # empty = disabled (install the latest release + npm `latest`)

usage() {
    cat <<'EOF'
Usage: install.sh [--dir DIR] [--cooldown[=DAYS]] [--no-prereqs] [--local-install] [--no-shell-integration]

First-time install: installs Node (via nvm if absent), bun, and the agent CLIs,
clones the latest copilot-env release, and wires the shell integration via
`agent shell-integration`. Use `agent update` to update later.

Options:
  --dir DIR           Clone target (default ~/.copilot-env). Takes precedence over
                      $COPILOT_ENV_DIR. Ignored when run from an existing checkout.
  --cooldown[=DAYS]   Supply-chain delay: install the newest copilot-env release
                      AND the newest agent-CLI (claude / copilot / codex) releases
                      that have been public for at least DAYS days, so a compromised
                      just-published version has time to be caught before adoption.
                      Bare --cooldown uses 7 days (matching bunfig.toml).
  --no-prereqs        Do not install any prerequisites (git, Node, bun) or the
                      agent CLIs -- only verify them. A missing *necessary* tool
                      (bun; git when a clone is needed) is a fatal error; a
                      missing *optional* tool (Node/npm, the agent CLIs) is a
                      warning. The repo clone and shell wiring still run.
  --local-install     Install prerequisites only via user-local methods (the
                      curl/npm installers); never use sudo or a system package
                      manager (brew/apt/dnf/...). Node (nvm), bun, and the agent
                      CLIs install as usual; git cannot be installed this way, so
                      a missing git is a fatal error when a clone is needed.
                      Mutually exclusive with --no-prereqs.
  --no-shell-integration
                      Do everything except run `agent shell-integration` (which
                      wires ~/.bashrc / ~/.zshrc). The repo, prerequisites, and
                      agent CLIs still install; run `agent shell-integration`
                      yourself later. Useful for CI or a hand-managed shell rc.
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

# Newest published release tag (vX.Y.Z) for $REPO_URL, or empty if none exist yet.
latest_release_tag() {
    git ls-remote --tags --sort=-v:refname "$REPO_URL" 'v*' 2>/dev/null \
        | sed -n 's#.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' \
        | head -1
}

# Under --cooldown, the newest release tag at least <days> old (a supply-chain
# delay: skip a just-cut release until it has been public long enough to be pulled
# if bad). Falls back to the OLDEST available release when nothing has aged in yet
# (maximum delay). Needs a full clone (all tags + their dates); prints empty when
# the repo has no release tags at all (caller then stays on main).
resolve_aged_release() {  # <repo-dir> <days> -> prints a tag (or empty) on stdout
    _repo="$1"; _days="$2"
    # 10# forces base-10 so a zero-padded --cooldown=08/09 isn't parsed as octal.
    _cutoff=$(( $(date +%s) - (10#$_days) * 86400 ))
    _aged=""; _oldest=""
    # for-each-ref lists release tags newest-first with their unix creator date.
    while read -r _ts _tag; do
        # Accept ONLY exact vX.Y.Z (rejects v1.2.3-rc1, v1.2.3.4, v1.2.3v, ...) --
        # parity with install.ps1's ^v\d+\.\d+\.\d+$ and update.ts.
        printf '%s\n' "$_tag" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$' || continue
        _oldest="$_tag"
        if [ "$_ts" -le "$_cutoff" ]; then _aged="$_tag"; break; fi
    done <<EOF
$(git -C "$_repo" for-each-ref --sort=-creatordate --format='%(creatordate:unix) %(refname:short)' 'refs/tags/v*')
EOF
    printf '%s\n' "${_aged:-$_oldest}"
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
elif [ -d "$INSTALL_DIR/.git" ]; then
    if [ ! -f "$INSTALL_DIR/agents.bashrc" ]; then
        echo "ERROR: $INSTALL_DIR has a .git but no agents.bashrc -- an incomplete/corrupt clone. Remove it and re-run install.sh." >&2
        exit 1
    fi
    # Reuse (don't re-clone or update) an existing checkout: completes/repairs a
    # half-finished install and is idempotent for a finished one. Moving to a newer
    # release is `agent update`'s job, not the installer's.
    REPO_DIR="$INSTALL_DIR"
    echo "Found existing copilot-env at $REPO_DIR; completing/repairing it (run 'agent update' to move to a newer release)."
else
    if ! have git; then
        echo "ERROR: git is required to clone copilot-env into $INSTALL_DIR, but it is not installed (and --no-prereqs / --local-install may not install it). Install git, or run from an existing checkout." >&2
        exit 1
    fi
    if [ -n "$COOLDOWN_DAYS" ]; then
        # Cooldown picks an aged release, which needs all tags + their dates, so a
        # full clone. Resolve the aged tag and check it out immediately -- the older
        # release already contains every install step below, so the whole install
        # runs from the aged checkout and no deferred rollback is needed.
        echo "Cloning copilot-env into $INSTALL_DIR ..."
        git clone "$REPO_URL" "$INSTALL_DIR"
        _aged="$(resolve_aged_release "$INSTALL_DIR" "$COOLDOWN_DAYS")"
        if [ -n "$_aged" ]; then
            echo "Cooldown: checking out release $_aged (>=${COOLDOWN_DAYS}d old) ..."
            git -C "$INSTALL_DIR" -c advice.detachedHead=false checkout "$_aged"
        else
            echo "Cooldown: no copilot-env releases yet; staying on main." >&2
        fi
    else
        _ref="$(latest_release_tag)"
        if [ -n "$_ref" ]; then
            echo "Cloning copilot-env release $_ref into $INSTALL_DIR ..."
            git clone --branch "$_ref" --depth 1 "$REPO_URL" "$INSTALL_DIR"
        else
            echo "No copilot-env release found yet; installing from main ..."
            git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
        fi
    fi
    REPO_DIR="$INSTALL_DIR"
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

# --- wire the shell integration (delegated to `agent shell-integration`) ---
# The wiring logic lives in one place now -- the `agent shell-integration` command
# (src/commands/shell_integration.ts). Running it via bin/agent also triggers the
# in-place `bun install` (gateway float) on this fresh checkout.
if [ "$SKIP_SHELL_INTEGRATION" = true ]; then
    echo "Skipping shell wiring (--no-shell-integration)."
else
    "${REPO_DIR}/bin/agent" shell-integration
fi

echo ""
if [ "$SKIP_SHELL_INTEGRATION" = true ]; then
    echo "Done. Shell wiring was skipped (--no-shell-integration); run 'agent shell-integration' to enable it."
else
    echo "Done. Restart your shell to load the integration."
fi
echo "Then use 'agent start' to launch the gateway, or cl / co / cx to launch an agent."
