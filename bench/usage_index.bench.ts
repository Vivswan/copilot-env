// `agent cost` over a seeded tree, three ways: every file parsed, a cold index, a warm index.
// Sized by COPILOT_ENV_USAGE_FIXTURE_MB (30 MiB unset); `deno task bench`.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { removeDir, tmpDir } from "../test/helpers.ts";
import { generateUsageTree } from "../test/helpers/usage_fixtures.ts";
import { runCurrentCost } from "../test/helpers/usage_goldens.ts";

const MB = Number(process.env.COPILOT_ENV_USAGE_FIXTURE_MB || "30");
if (!Number.isFinite(MB) || MB <= 0) {
  throw new Error("COPILOT_ENV_USAGE_FIXTURE_MB must be a positive number");
}

const root = tmpDir("usage-index-bench-");
const homes = tmpDir("usage-index-bench-home-");
globalThis.addEventListener("unload", () => {
  removeDir(root);
  removeDir(homes);
});
await generateUsageTree({ root, mb: MB, seed: 1 });

const warmHome = join(homes, "warm");
await runCurrentCost(root, { copilotApiHome: warmHome });

Deno.bench(`${MB} MiB tree: --no-index`, async () => {
  await runCurrentCost(root, { noIndex: true });
});

Deno.bench(`${MB} MiB tree: cold index`, async (b) => {
  const home = join(homes, "cold");
  rmSync(home, { recursive: true, force: true });
  b.start();
  await runCurrentCost(root, { copilotApiHome: home });
  b.end();
});

Deno.bench(`${MB} MiB tree: warm index`, { baseline: true }, async () => {
  await runCurrentCost(root, { copilotApiHome: warmHome });
});
