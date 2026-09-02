// Loads root .env defaults before CLI commands read configuration from process.env.
// Matches npm dotenv's config() contract: quiet no-op when .env is absent, and an
// already-set env var is never overridden.
import { join } from "node:path";
import { parse } from "@std/dotenv/parse";
import { readTextOrNull } from "./fs.ts";
import { installStateRoot } from "./root.ts";

// installStateRoot, not PROJECT_ROOT: in a versioned install PROJECT_ROOT is the
// `<top>/current` link, but a user's .env is machine state at the TOP root --
// reading it through the link would silently drop it after every update.
const raw = readTextOrNull(join(installStateRoot(), ".env"));
if (raw !== null) {
  for (const [key, value] of Object.entries(parse(raw))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
