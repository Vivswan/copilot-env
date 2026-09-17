---
title: Development
group: Internals
order: 6
---

# Development

How to drive the CLI from a checkout and where the repository's own rules live. Users install a release instead ([getting started](getting-started.md#install)); `agent update` refuses to overwrite a checkout unless you pass `--force`.

Deps install into the checkout (`deno install --frozen`); the proxy floats into the copilot-env data home on the first `agent start`, the same as a release.

```bash
git clone https://github.com/Vivswan/copilot-env.git
cd copilot-env
bash scripts/setup-env.sh   # one-shot env/worktree init (deno install --frozen)
./bin/agent --help          # or: powershell -File bin\agent.ps1 --help
```

- **Tasks:** run `deno task` for the list (typecheck, test, bench, lint, check). They are defined in `deno.json`.
- **Env init:** `scripts/setup-env.sh` (`setup-env.ps1` on Windows) is the single initializer. The Copilot coding agent and Codespaces / Dev Containers both run it.
- **Checks before a push:** the tasks and the pre-commit hook are listed in [CONTRIBUTING.md](../CONTRIBUTING.md).
- **Rules and decisions:** the conventions, the hard rules, and the decisions a reader would otherwise reverse (the proxy float, one credential, atomic profiles) live in [`AGENTS.md`](../AGENTS.md).
- **Layering:** the layers, the edges they draw, and the decisions as diagrams are on the [architecture page](architecture.md); `architecture.json` declares the edges and `deno task test` fails on any import it does not declare.
