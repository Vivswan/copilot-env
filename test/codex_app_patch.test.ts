import { describe, expect, test } from "bun:test";
import {
  imageGenerationPatchState,
  patchImageGenerationSource,
  unpatchImageGenerationSource,
} from "../src/codex/app_patch.ts";

// A faithful slice of the minified gate loop the Codex app ships (identifiers are
// minified and change per release, which is why the transforms capture them).
const ORIGINAL =
  "function Wg(e){let t={};for(let n of zg)Dt(e,n.gateName)&&(t[n.featureKey]=!0);return t}";
const PATCHED =
  'function Wg(e){let t={};for(let n of zg)Dt(e,n.gateName)&&n.featureKey!=="image_generation"&&(t[n.featureKey]=!0);return t}';
// The original shell script wrote the guard with a backtick template literal.
const PATCHED_BACKTICK =
  "function Wg(e){let t={};for(let n of zg)Dt(e,n.gateName)&&n.featureKey!==`image_generation`&&(t[n.featureKey]=!0);return t}";

describe("imageGenerationPatchState", () => {
  test("classifies original / patched / absent", () => {
    expect(imageGenerationPatchState(ORIGINAL)).toBe("unpatched");
    expect(imageGenerationPatchState(PATCHED)).toBe("patched");
    expect(imageGenerationPatchState(PATCHED_BACKTICK)).toBe("patched");
    expect(imageGenerationPatchState("function noop(){return 1}")).toBe("absent");
  });

  test("tolerates renamed minified identifiers", () => {
    const renamed = "for(let q of Zx)$f(e,q.gateName)&&(R0[q.featureKey]=!0)";
    expect(imageGenerationPatchState(renamed)).toBe("unpatched");
    expect(imageGenerationPatchState(patchImageGenerationSource(renamed))).toBe("patched");
  });
});

describe("patchImageGenerationSource", () => {
  test("inserts the guard on the original", () => {
    expect(patchImageGenerationSource(ORIGINAL)).toBe(PATCHED);
  });

  test("is idempotent (patching twice = once)", () => {
    const once = patchImageGenerationSource(ORIGINAL);
    expect(patchImageGenerationSource(once)).toBe(once);
  });

  test("no-op when the gate loop is absent", () => {
    const other = "function noop(){return 1}";
    expect(patchImageGenerationSource(other)).toBe(other);
  });
});

describe("unpatchImageGenerationSource", () => {
  test("removes the guard, restoring the original", () => {
    expect(unpatchImageGenerationSource(PATCHED)).toBe(ORIGINAL);
  });

  test("also cleans the backtick variant from the legacy script", () => {
    expect(unpatchImageGenerationSource(PATCHED_BACKTICK)).toBe(ORIGINAL);
  });

  test("is idempotent (un-patching a clean file = no-op)", () => {
    expect(unpatchImageGenerationSource(ORIGINAL)).toBe(ORIGINAL);
  });
});

describe("round-trip", () => {
  test("patch then un-patch returns the exact original", () => {
    const there = patchImageGenerationSource(ORIGINAL);
    expect(there).not.toBe(ORIGINAL);
    expect(unpatchImageGenerationSource(there)).toBe(ORIGINAL);
  });
});

describe("test isolation", () => {
  // Guards the whole suite: without this env (set by test/setup.ts via the bunfig
  // [test].preload), runCodex/init tests would patch a real installed Codex app.
  test("the preload disables the real desktop-app patch", () => {
    expect(process.env.COPILOT_API_NO_APP_PATCH).toBe("1");
  });
});
