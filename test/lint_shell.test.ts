import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverLintTargets } from "../scripts/lint_shell.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// The whole list per kind is pinned over one fixture tree, so a change to any discovery rule
// (pruned dirs, suffix case, symlinks, the fixed entries) reads as a changed list.
test("discoverLintTargets walks the tree by suffix, prunes vendored dirs, adds the fixed entries", () => {
  const root = tempDir("copilot-lint-shell-");
  const files = [
    "install.sh",
    "install.ps1",
    "shell/agents.bashrc",
    "shell/agents.ps1",
    "deep/er/nested.sh",
    "deep/er/nested.ps1",
    "deep/er/Mixed.Ps1",
    "deep/er/.bashrc",
    "deep/notes.sh.md",
    "node_modules/pkg/vendored.sh",
    "skills/x/Node_Modules/pkg/vendored.ps1",
    ".git/hooks/pre-commit.sh",
    ".claude/worktrees/w/install.sh",
    ".husky/_/husky.sh",
    ".husky/pre-commit.sh",
    "bin/agent",
    "bin/agent.ps1",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  // A symlink to a script is not a regular file and is never linted twice (POSIX only:
  // symlink creation on Windows needs a privilege the runner may lack).
  if (process.platform !== "win32") symlinkSync(join(root, "install.sh"), join(root, "link.sh"));

  expect(discoverLintTargets(root, "sh")).toEqual([
    ".githooks/pre-commit",
    ".husky/pre-commit.sh",
    "bin/agent",
    "deep/er/.bashrc",
    "deep/er/nested.sh",
    "install.sh",
    "shell/agents.bashrc",
  ]);
  expect(discoverLintTargets(root, "ps")).toEqual([
    "bin/agent.ps1",
    "deep/er/Mixed.Ps1",
    "deep/er/nested.ps1",
    "install.ps1",
    "shell/agents.ps1",
  ]);
});
