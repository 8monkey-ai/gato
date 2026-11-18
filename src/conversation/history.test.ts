import { expect, test } from "bun:test";

import { recentMonthStart } from "./history.ts";

test("the recent month starts one calendar month earlier in the timezone", () => {
  const now = new Date("2026-03-30T20:00:00.000Z");
  expect(new Date(recentMonthStart(now, "UTC")).toISOString()).toBe(
    "2026-02-28T20:00:00.000Z",
  );
  expect(
    new Date(recentMonthStart(now, "Asia/Kuala_Lumpur")).toISOString(),
  ).toBe("2026-02-27T20:00:00.000Z");
});

test("the recent month keeps the local time across a daylight saving change", () => {
  const now = new Date("2026-04-15T12:00:00.000Z");
  expect(new Date(recentMonthStart(now, "Europe/Berlin")).toISOString()).toBe(
    "2026-03-15T13:00:00.000Z",
  );
});
