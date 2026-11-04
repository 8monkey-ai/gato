import { describe, expect, test } from "bun:test";

import { recentMonthStart, summaryDecision } from "./policy.ts";

const now = new Date("2026-11-04T10:00:00Z");
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);

describe("summaryDecision", () => {
  test("summary 71 hours old is reused", () => {
    expect(summaryDecision({ now, summaryGeneratedAt: hoursAgo(71) })).toBe(
      "reuse",
    );
  });

  test("summary 72 hours old is refreshed", () => {
    expect(summaryDecision({ now, summaryGeneratedAt: hoursAgo(72) })).toBe(
      "refresh",
    );
  });

  test("no summary and oldest recent message 72 hours old: generate", () => {
    expect(summaryDecision({ now, oldestRecentMessageAt: hoursAgo(72) })).toBe(
      "generate",
    );
  });

  test("no summary and oldest recent message 71 hours old: none", () => {
    expect(summaryDecision({ now, oldestRecentMessageAt: hoursAgo(71) })).toBe(
      "none",
    );
  });

  test("no summary and no recent message: none", () => {
    expect(summaryDecision({ now })).toBe("none");
  });
});

describe("recentMonthStart", () => {
  const start = (iso: string, timeZone: string) =>
    recentMonthStart(new Date(iso), timeZone).toISOString();

  test("same wall-clock time one month earlier in UTC", () => {
    expect(start("2026-11-04T10:15:30.250Z", "UTC")).toBe(
      "2026-10-04T10:15:30.250Z",
    );
  });

  test("January goes back to December of the previous year", () => {
    expect(start("2026-01-15T00:00:00Z", "UTC")).toBe(
      "2025-12-15T00:00:00.000Z",
    );
  });

  test("March 31 clamps to the last day of February", () => {
    expect(start("2026-03-31T10:00:00Z", "UTC")).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(start("2028-03-31T10:00:00Z", "UTC")).toBe(
      "2028-02-29T10:00:00.000Z",
    );
  });

  test("uses the calendar of the timezone", () => {
    // 2026-03-01 04:00 in Kuala Lumpur
    expect(start("2026-02-28T20:00:00Z", "Asia/Kuala_Lumpur")).toBe(
      "2026-01-31T20:00:00.000Z",
    );
    // 2026-03-31 00:30 in Kuala Lumpur
    expect(start("2026-03-30T16:30:00Z", "Asia/Kuala_Lumpur")).toBe(
      "2026-02-27T16:30:00.000Z",
    );
  });

  test("keeps the wall-clock time across a daylight saving change", () => {
    // 2026-03-20 08:00 EDT -> 2026-02-20 08:00 EST
    expect(start("2026-03-20T12:00:00Z", "America/New_York")).toBe(
      "2026-02-20T13:00:00.000Z",
    );
    // 2026-04-08 03:30 EDT -> 2026-03-08 03:30 EDT, one hour after the change
    expect(start("2026-04-08T07:30:00Z", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });
});
