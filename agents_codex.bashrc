# Codex wiring for the local copilot-api gateway.
# Must be compatible with both bash and zsh (POSIX constructs only).
#
# Sourced AFTER agents.bashrc (which defines the gateway-only copilot-start).
# Optional add-on: wires Codex at a per-host CODEX_HOME pointing at the local
# gateway, so codex talks to the gateway instead of OpenAI directly.

# Resolve this file's directory (bash and zsh compatible). Co-located with
# agents.bashrc, so the bin shims live in ./bin.
_AGENTS_CODEX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)"

# Redefine copilot-start to also create/refresh a host-local CODEX_HOME from the
# gateway env it just exported. Mirrors agents.bashrc's gateway start, then runs
# the codex-home shim (prints the resolved path to stdout; status/warnings go to
# stderr). _AGENTS_CODEX_DIR is baked in at definition time.
eval "function copilot-start {
    \"${_AGENTS_CODEX_DIR}/bin/copilot-api\" start \"\$@\" && \
    eval \"\$(\"${_AGENTS_CODEX_DIR}/bin/copilot-api\" env)\" || return \$?
    _codex_home=\"\$(\"${_AGENTS_CODEX_DIR}/bin/codex-home\" \
        --base-url \"\${OPENAI_BASE_URL}\" \
        --api-key \"\${OPENAI_API_KEY}\")\" || return \$?
    export CODEX_HOME=\"\${_codex_home}\"
    unset _codex_home
}"

# Eagerly export CODEX_HOME on shell startup if a host-local codex home already
# exists. `--hostname-path` just resolves the canonical path (no bootstrap, no
# config writes); we only export when that dir actually exists.
_codex_dir="$("${_AGENTS_CODEX_DIR}/bin/codex-home" --hostname-path 2>/dev/null)"
[ -n "$_codex_dir" ] && [ -d "$_codex_dir" ] && export CODEX_HOME="$_codex_dir"
unset _codex_dir

unset _AGENTS_CODEX_DIR
