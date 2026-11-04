import { describe, expect, test } from "bun:test";

import { selectAction, withinHours } from "./policy.ts";

const T = new Date("2026-11-04T10:00:00Z");
const minutes = (n: number) => new Date(T.getTime() + n * 60_000);
const defaults = {
  latestCustomerAt: T,
  agentActivity: [] as Date[],
  milestonesMs: [5 * 60_000, 35 * 60_000, 755 * 60_000, 765 * 60_000],
  expiryAfterMs: 825 * 60_000,
  nudgesEnabled: true,
  expiryEnabled: true,
  exemptLabelState: "absent" as const,
  withinPermittedHours: true,
};

test("selectAction: no customer activity gives no action", () => {
  const action = selectAction({
    ...defaults,
    latestCustomerAt: undefined,
    now: minutes(900),
  });
  expect(action).toEqual({ kind: "none", reason: "no customer activity" });
});

test("selectAction: agent message at minute 6: no nudge at minute 34, nudge 1 at minute 35", () => {
  const input = { ...defaults, agentActivity: [minutes(6)] };
  expect(selectAction({ ...input, now: minutes(34) }).kind).toBe("none");
  expect(selectAction({ ...input, now: minutes(35) })).toEqual({
    kind: "nudge",
    milestoneIndex: 1,
  });
});

test("selectAction: no agent activity at minute 5 gives nudge 0", () => {
  expect(selectAction({ ...defaults, now: minutes(5) })).toEqual({
    kind: "nudge",
    milestoneIndex: 0,
  });
});

test("selectAction: before the first milestone gives no action", () => {
  expect(selectAction({ ...defaults, now: minutes(4) }).kind).toBe("none");
});

test("selectAction: nudge note at a milestone satisfies that milestone", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [minutes(5), minutes(35)],
    now: minutes(40),
  });
  expect(action.kind).toBe("none");
});

test("selectAction: expires at 13h45m with agent activity after the customer message", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [minutes(6)],
    now: minutes(825),
  });
  expect(action).toEqual({ kind: "expire", elapsedMs: 49_500_000 });
});

test("selectAction: agent activity at the customer message time counts for expiry", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [T],
    now: minutes(825),
  });
  expect(action.kind).toBe("expire");
});

test("selectAction: does not expire before the threshold", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [minutes(6), minutes(35), minutes(755), minutes(765)],
    now: minutes(824),
  });
  expect(action.kind).toBe("none");
});

test("selectAction: no agent activity after the customer message: nudge instead of expiry", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [minutes(-10)],
    now: minutes(825),
  });
  expect(action).toEqual({ kind: "nudge", milestoneIndex: 0 });
});

test("selectAction: exempt label present: nudge but no expiry", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [minutes(6)],
    exemptLabelState: "present",
    now: minutes(825),
  });
  expect(action).toEqual({ kind: "nudge", milestoneIndex: 1 });
});

test("selectAction: exempt label unknown: no expiry, reason when no nudge is due", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [minutes(6), minutes(35), minutes(755), minutes(765)],
    exemptLabelState: "unknown",
    now: minutes(825),
  });
  expect(action).toEqual({
    kind: "none",
    reason: "expiry skipped: exemption labels unavailable",
  });
});

test("selectAction: exempt label unknown: nudge selection continues", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [minutes(6)],
    exemptLabelState: "unknown",
    now: minutes(825),
  });
  expect(action).toEqual({ kind: "nudge", milestoneIndex: 1 });
});

test("selectAction: expiry disabled: nudge instead", () => {
  const action = selectAction({
    ...defaults,
    agentActivity: [minutes(6)],
    expiryEnabled: false,
    now: minutes(825),
  });
  expect(action).toEqual({ kind: "nudge", milestoneIndex: 1 });
});

test("selectAction: nudges disabled gives no nudge", () => {
  const action = selectAction({
    ...defaults,
    nudgesEnabled: false,
    now: minutes(5),
  });
  expect(action).toEqual({ kind: "none", reason: "nudges disabled" });
});

test("selectAction: outside permitted hours gives no nudge but allows expiry", () => {
  const input = {
    ...defaults,
    agentActivity: [minutes(6)],
    withinPermittedHours: false,
  };
  expect(selectAction({ ...input, now: minutes(35) })).toEqual({
    kind: "none",
    reason: "outside permitted hours",
  });
  expect(selectAction({ ...input, now: minutes(825) }).kind).toBe("expire");
});

describe("withinHours", () => {
  const office = { startMinutes: 9 * 60, endMinutes: 17 * 60 };

  test("checks the window in the given timezone", () => {
    const at = new Date("2026-11-04T08:30:00Z");
    expect(withinHours(at, office, "UTC")).toBe(false);
    expect(withinHours(at, office, "Asia/Kuala_Lumpur")).toBe(true);
  });

  test("start is inclusive and end is exclusive", () => {
    expect(withinHours(new Date("2026-11-04T09:00:00Z"), office, "UTC")).toBe(
      true,
    );
    expect(withinHours(new Date("2026-11-04T17:00:00Z"), office, "UTC")).toBe(
      false,
    );
  });

  test("end 1440 includes the last minute of the day", () => {
    const allDay = { startMinutes: 0, endMinutes: 1440 };
    expect(withinHours(new Date("2026-11-04T23:59:00Z"), allDay, "UTC")).toBe(
      true,
    );
    expect(withinHours(new Date("2026-11-04T00:00:00Z"), allDay, "UTC")).toBe(
      true,
    );
  });

  test("a window with start after end wraps midnight", () => {
    const night = { startMinutes: 22 * 60, endMinutes: 6 * 60 };
    expect(withinHours(new Date("2026-11-04T23:00:00Z"), night, "UTC")).toBe(
      true,
    );
    expect(withinHours(new Date("2026-11-04T05:59:00Z"), night, "UTC")).toBe(
      true,
    );
    expect(withinHours(new Date("2026-11-04T12:00:00Z"), night, "UTC")).toBe(
      false,
    );
  });
});
