// Loads root .env defaults before CLI commands read configuration from process.env.
// Matches npm dotenv's config() contract: quiet no-op when .env is absent, and an
// already-set env var is never overridden.
import { join } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: `@std/dotenv` is a jsr import resolved by deno (deno.json imports map), not a node_modules package.
// biome-ignore lint/correctness/noUndeclaredDependencies: same -- the dependency lives in deno.json, not package.json.
import { parse } from "@std/dotenv/parse";
import { readTextOrNull } from "./fs.ts";
import { PROJECT_ROOT } from "./root.ts";

const raw = readTextOrNull(join(PROJECT_ROOT, ".env"));
if (raw !== null) {
  for (const [key, value] of Object.entries(parse(raw))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
