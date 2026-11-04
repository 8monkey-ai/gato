import { describe, expect, test } from "bun:test";

import {
  calendarMonthBefore,
  localDate,
  minutesOfDay,
  readTimeZone,
} from "../../src/time/zone.ts";

describe("readTimeZone", () => {
  test("defaults to UTC", () => {
    expect(readTimeZone({})).toBe("UTC");
  });

  test("returns the canonical id of an IANA zone name", () => {
    expect(readTimeZone({ GATO_TIMEZONE: "Asia/Manila" })).toBe("Asia/Manila");
    expect(readTimeZone({ GATO_TIMEZONE: "asia/manila" })).toBe("Asia/Manila");
  });

  test("rejects unknown names, offsets and date-times with an actionable message", () => {
    for (const value of ["Malaysia", "+08:00", "2024-01-01T00:00Z"]) {
      expect(() => readTimeZone({ GATO_TIMEZONE: value })).toThrow(
        new Error(
          "GATO_TIMEZONE: expected an IANA time zone name such as UTC or Asia/Kuala_Lumpur, not an offset or a date-time",
        ),
      );
    }
  });
});

describe("zone helpers", () => {
  // 2024-03-31T17:30:00Z is 01:30 on 1 April in Kuala Lumpur (UTC+8).
  const lateUtc = Date.UTC(2024, 2, 31, 17, 30);

  test("localDate crosses midnight with the zone", () => {
    expect(localDate(lateUtc, "UTC")).toBe("2024-03-31");
    expect(localDate(lateUtc, "Asia/Kuala_Lumpur")).toBe("2024-04-01");
  });

  test("minutesOfDay is local", () => {
    expect(minutesOfDay(lateUtc, "UTC")).toBe(1050);
    expect(minutesOfDay(lateUtc, "Asia/Kuala_Lumpur")).toBe(90);
  });

  test("calendarMonthBefore keeps local time and clamps to the last day of the month", () => {
    expect(calendarMonthBefore(lateUtc, "UTC")).toBe(
      Date.UTC(2024, 1, 29, 17, 30),
    );
    expect(calendarMonthBefore(Date.UTC(2023, 2, 31, 12), "UTC")).toBe(
      Date.UTC(2023, 1, 28, 12),
    );
    // 31 March 01:30 in Kuala Lumpur is still 30 March in UTC, so only the local month end clamps.
    expect(
      calendarMonthBefore(Date.UTC(2024, 2, 30, 17, 30), "Asia/Kuala_Lumpur"),
    ).toBe(Date.UTC(2024, 1, 28, 17, 30));
  });
});
