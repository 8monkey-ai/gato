import { describe, expect, test } from "bun:test";

import { dueMilestone, parseHours, withinHours } from "./policy.ts";

const minute = 60_000;
const defaults = [5, 35, 755, 765].map((m) => m * minute);

describe("dueMilestone", () => {
  test("selects no nudge at minute 34 after agent activity at minute 6", () => {
    expect(
      dueMilestone(0, [6 * minute], defaults, 34 * minute),
    ).toBeUndefined();
  });

  test("selects the 35 minute milestone at minute 35", () => {
    expect(dueMilestone(0, [6 * minute], defaults, 35 * minute)).toBe(
      35 * minute,
    );
  });

  test("selects the earliest open milestone after a gap", () => {
    expect(dueMilestone(0, [], defaults, 800 * minute)).toBe(5 * minute);
    expect(
      dueMilestone(0, [790 * minute], defaults, 800 * minute),
    ).toBeUndefined();
  });
});

describe("permitted hours", () => {
  test("checks local time in the configured timezone", () => {
    const hours = parseHours("09:00-18:00");
    const utcMorning = new Date("2026-01-05T02:00:00Z");
    expect(withinHours(utcMorning, hours, "Asia/Kuala_Lumpur")).toBe(true);
    expect(withinHours(utcMorning, hours, "UTC")).toBe(false);
  });

  test("supports ranges past midnight and rejects bad input", () => {
    expect(
      withinHours(
        new Date("2026-01-05T23:30:00Z"),
        parseHours("22:00-06:00"),
        "UTC",
      ),
    ).toBe(true);
    expect(() => parseHours("9-18")).toThrow();
  });
});
