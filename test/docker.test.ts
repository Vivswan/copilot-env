import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/utils/json.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
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
  const ignore = readFileSync(join(PROJECT_ROOT, ".dockerignore"), "utf8");
  for (const entry of ["node_modules/", ".git/", ".claude/", ".env"]) {
    expect(ignore).toContain(entry);
  }
});

// The user decision behind the container setup: the lifecycle smoke rewires
// agent configs in whatever HOME it sees, so it must refuse to start on a
// developer machine. Pin the guard so it cannot be silently removed.
test("lifecycle-smoke.sh refuses to run outside a container or CI", () => {
  const smoke = readFileSync(join(PROJECT_ROOT, ".github/scripts/lifecycle-smoke.sh"), "utf8");
  expect(smoke).toContain("/.dockerenv");
  expect(smoke).toContain("/run/.containerenv");
  expect(smoke).toContain("GITHUB_ACTIONS");
  const guardAt = smoke.indexOf("/.dockerenv");
  const firstCommand = smoke.indexOf("cli start");
  expect(guardAt).toBeGreaterThan(0);
  expect(guardAt).toBeLessThan(firstCommand);
});

// The runner is one cross-platform implementation; the task must point at it.
test("the test:docker task wires the TS runner", () => {
  const config: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, "deno.json"), "utf8"));
  if (!isRecord(config) || !isRecord(config.tasks)) {
    throw new Error("deno.json has no tasks table");
  }
  expect(config.tasks["test:docker"]).toContain("scripts/test_docker.ts");
});
