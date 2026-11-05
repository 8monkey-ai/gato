import { expect, test } from "bun:test";

import { formatLocal, monthBefore } from "./time.ts";

test("one calendar month back in the configured timezone", () => {
  expect(
    monthBefore(
      new Date("2026-03-31T16:30:00Z"),
      "Asia/Kuala_Lumpur",
    ).toISOString(),
  ).toBe("2026-02-28T16:30:00.000Z");
  expect(
    monthBefore(new Date("2026-03-15T00:00:00Z"), "UTC").toISOString(),
  ).toBe("2026-02-15T00:00:00.000Z");
});

test("formats event times in the configured timezone", () => {
  expect(formatLocal("2026-11-05T02:05:00.000Z", "Asia/Manila")).toBe(
    "2026-11-05 10:05",
  );
});
