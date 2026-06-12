import { describe, expect, test } from "bun:test";
import {
  GATE_SHAPES,
  type GateShape,
  imageGenerationPatchState,
  patchImageGenerationSource,
  selectGateShape,
  unpatchImageGenerationSource,
} from "../src/codex/app_patch.ts";

// The gate shape for the current Codex builds (the most recent entry in the table).
const SHAPE = GATE_SHAPES[GATE_SHAPES.length - 1];
if (!SHAPE) throw new Error("GATE_SHAPES must not be empty");

// A faithful slice of the minified gate loop the current Codex app ships -- note the
// extra `{disableExposureLog:!0}` gate-check arg that newer builds added. Identifiers
// are minified and change per release, which is why the transforms capture them with
// backreferences and the shapes are version-keyed.
const ORIGINAL =
  "function sg(e){let t={};for(let n of ng)ln(e,n.gateName,{disableExposureLog:!0})&&(t[n.featureKey]=!0);return t}";
const PATCHED =
  'function sg(e){let t={};for(let n of ng)ln(e,n.gateName,{disableExposureLog:!0})&&n.featureKey!=="image_generation"&&(t[n.featureKey]=!0);return t}';
// The legacy (older Codex / original shell script) shape: no extra gate-check arg,
// guard written with a backtick template literal. The current regex still handles it.
const LEGACY_ORIGINAL =
  "function Wg(e){let t={};for(let n of zg)Dt(e,n.gateName)&&(t[n.featureKey]=!0);return t}";
const LEGACY_PATCHED_BACKTICK =
  "function Wg(e){let t={};for(let n of zg)Dt(e,n.gateName)&&n.featureKey!==`image_generation`&&(t[n.featureKey]=!0);return t}";

describe("imageGenerationPatchState", () => {
  test("classifies current-shape original / patched / absent", () => {
    expect(imageGenerationPatchState(ORIGINAL, SHAPE)).toBe("unpatched");
    expect(imageGenerationPatchState(PATCHED, SHAPE)).toBe("patched");
    expect(imageGenerationPatchState("function noop(){return 1}", SHAPE)).toBe("absent");
  });

  test("still classifies the legacy (arg-less / backtick) shape", () => {
    expect(imageGenerationPatchState(LEGACY_ORIGINAL, SHAPE)).toBe("unpatched");
    expect(imageGenerationPatchState(LEGACY_PATCHED_BACKTICK, SHAPE)).toBe("patched");
  });

  test("tolerates renamed minified identifiers", () => {
    const renamed =
      "for(let q of Zx)$f(e,q.gateName,{disableExposureLog:!0})&&(R0[q.featureKey]=!0)";
    expect(imageGenerationPatchState(renamed, SHAPE)).toBe("unpatched");
    expect(imageGenerationPatchState(patchImageGenerationSource(renamed, SHAPE), SHAPE)).toBe(
      "patched",
    );
  });
});

describe("patchImageGenerationSource", () => {
  test("inserts the guard on the current shape", () => {
    expect(patchImageGenerationSource(ORIGINAL, SHAPE)).toBe(PATCHED);
  });

  test("is idempotent (patching twice = once)", () => {
    const once = patchImageGenerationSource(ORIGINAL, SHAPE);
    expect(patchImageGenerationSource(once, SHAPE)).toBe(once);
  });

  test("no-op when the gate loop is absent", () => {
    const other = "function noop(){return 1}";
    expect(patchImageGenerationSource(other, SHAPE)).toBe(other);
  });
});

describe("unpatchImageGenerationSource", () => {
  test("removes the guard, restoring the current-shape original", () => {
    expect(unpatchImageGenerationSource(PATCHED, SHAPE)).toBe(ORIGINAL);
  });

  test("also cleans the legacy backtick variant", () => {
    expect(unpatchImageGenerationSource(LEGACY_PATCHED_BACKTICK, SHAPE)).toBe(LEGACY_ORIGINAL);
  });

  test("is idempotent (un-patching a clean file = no-op)", () => {
    expect(unpatchImageGenerationSource(ORIGINAL, SHAPE)).toBe(ORIGINAL);
  });
});

describe("round-trip", () => {
  test("patch then un-patch returns the exact original", () => {
    const there = patchImageGenerationSource(ORIGINAL, SHAPE);
    expect(there).not.toBe(ORIGINAL);
    expect(unpatchImageGenerationSource(there, SHAPE)).toBe(ORIGINAL);
  });
});

describe("selectGateShape", () => {
  test("every table entry has an x.y.z minVersion and a patch/unpatch regex", () => {
    expect(GATE_SHAPES.length).toBeGreaterThan(0);
    for (const s of GATE_SHAPES) {
      expect(s.minVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(s.patch).toBeInstanceOf(RegExp);
      expect(s.unpatch).toBeInstanceOf(RegExp);
    }
  });

  test("selects the entry at or below the installed version", () => {
    // The pinned build itself, and anything newer, resolve to a shape.
    expect(selectGateShape(SHAPE.minVersion)).toBe(SHAPE);
    expect(selectGateShape("99.0.0")).toBe(SHAPE);
  });

  test("returns null for builds older than every entry", () => {
    expect(selectGateShape("1.0.0")).toBeNull();
  });

  test("returns null for a non-comparable / garbage version (never mis-selects)", () => {
    expect(selectGateShape("")).toBeNull();
    expect(selectGateShape("unknown")).toBeNull();
    expect(selectGateShape("not.a.version")).toBeNull();
  });

  test("picks the GREATEST minVersion at or below the version (multi-entry table)", () => {
    const lo: GateShape = { minVersion: "26.609.30741", patch: /lo/, unpatch: /lo/ };
    const hi: GateShape = { minVersion: "27.100.0", patch: /hi/, unpatch: /hi/ };
    const table = [lo, hi];
    expect(selectGateShape("26.609.30741", table)).toBe(lo);
    expect(selectGateShape("27.000.0", table)).toBe(lo); // below hi, at/above lo
    expect(selectGateShape("27.100.0", table)).toBe(hi); // reaches hi
    expect(selectGateShape("28.0.0", table)).toBe(hi); // above hi
    expect(selectGateShape("1.0.0", table)).toBeNull(); // below both
  });

  test("maxVersion is an inclusive ceiling that disables the patch for newer builds", () => {
    const capped: GateShape = {
      minVersion: "26.609.30741",
      maxVersion: "26.999.99999",
      patch: /x/,
      unpatch: /x/,
    };
    const table = [capped];
    expect(selectGateShape("26.609.30741", table)).toBe(capped); // at min
    expect(selectGateShape("26.999.99999", table)).toBe(capped); // at the ceiling (inclusive)
    expect(selectGateShape("27.000.0", table)).toBeNull(); // past the ceiling -> auto-disabled
  });
});

describe("test isolation", () => {
  // Guards the whole suite: without this env (set by test/setup.ts via the bunfig
  // [test].preload), runCodex/init tests would patch a real installed Codex app.
  test("the preload disables the real desktop-app patch", () => {
    expect(process.env.COPILOT_API_NO_APP_PATCH).toBe("1");
  });
});
