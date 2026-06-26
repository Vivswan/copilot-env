import { expect, test } from "bun:test";

import { formatDuration } from "../src/utils/time.ts";

test("formatDuration renders compact durations and omits zero components", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(-5000)).toBe("0s"); // negatives clamp
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(60_000)).toBe("1m");
  expect(formatDuration(90_000)).toBe("1m30s");
  expect(formatDuration(3_600_000)).toBe("1h");
  expect(formatDuration(3_660_000)).toBe("1h1m");
  expect(formatDuration(5_430_000)).toBe("1h30m30s");
  expect(formatDuration(499)).toBe("0s"); // rounds to whole seconds
  expect(formatDuration(1_500)).toBe("2s"); // round-half-up
});
