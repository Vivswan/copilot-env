// Record a corpus of REAL session logs: the installed `claude` and `codex` CLIs run scripted
// turns against the fake inference backend under a kept, runnable HOME at `<out>/home`, and
// scrubbed copies land at `<out>/claude` and `<out>/codex`. The contract is usage() in
// usage_corpus/cli.ts; the run itself is usage_corpus/main.ts.
import { main } from "./usage_corpus/main.ts";

export {
  IdMap,
  isClaudeUsageLine,
  isCodexUsageLine,
  type ScrubbedText,
  scrubJsonl,
} from "./usage_corpus/scrub.ts";

if (import.meta.main) await main();
