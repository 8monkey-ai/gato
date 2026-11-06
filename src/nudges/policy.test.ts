import { expect, test } from "bun:test";

import { selectMilestone, withinHours } from "./policy.ts";

const minute = 60_000;
const milestones = [5, 35, 755, 765].map((m) => m * minute);
const customer = new Date("2026-01-01T00:00:00Z");
const at = (minutes: number) => new Date(customer.getTime() + minutes * minute);

test("agent activity at minute 6 gives no nudge at minute 34 and one at minute 35", () => {
  expect(selectMilestone(at(34), customer, at(6), milestones)).toBeUndefined();
  expect(selectMilestone(at(35), customer, at(6), milestones)).toBe(
    35 * minute,
  );
});

test("the earliest passed milestone without later agent activity is selected", () => {
  expect(selectMilestone(at(5), customer, at(1), milestones)).toBe(5 * minute);
  expect(selectMilestone(at(800), customer, at(36), milestones)).toBe(
    755 * minute,
  );
  expect(
    selectMilestone(at(800), customer, at(790), milestones),
  ).toBeUndefined();
});

test("no customer activity gives no nudge", () => {
  expect(
    selectMilestone(at(100), undefined, undefined, milestones),
  ).toBeUndefined();
});

test("permitted hours use the timezone and can pass midnight", () => {
  const noonUtc = new Date("2026-01-01T12:00:00Z");
  expect(withinHours(noonUtc, "UTC", { from: 9 * 60, to: 18 * 60 })).toBe(true);
  expect(
    withinHours(noonUtc, "Asia/Kuala_Lumpur", { from: 9 * 60, to: 18 * 60 }),
  ).toBe(false);
  expect(
    withinHours(noonUtc, "Asia/Kuala_Lumpur", { from: 18 * 60, to: 6 * 60 }),
  ).toBe(true);
});
