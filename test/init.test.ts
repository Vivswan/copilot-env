import { expect, test } from "bun:test";
import { runInit } from "../src/commands/init.ts";

// Exercises runInit's early flag validation, which throws BEFORE any auth/config
// I/O, so it needs no filesystem/network isolation. Credential management moved to
// `agent auth` (see auth.test.ts); init only validates flags then delegates.

test("init: --direct and --proxy are mutually exclusive", async () => {
  await expect(runInit({ direct: true, proxy: true })).rejects.toThrow(
    "--direct and --proxy are mutually exclusive",
  );
});
