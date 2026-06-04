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
#   COPILOT_ENV_DIR   clone target when fetching fresh (default ~/.copilot-env)

set -eu

REPO_URL="https://github.com/Vivswan/copilot-env.git"
INSTALL_DIR="${COPILOT_ENV_DIR:-$HOME/.copilot-env}"
NVM_VERSION="v0.40.1"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

usage() {
    cat <<'EOF'
Usage: install.sh

Installs Node (via nvm), bun, and the agent CLIs, clones/updates copilot-env,
and adds its shell integration to ~/.bashrc / ~/.zshrc.
EOF
}

for arg in "$@"; do
    case "$arg" in
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
    esac
done

have() { command -v "$1" >/dev/null 2>&1; }

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

ensure_git

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
else
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo "Updating copilot-env in $INSTALL_DIR ..."
        git -C "$INSTALL_DIR" pull --ff-only
    else
        echo "Cloning copilot-env into $INSTALL_DIR ..."
        git clone "$REPO_URL" "$INSTALL_DIR"
    fi
    REPO_DIR="$INSTALL_DIR"
fi

AGENTS_BASHRC="${REPO_DIR}/agents.bashrc"
[ -f "$AGENTS_BASHRC" ] || { echo "ERROR: Could not find agents.bashrc at $AGENTS_BASHRC" >&2; exit 1; }

# --- Node.js via nvm (user-local, no sudo) --------------------------------
# nvm's installer wires its loader into your shell rc so `node` is available in
# new shells (the gateway daemon needs it) -- we deliberately let it do that.
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "Installing nvm ($NVM_VERSION) ..."
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
fi
# Guard against a silently-empty `curl | bash` (no pipefail): nvm.sh must exist.
[ -s "$NVM_DIR/nvm.sh" ] || { echo "ERROR: nvm install failed ($NVM_DIR/nvm.sh missing)." >&2; exit 1; }

# nvm.sh and its commands aren't written for `set -eu`; relax around them, capture
# the combined status, then re-assert strict mode. Installing + using an
# nvm-managed LTS (idempotent) keeps npm global installs in nvm's user-local
# prefix -- no sudo -- regardless of any pre-existing system Node.
export NVM_DIR
set +eu
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
echo "Installing/activating Node.js LTS via nvm ..."
nvm install --lts && nvm use --lts && nvm alias default 'lts/*'
nvm_status=$?
set -eu
[ "$nvm_status" -eq 0 ] || { echo "ERROR: nvm failed to install/activate Node LTS." >&2; exit 1; }

# Confirm the *active* node and npm are nvm-managed, so `npm install -g` below
# lands in nvm's user-local prefix (no sudo) rather than a system Node prefix.
for _bin in node npm; do
    case "$(command -v "$_bin" 2>/dev/null)" in
        "$NVM_DIR"/*) ;;
        *) echo "ERROR: active $_bin is not nvm-managed ($(command -v "$_bin" 2>/dev/null || echo 'not found'))." >&2; exit 1 ;;
    esac
done

# --- bun via its official installer (user-local, no sudo) -----------------
if ! have bun && [ ! -x "$HOME/.bun/bin/bun" ]; then
    echo "Installing bun ..."
    curl -fsSL https://bun.sh/install | bash >/dev/null
fi
[ -x "$HOME/.bun/bin/bun" ] && case ":$PATH:" in
    *":$HOME/.bun/bin:"*) ;;
    *) PATH="$HOME/.bun/bin:$PATH" ;;
esac
export PATH

# --- agent CLIs (npm global lands in nvm's prefix -- no sudo) --------------
ensure_cli() {  # ensure_cli <command> <description> <npm-package>
    if have "$1"; then echo "$2 already installed."; return 0; fi
    echo "Installing $2 ..."
    npm install -g "$3"
}
ensure_cli claude "Claude Code CLI" "@anthropic-ai/claude-code"
ensure_cli copilot "GitHub Copilot CLI" "@github/copilot"
ensure_cli codex "Codex CLI" "@openai/codex"

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

echo ""
echo "Done. Restart your shell or run: source ~/.bashrc  (or ~/.zshrc)"
echo "Then use 'agent start' to launch the gateway, or cl / co / cx to launch an agent."
