import { join } from "node:path";
import { config } from "dotenv";
import { PROJECT_ROOT } from "./root.ts";

config({ "path": join(PROJECT_ROOT, ".env"), "quiet": true });
