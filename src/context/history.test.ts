import { expect, test } from "bun:test";

import { project } from "../record/projection.ts";
import type { Author, Delivery, Entry, EntryBody } from "../record/types.ts";
import { type HistoryItem, selectHistory } from "./history.ts";

const now = new Date("2026-11-04T12:00:00.000Z");

function entries(bodies: (EntryBody & { at?: string })[]): Entry[] {
  return bodies.map((body, i) => ({
    at: "2026-11-04T11:00:00.000Z",
    ...body,
    seq: i + 1,
  }));
}

const message = (
  id: string,
  author: Author,
  sentAt: string,
  delivery: Delivery = "observed",
): EntryBody => ({
  type: "message",
  message: { id, author, sentAt, text: id, attachments: [], delivery },
});

const ids = (items: HistoryItem[]) =>
  items.map((item) =>
    item.kind === "message"
      ? item.message.id
      : item.kind === "tool"
        ? `tool:${item.call.callId}`
        : `trigger:${item.trigger.text}`,
  );

const options = {
  scope: "chat" as const,
  includeToolActivity: false,
  now,
  timeZone: "UTC",
};

test("keeps only visible messages, ordered by sent time", () => {
  const view = project(
    entries([
      message("c1", { role: "customer" }, "2026-11-04T10:00:00.000Z"),
      message("late", { role: "agent" }, "2026-11-04T10:30:00.000Z", "sent"),
      message("delayed", { role: "customer" }, "2026-11-04T10:20:00.000Z"),
      message(
        "unsure",
        { role: "agent" },
        "2026-11-04T10:21:00.000Z",
        "uncertain",
      ),
      message(
        "draft",
        { role: "agent" },
        "2026-11-04T10:22:00.000Z",
        "superseded",
      ),
      message("fail", { role: "agent" }, "2026-11-04T10:23:00.000Z", "failed"),
      message("wait", { role: "agent" }, "2026-11-04T10:24:00.000Z", "pending"),
      message(
        "op",
        { role: "operator", name: "Ana" },
        "2026-11-04T10:25:00.000Z",
      ),
      { type: "note", by: "system", kind: "info", text: "private" },
      { type: "handoff", path: "tool", reason: "help" },
      { type: "labels", labels: ["x"] },
    ]),
  );
  expect(ids(selectHistory(view, options))).toEqual([
    "c1",
    "delayed",
    "op",
    "late",
  ]);
});

test("recent-month scope drops messages older than one calendar month", () => {
  const view = project(
    entries([
      message("old", { role: "customer" }, "2026-10-04T11:59:59.000Z"),
      message("edge", { role: "customer" }, "2026-10-04T12:00:00.000Z"),
    ]),
  );
  expect(
    ids(selectHistory(view, { ...options, scope: "recent-month" })),
  ).toEqual(["edge"]);
  expect(ids(selectHistory(view, options))).toEqual(["old", "edge"]);
});

test("tool pairs and triggers appear at their record time only when enabled", () => {
  const view = project(
    entries([
      message("c1", { role: "customer" }, "2026-11-04T10:00:00.000Z"),
      {
        type: "trigger",
        turnId: "t1",
        text: "Nudge",
        at: "2026-11-04T10:05:00.000Z",
      },
      {
        type: "tool-call",
        turnId: "t1",
        callId: "k1",
        name: "read_skill",
        input: {},
        at: "2026-11-04T10:06:00.000Z",
      },
      {
        type: "tool-call",
        turnId: "t1",
        callId: "open",
        name: "read_skill",
        input: {},
        at: "2026-11-04T10:06:00.000Z",
      },
      {
        type: "tool-result",
        turnId: "t1",
        callId: "k1",
        name: "read_skill",
        output: "ok",
        isError: false,
        at: "2026-11-04T10:07:00.000Z",
      },
      message("a1", { role: "agent" }, "2026-11-04T10:08:00.000Z", "sent"),
    ]),
  );
  expect(
    ids(selectHistory(view, { ...options, includeToolActivity: true })),
  ).toEqual(["c1", "trigger:Nudge", "tool:k1", "a1"]);
  expect(ids(selectHistory(view, options))).toEqual(["c1", "a1"]);
});
