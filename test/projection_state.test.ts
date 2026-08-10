import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";

import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { ProxyProjectionState } from "../src/copilot_api/projection_state.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function tmpPaths(): CopilotApiPaths {
  dir = isolateProxyHome("copilot-projections-");
  return new CopilotApiPaths();
}

test("recorded paths round-trip; an empty record never materializes a file", () => {
  const paths = tmpPaths();
  const state = new ProxyProjectionState(paths);
  expect(state.ownedPaths()).toEqual([]);

  // Writing "nothing owned" over "nothing recorded" is a no-op, so a default-configured
  // start never litters every daemon home with an empty record file.
  state.setOwnedPaths([]);
  expect(existsSync(paths.projectionsFile)).toBe(false);

  state.setOwnedPaths([["contextManagement", "responses"], ["messageApiWebSearchModel"]]);
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([
    ["contextManagement", "responses"],
    ["messageApiWebSearchModel"],
  ]);

  state.setOwnedPaths([]);
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([]);
});

test("the record parser drops a malformed entry WHOLE, never truncating it to a parent path", () => {
  const paths = tmpPaths();
  writeFileSync(
    paths.projectionsFile,
    JSON.stringify({
      optInPaths: [
        // A non-string key drops the ENTIRE entry -- truncating it to ["contextManagement"]
        // would claim a parent record we never wrote.
        ["contextManagement", 5],
        ["", "responses"],
        [],
        "junk",
        ["messageApiWebSearchModel"],
      ],
    }),
  );
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([["messageApiWebSearchModel"]]);
});

test("a non-array optInPaths value reads as owning nothing", () => {
  const paths = tmpPaths();
  writeFileSync(paths.projectionsFile, JSON.stringify({ optInPaths: { bogus: true } }));
  expect(new ProxyProjectionState(paths).ownedPaths()).toEqual([]);
});
