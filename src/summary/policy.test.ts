import { expect, test } from "bun:test";

import { decideSummary, monthBefore } from "./policy.ts";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-03-31T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * day);

test("a summary younger than three days is reused, an older one is refreshed", () => {
  expect(decideSummary(now, ago(2.9), ago(10))).toBe("reuse");
  expect(decideSummary(now, ago(3), ago(10))).toBe("generate");
});

test("a first summary waits until the oldest recent message is three days old", () => {
  expect(decideSummary(now, undefined, ago(2))).toBe("skip");
  expect(decideSummary(now, undefined, ago(3))).toBe("generate");
  expect(decideSummary(now, undefined, undefined)).toBe("skip");
});

test("the recent month is one calendar month", () => {
  expect(monthBefore(now).toISOString()).toBe("2026-03-03T12:00:00.000Z");
  expect(monthBefore(new Date("2026-05-15T00:00:00Z")).toISOString()).toBe(
    "2026-04-15T00:00:00.000Z",
  );
});
