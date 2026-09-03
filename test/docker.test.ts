import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/utils/json.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { runSync } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The runtime pin has ONE source of truth (.dvmrc); the Dockerfile's ARG
// default is a convenience copy for bare `docker build` - pin the two together
// so a version bump cannot silently fork them.
test("Dockerfile's DENO_VERSION default tracks .dvmrc", () => {
  const dvmrc = readFileSync(join(PROJECT_ROOT, ".dvmrc"), "utf8").trim();
  const dockerfile = readFileSync(join(PROJECT_ROOT, "Dockerfile"), "utf8");
  const arg = dockerfile.match(/^ARG DENO_VERSION=(\S+)$/m);
  expect(arg?.[1]).toBe(dvmrc);
});

// Podman resolves unqualified image names against configurable registries and
// prompts interactively when ambiguous; a fully-qualified ref keeps the build
// engine-agnostic.
test("Dockerfile FROM is fully qualified for podman", () => {
  const dockerfile = readFileSync(join(PROJECT_ROOT, "Dockerfile"), "utf8");
  const from = dockerfile.match(/^FROM (\S+)/m);
  expect(from?.[1]).toMatch(/^docker\.io\//);
});

// The image must never inherit the host's installed dependency tree or local
// secrets: the dependency layer is built from the lockfile alone.
test(".dockerignore keeps host state out of the build context", () => {
  // Parsed entries, not substring hits: a commented-out `# .env` or a substring
  // inside a longer pattern must not count.
  const entries = readFileSync(join(PROJECT_ROOT, ".dockerignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const keepOut = ["node_modules/", ".git/", ".claude/", ".env"];
  for (const entry of keepOut) {
    expect(entries).toContain(entry);
  }
  // Negations are fine in general -- but never one that could re-admit a
  // protected path. Dot segments are cleaned first (docker normalizes them
  // before matching), then judged by the pattern's literal prefix (up to the
  // first glob metachar): exact/under the protected root always counts, and for
  // a glob pattern any literal that the root extends counts too (conservative:
  // `!**` and `!.env*` fail, a disjoint `!README.md` passes).
  const negated = entries
    .filter((line) => line.startsWith("!"))
    .map((line) =>
      line
        .slice(1)
        .split("/")
        .reduce<string[]>((parts, seg) => {
          if (seg === "" || seg === ".") return parts;
          if (seg === "..") return parts.slice(0, -1);
          return [...parts, seg];
        }, [])
        .join("/")
    );
  for (const pattern of negated) {
    const literal = pattern.split(/[*?[\\]/)[0] ?? "";
    const hasGlob = /[*?[\\]/.test(pattern);
    for (const entry of keepOut) {
      const root = entry.replace(/\/$/, "");
      const readmits = literal === root || literal.startsWith(`${root}/`) ||
        (hasGlob && root.startsWith(literal));
      expect(readmits, `!${pattern} re-admits ${entry}`).toBe(false);
    }
  }
});

// The user decision behind the container setup: the lifecycle smoke rewires
// agent configs in whatever HOME it sees, so it must refuse to start on a
// developer machine. Pin the guard so it cannot be silently removed.
test("lifecycle-smoke.sh refuses to run outside a container or CI", () => {
  const smokePath = join(PROJECT_ROOT, ".github/scripts/lifecycle-smoke.sh");
  const lines = readFileSync(smokePath, "utf8").split("\n");
  // The guard's condition, pinned byte-exactly: a reworded, inverted, or
  // partially deleted conditional fails here, where substring hits on the
  // marker paths would survive all three.
  const guardAt = lines.indexOf(
    'if [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ] && [ "${GITHUB_ACTIONS:-}" != "true" ]; then',
  );
  expect(guardAt).toBeGreaterThanOrEqual(0);
  const fiAt = lines.indexOf("fi", guardAt);
  expect(fiAt).toBeGreaterThan(guardAt);
  // The body must genuinely exit (a whole trimmed line, so a commented-out
  // `# exit 1` cannot satisfy it); its message copy is the executed control's
  // business, not a byte pin's.
  expect(lines.slice(guardAt + 1, fiAt).map((line) => line.trim())).toContain("exit 1");
  // ...and the guard sits BEFORE the first daemon command.
  const startAt = lines.findIndex((line) => line.includes("cli start"));
  expect(startAt).toBeGreaterThan(fiAt);

  // Executed control where the guard path is reachable: on a POSIX machine with
  // no container markers, the real script must die on the guard (nonzero, its
  // own message) before starting anything. In the container/CI-marked runs the
  // markers legitimately admit the script, so only the static pin above applies.
  if (
    process.platform === "win32" || existsSync("/.dockerenv") || existsSync("/run/.containerenv")
  ) {
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), "copilot-smoke-guard-"));
  try {
    const proc = runSync("/bin/bash", [smokePath], {
      env: {
        ...process.env,
        "GITHUB_ACTIONS": "",
        // Safe by construction, not by the static pin: bash is invoked by
        // absolute path and the child's PATH points at nothing, so even a
        // structurally broken guard could never resolve `deno` and launch the
        // real lifecycle (the guard itself needs only bash builtins). The
        // scratch homes are belt and braces on top.
        "PATH": join(scratch, "no-bin"),
        "HOME": scratch,
        "COPILOT_API_HOME": scratch,
        "CODEX_HOME": join(scratch, ".codex"),
        "CLAUDE_CONFIG_DIR": join(scratch, ".claude"),
      },
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("test:docker --lifecycle");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The runner is one cross-platform implementation; the task must point at it.
test("the test:docker task wires the TS runner", () => {
  const config: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, "deno.json"), "utf8"));
  if (!isRecord(config) || !isRecord(config.tasks)) {
    throw new Error("deno.json has no tasks table");
  }
  expect(config.tasks["test:docker"]).toContain("scripts/test_docker.ts");
});
