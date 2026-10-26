// Runs at import, so it must be imported before any command reads process.env. The file is read
// under installStateRoot, not PROJECT_ROOT: in a versioned install PROJECT_ROOT is the
// `<top>/current` link, and a user's .env is machine state at the top root; read through the link
// it would vanish after every update.
import { join } from "node:path";
import { parse } from "@std/dotenv/parse";
import { readTextOrNull } from "./fs.ts";
import { installStateRoot } from "./root.ts";

// The top root, not PROJECT_ROOT: a user's .env is machine state and must survive every update.
const raw = readTextOrNull(join(installStateRoot(), ".env"));

if (raw !== null) {
  for (const [key, value] of Object.entries(parse(raw))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
