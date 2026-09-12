import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/utils/json.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, test } from "./helpers/testing.ts";

// .dvmrc is the one source of truth for the runtime pin; the Dockerfile ARG default is a copy
// for bare `docker build`, so a version bump must not fork them.
test("Dockerfile's DENO_VERSION default tracks .dvmrc", () => {
  const dvmrc = readFileSync(join(PROJECT_ROOT, ".dvmrc"), "utf8").trim();
  const dockerfile = readFileSync(join(PROJECT_ROOT, "Dockerfile"), "utf8");
  const arg = dockerfile.match(/^ARG DENO_VERSION=(\S+)$/m);
  expect(arg?.[1]).toBe(dvmrc);
});

// Podman resolves unqualified image names against configurable registries and prompts when
// ambiguous; a fully-qualified ref keeps the build engine-agnostic.
test("Dockerfile FROM is fully qualified for podman", () => {
  const dockerfile = readFileSync(join(PROJECT_ROOT, "Dockerfile"), "utf8");
  const from = dockerfile.match(/^FROM (\S+)/m);
  expect(from?.[1]).toMatch(/^docker\.io\//);
});

// The image must never inherit the host's installed dependency tree or local
// secrets: the dependency layer is built from the lockfile alone.
const KEEP_OUT = ["node_modules/", ".git/", ".claude/", ".env"];

// Docker cleans dot segments before matching, so the pattern is cleaned the same way first.
// A glob is judged by its literal prefix and errs toward re-admitting: `!.env*` and `!**` both count.
function negationReadmits(pattern: string, entry: string): boolean {
  const cleaned = pattern
    .split("/")
    .reduce<string[]>((parts, seg) => {
      if (seg === "" || seg === ".") return parts;
      if (seg === "..") return parts.slice(0, -1);
      return [...parts, seg];
    }, [])
    .join("/");
  const literal = cleaned.split(/[*?[\\]/)[0] ?? "";
  const hasGlob = /[*?[\\]/.test(cleaned);
  const root = entry.replace(/\/$/, "");
  return literal === root || literal.startsWith(`${root}/`) ||
    (hasGlob && root.startsWith(literal));
}

test(".dockerignore keeps host state out of the build context", () => {
  // Parsed entries, not substring hits: a commented-out `# .env` or a substring
  // inside a longer pattern must not count.
  const entries = readFileSync(join(PROJECT_ROOT, ".dockerignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  for (const entry of KEEP_OUT) {
    expect(entries).toContain(entry);
  }
  // A negation is fine unless it could re-admit a protected path.
  for (const line of entries.filter((entry) => entry.startsWith("!"))) {
    for (const entry of KEEP_OUT) {
      expect(negationReadmits(line.slice(1), entry), `${line} re-admits ${entry}`).toBe(false);
    }
  }
});

// The committed .dockerignore has no negation lines, so the loop above never reaches the predicate;
// these rows do.
test(".dockerignore negation verdicts hold for synthetic patterns", () => {
  const cases: { pattern: string; readmits: boolean }[] = [
    { pattern: "README.md", readmits: false }, // disjoint literal
    { pattern: "docs/**", readmits: false }, // glob under a disjoint root
    { pattern: ".env*", readmits: true }, // glob extending a protected root
    { pattern: "**", readmits: true }, // matches everything
    { pattern: "\\.env", readmits: true }, // backslash escape: judged by the empty literal
    { pattern: "./node_modules", readmits: true }, // dot segment cleans onto the root
    { pattern: "logs/../.git/config", readmits: true }, // parent segment cleans under the root
  ];
  for (const { pattern, readmits } of cases) {
    // The pattern rides along in the asserted value so a red run names the row.
    expect({ pattern, readmits: KEEP_OUT.some((entry) => negationReadmits(pattern, entry)) })
      .toEqual({ pattern, readmits });
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
