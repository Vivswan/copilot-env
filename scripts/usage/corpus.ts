// Record a corpus of REAL session logs: the installed `claude` and `codex` CLIs run scripted
// turns against the fake inference backend under a kept, runnable HOME at `<out>/home`, and
// scrubbed copies land at `<out>/claude` and `<out>/codex`. The contract is usage() in
// corpus/cli.ts; the run itself is corpus/main.ts.
import { main } from "./corpus/main.ts";

if (import.meta.main) await main();
