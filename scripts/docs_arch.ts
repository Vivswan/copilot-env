// `bun run docs:arch`: the module map rendered from architecture.json into the GENERATED region
// of docs/architecture.md. `--check` exits 1 on drift instead of rewriting, for CI and the page
// test (test/utils/docs_architecture.test.ts). The map shows the DECLARED edges; the lint
// (test/utils/architecture.test.ts) keeps the declaration equal to the import graph.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readArchitecture,
  renderArchitectureMap,
  spliceGeneratedRegion,
} from "../test/lint/architecture.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARCHITECTURE_PAGE = join("docs", "architecture.md");

const args = process.argv.slice(2);
const check = args.includes("--check");
const unknown = args.filter((arg) => arg !== "--check");
if (unknown.length > 0) {
  console.error(`docs:arch: unknown argument ${unknown.join(" ")} (only --check is accepted)`);
  process.exit(2);
}

const pagePath = join(ROOT, ARCHITECTURE_PAGE);
const current = readFileSync(pagePath, "utf8");
const next = spliceGeneratedRegion(current, renderArchitectureMap(readArchitecture(ROOT)));
if (next === current) {
  console.log(`docs:arch: ${ARCHITECTURE_PAGE} module map is current`);
} else if (check) {
  console.error(
    `docs:arch: ${ARCHITECTURE_PAGE} module map differs from architecture.json; run \`bun run docs:arch\` to rewrite it`,
  );
  process.exit(1);
} else {
  writeFileSync(pagePath, next);
  console.log(`docs:arch: wrote the ${ARCHITECTURE_PAGE} module map`);
}
