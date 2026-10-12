// `agent cost` over a seeded tree, three ways: every file parsed, a cold index, a warm index.
// Sized by COPILOT_ENV_USAGE_FIXTURE_MB (30 MiB unset); `bun run bench`.
import { join } from "node:path";
import { bench, run } from "mitata";
import { tempDir } from "../test/helpers/testing.ts";
import { generateUsageTree } from "../test/helpers/usage_fixtures.ts";
import { runCurrentCost } from "../test/helpers/usage_goldens.ts";

const MB = Number(process.env.COPILOT_ENV_USAGE_FIXTURE_MB || "30");
if (!Number.isFinite(MB) || MB <= 0) {
  throw new Error("COPILOT_ENV_USAGE_FIXTURE_MB must be a positive number");
}

// Both live under the isolate root testing.ts removes on unload.
const root = tempDir("usage-index-bench-");
const homes = tempDir("usage-index-bench-home-");
await generateUsageTree({ root, mb: MB, seed: 1 });

const warmHome = join(homes, "warm");
await runCurrentCost(root, { copilotApiHome: warmHome });

bench(`${MB} MiB tree: --no-index`, async () => {
  await runCurrentCost(root, { noIndex: true });
});

// A fresh home per call, inside the timed body: mitata's computed parameters promise no
// per-call recompute, and a reused home would time a warm index.
let cold = 0;
bench(`${MB} MiB tree: cold index`, async () => {
  await runCurrentCost(root, { copilotApiHome: join(homes, "cold", String(cold++)) });
});

bench(`${MB} MiB tree: warm index`, async () => {
  await runCurrentCost(root, { copilotApiHome: warmHome });
}).baseline(true);

await run();
