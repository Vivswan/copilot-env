import { expect, test } from "bun:test";

import { assertSingleMode, resolveDirect } from "../src/utils/direct_probe.ts";

// --- assertSingleMode -------------------------------------------------------

test("assertSingleMode allows zero or one mode flag, rejects two or more", () => {
  expect(() => assertSingleMode({})).not.toThrow();
  expect(() => assertSingleMode({ direct: true })).not.toThrow();
  expect(() => assertSingleMode({ proxy: true })).not.toThrow();
  expect(() => assertSingleMode({ auto: true })).not.toThrow();
  for (const combo of [
    { direct: true, proxy: true },
    { direct: true, auto: true },
    { proxy: true, auto: true },
    { direct: true, proxy: true, auto: true },
  ]) {
    expect(() => assertSingleMode(combo)).toThrow(
      "--direct, --proxy, and --auto are mutually exclusive",
    );
  }
});

// --- resolveDirect (the force-vs-probe contract) ----------------------------

test("resolveDirect: --direct/--proxy force without probing; --auto and no-flag probe", () => {
  const detectTrue = () => true;
  const detectFalse = () => false;

  // Forced modes must NOT invoke the probe at all.
  let calls = 0;
  const spy = () => {
    calls++;
    return true;
  };
  expect(resolveDirect({ direct: true }, spy)).toBe(true);
  expect(resolveDirect({ proxy: true }, spy)).toBe(false);
  expect(calls).toBe(0);

  // --auto and no mode flag both run the probe and return its result.
  expect(resolveDirect({ auto: true }, detectTrue)).toBe(true);
  expect(resolveDirect({ auto: true }, detectFalse)).toBe(false);
  expect(resolveDirect({}, detectTrue)).toBe(true); // no flag == auto
  expect(resolveDirect({}, detectFalse)).toBe(false);
});
