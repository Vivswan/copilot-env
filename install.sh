#!/usr/bin/env bash
# Install the copilot-env shell integration by adding a source block to
# ~/.bashrc and/or ~/.zshrc.
# Usage: bash install.sh [--codex]
#   --codex  also source agents_codex.bashrc (Codex CODEX_HOME wiring)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_BASHRC="${SCRIPT_DIR}/agents.bashrc"
CODEX_BASHRC="${SCRIPT_DIR}/agents_codex.bashrc"

WANT_CODEX=false
for arg in "$@"; do
    case "$arg" in
        --codex) WANT_CODEX=true ;;
        -h|--help)
            sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "ERROR: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
    esac
done

if [ ! -f "$AGENTS_BASHRC" ]; then
    echo "ERROR: Could not find agents.bashrc at $AGENTS_BASHRC" >&2
    exit 1
fi
if [ "$WANT_CODEX" = true ] && [ ! -f "$CODEX_BASHRC" ]; then
    echo "ERROR: --codex requested but agents_codex.bashrc not found at $CODEX_BASHRC" >&2
    exit 1
fi

SOURCE_BLOCK="AGENTS_BASHRC=\"${AGENTS_BASHRC}\"
"'[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"'
if [ "$WANT_CODEX" = true ]; then
    SOURCE_BLOCK="${SOURCE_BLOCK}
AGENTS_CODEX_BASHRC=\"${CODEX_BASHRC}\"
"'[ -f "$AGENTS_CODEX_BASHRC" ] && source "$AGENTS_CODEX_BASHRC"'
fi

MARKER="agents.bashrc"

already_installed() {
    grep -qF "$MARKER" "$1" 2>/dev/null
}

install_to() {
    local rc="$1"
    if already_installed "$rc"; then
        echo "Already installed in $rc -- skipping."
        return
    fi
    printf '\n# copilot-env shell integration\n%s\n' "$SOURCE_BLOCK" >> "$rc"
    echo "Installed to $rc"
}

bashrc="$HOME/.bashrc"
zshrc="$HOME/.zshrc"
installed=false

if [ -f "$bashrc" ]; then
    install_to "$bashrc"
    installed=true
fi

if [ -f "$zshrc" ]; then
    install_to "$zshrc"
    installed=true
fi

if [ "$installed" = true ]; then
    echo ""
    echo "Done. Run 'source ~/.bashrc' or 'source ~/.zshrc' to activate, or open a new shell."
    echo "Then use 'agent start' to launch the gateway, or cl / co / cx to launch an agent."
    exit 0
fi

# Neither rc file exists -- default to the user's shell if bash/zsh, otherwise ~/.bashrc
current_shell="$(basename "${SHELL:-/bin/bash}")"
case "$current_shell" in
    bash) rc="$HOME/.bashrc" ;;
    zsh)  rc="$HOME/.zshrc" ;;
    *)    echo "WARNING: Unsupported shell '$current_shell'. Only bash and zsh are supported." >&2
          rc="$HOME/.bashrc"
          echo "Defaulting to $rc" ;;
esac
echo "Neither ~/.bashrc nor ~/.zshrc found."
printf "Create %s and add the copilot-env source block? [Y/n] " "$rc"
read -r answer
case "$answer" in
    [nN]|[nN][oO])
        echo "Aborted. You can manually add the following to your shell rc file:"
        echo ""
        echo "$SOURCE_BLOCK"
        ;;
    *)
        touch "$rc"
        install_to "$rc"
        echo ""
        echo "Done."
        echo "Run 'source $rc' to activate, or open a new shell."
        ;;
esac
