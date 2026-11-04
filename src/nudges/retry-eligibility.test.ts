import { expect, test } from "bun:test";

import { retryEligible } from "./retry-eligibility.ts";

const attemptAt = new Date("2026-11-04T10:00:00Z");
const eligible = {
  attemptAt,
  mayAnswer: true,
  substantiveMessageTimes: [new Date("2026-11-04T09:59:00Z")],
};

test("may be answered, no message after the attempt: eligible", () => {
  expect(retryEligible(eligible)).toBe(true);
});

test("a message after the attempt: not eligible", () => {
  const later = new Date("2026-11-04T10:01:00Z");
  expect(retryEligible({ ...eligible, substantiveMessageTimes: [later] })).toBe(
    false,
  );
});

test("a message at the attempt time: eligible", () => {
  expect(
    retryEligible({ ...eligible, substantiveMessageTimes: [attemptAt] }),
  ).toBe(true);
});

test("may not be answered: not eligible", () => {
  expect(retryEligible({ ...eligible, mayAnswer: false })).toBe(false);
});
