// The plan half of a managed write: the rows a patch yields over a document.
import { applyPatch, planPatch, remove, set } from "../src/agents/write_plan.ts";
import { expect, test } from "./helpers/testing.ts";

test("planPatch names only what the apply changes: a re-populated table is no removal, a scalar in a table's way is one", () => {
  // A table removed then re-set is no removal (an empty `auth` table would otherwise read as
  // `remove` while the apply keeps it); a TOML datetime where a table goes is replaced, not
  // patched in place.
  const current = { auth: {}, table: new Date("2025-01-01T00:00:00Z") };
  const rows = planPatch(current, [
    remove(["auth"]),
    set(["auth"], { command: "new" }),
    set(["table", "base_url"], "https://x"),
  ]);
  expect(rows.map((r) => [r.key, r.status])).toEqual([
    ["auth.command", "set"],
    ["table", "remove"],
    ["table.base_url", "set"],
  ]);
  const doc = applyPatch(structuredClone(current), [
    remove(["auth"]),
    set(["auth"], { command: "new" }),
    set(["table", "base_url"], "https://x"),
  ]);
  expect(doc).toEqual({ auth: { command: "new" }, table: { base_url: "https://x" } });
});
