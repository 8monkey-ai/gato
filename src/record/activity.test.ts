import { expect, test } from "bun:test";

import { latestAgentActivity, pendingMessages } from "./activity.ts";
import type { Entry } from "./entries.ts";

const customer = (id: string, at: string, trigger: boolean): Entry => ({
  type: "message",
  id,
  at,
  role: "customer",
  text: id,
  trigger,
});

test("answerable messages wait until a finished turn covers them", () => {
  const entries: Entry[] = [customer("a", "1", true), customer("b", "2", true)];
  expect(pendingMessages(entries).map((m) => m.id)).toEqual(["a", "b"]);
  entries.push({
    type: "turn",
    id: "t",
    at: "3",
    trigger: "customer",
    status: "interrupted",
    covers: ["a"],
  });
  expect(pendingMessages(entries).map((m) => m.id)).toEqual(["a", "b"]);
  entries.push({
    type: "turn",
    id: "u",
    at: "4",
    trigger: "customer",
    status: "completed",
    covers: ["a", "b"],
  });
  expect(pendingMessages(entries)).toEqual([]);
});

test("a newer message from a human-owned time cancels the wait", () => {
  expect(
    pendingMessages([customer("a", "1", true), customer("b", "2", false)]),
  ).toEqual([]);
});

test("failed sends are not agent activity, agent notes are", () => {
  const entries: Entry[] = [
    {
      type: "note",
      id: "n",
      at: "2026-01-01T00:00:00Z",
      author: "agent",
      kind: "nudge",
      text: "",
    },
    {
      type: "message",
      id: "m",
      at: "2026-01-02T00:00:00Z",
      role: "agent",
      text: "x",
      delivery: "failed",
    },
  ];
  expect(latestAgentActivity(entries)?.toISOString()).toBe(
    "2026-01-01T00:00:00.000Z",
  );
});
