import { expect, test } from "bun:test";

import { retryEligible } from "./retry-eligibility.ts";

const attemptAt = new Date("2026-11-04T10:00:00Z");
const eligible = {
  attemptAt,
  open: true,
  agentOwned: true,
  substantiveMessageTimes: [new Date("2026-11-04T09:59:00Z")],
};

test("open, agent-owned, no message after the attempt: eligible", () => {
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

test("closed: not eligible", () => {
  expect(retryEligible({ ...eligible, open: false })).toBe(false);
});

test("not agent-owned: not eligible", () => {
  expect(retryEligible({ ...eligible, agentOwned: false })).toBe(false);
});
