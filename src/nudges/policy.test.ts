import { expect, test } from "bun:test";

import { type Entry, initialState } from "../conversation/entry.ts";
import type { NudgeSettings } from "./policy.ts";
import { expiryDue, nudgeDue } from "./policy.ts";

const minute = 60_000;
const start = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minutes: number) =>
  new Date(start + minutes * minute).toISOString();
const settings: NudgeSettings = {
  nudges: true,
  expiry: true,
  intervalMs: 5 * minute,
  milestonesMs: [5, 35, 755, 765].map((m) => m * minute),
  hours: { from: 0, to: 24 },
  expiryMs: 825 * minute,
  exemptLabel: "out-of-scope-unsolved",
  instruction: "Nudge",
};
const customer: Entry = {
  kind: "message",
  id: "c",
  at: at(0),
  role: "customer",
};
const agentAt = (minutes: number): Entry => ({
  kind: "message",
  id: `a${minutes}`,
  at: at(minutes),
  role: "agent",
  delivery: "sent",
});

test("no nudge at minute 34 after agent activity at minute 6, but one at minute 35", () => {
  const entries = [customer, agentAt(6)];
  expect(
    nudgeDue(entries, initialState(), settings, start + 34 * minute),
  ).toBeUndefined();
  expect(nudgeDue(entries, initialState(), settings, start + 35 * minute)).toBe(
    35 * minute,
  );
});

test("a nudge note at the milestone covers it, and milestones count from the customer message", () => {
  const note: Entry = {
    kind: "note",
    id: "n",
    at: at(35),
    type: "nudge",
    text: "Nudge",
    byAgent: true,
  };
  expect(
    nudgeDue(
      [customer, agentAt(6), note],
      initialState(),
      settings,
      start + 754 * minute,
    ),
  ).toBeUndefined();
  expect(
    nudgeDue(
      [customer, agentAt(6), note],
      initialState(),
      settings,
      start + 755 * minute,
    ),
  ).toBe(755 * minute);
});

test("expiry needs the threshold, agent activity after the customer message, and no earlier expiry", () => {
  expect(
    expiryDue([customer], initialState(), settings, start + 900 * minute),
  ).toBeUndefined();
  expect(
    expiryDue(
      [customer, agentAt(1)],
      initialState(),
      settings,
      start + 824 * minute,
    ),
  ).toBeUndefined();
  expect(
    expiryDue(
      [customer, agentAt(1)],
      initialState(),
      settings,
      start + 825 * minute,
    )?.elapsedMs,
  ).toBe(825 * minute);
  const expired = { ...initialState(), expiredFor: at(0) };
  expect(
    expiryDue([customer, agentAt(1)], expired, settings, start + 900 * minute),
  ).toBeUndefined();
  expect(
    nudgeDue([customer], expired, settings, start + 40 * minute),
  ).toBeUndefined();
});

test("without customer activity nothing is due", () => {
  expect(
    nudgeDue([agentAt(1)], initialState(), settings, start + 100 * minute),
  ).toBeUndefined();
  expect(
    expiryDue([agentAt(1)], initialState(), settings, start + 900 * minute),
  ).toBeUndefined();
});
