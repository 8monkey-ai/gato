import { expect, test } from "bun:test";

import { project } from "./projection.ts";
import type { Author, Entry, EntryBody } from "./types.ts";

function entries(...bodies: (EntryBody & { eventId?: string })[]): Entry[] {
  return bodies.map((body, i) => ({
    ...body,
    seq: i + 1,
    at: `2026-11-04T10:00:0${i}.000Z`,
  }));
}

function message(
  id: string,
  author: Author,
  sentAt: string,
  text = id,
): EntryBody {
  return {
    type: "message",
    message: {
      id,
      author,
      sentAt,
      text,
      attachments: [],
      delivery: "observed",
    },
  };
}

const customer: Author = { role: "customer" };

test("keeps the newest ownership and status and ignores older events", () => {
  const view = project(
    entries(
      {
        type: "ownership",
        owner: "human",
        assigneeId: "u1",
        eventAt: "2026-11-04T10:05:00Z",
      },
      { type: "ownership", owner: "agent", eventAt: "2026-11-04T10:01:00Z" },
      { type: "status", open: false, eventAt: "2026-11-04T10:05:00Z" },
      { type: "status", open: true, eventAt: "2026-11-04T09:00:00Z" },
    ),
  );
  expect(view.ownership).toEqual({
    owner: "human",
    assigneeId: "u1",
    eventAt: "2026-11-04T10:05:00Z",
  });
  expect(view.open).toEqual({ open: false, eventAt: "2026-11-04T10:05:00Z" });
});

test("orders messages by sent time and applies echo updates", () => {
  const view = project(
    entries(
      message("m2", customer, "2026-11-04T10:02:00Z"),
      {
        ...message("a1", { role: "agent" }, "2026-11-04T10:03:00Z"),
        eventId: "e0",
      },
      message("m1", customer, "2026-11-04T10:01:00Z"),
      {
        type: "message-update",
        messageId: "a1",
        delivery: "sent",
        platformId: "p9",
        sentAt: "2026-11-04T10:00:30Z",
      },
    ),
  );
  expect(view.messages.map((m) => [m.id, m.delivery, m.sentAt])).toEqual([
    ["a1", "sent", "2026-11-04T10:00:30Z"],
    ["m1", "observed", "2026-11-04T10:01:00Z"],
    ["m2", "observed", "2026-11-04T10:02:00Z"],
  ]);
  expect(view.messageIdByPlatformId.get("p9")).toBe("a1");
  expect([...view.seenEventIds]).toEqual(["e0"]);
  expect(view.lastSeq).toBe(4);
  expect(view.latestCustomerAt).toBe("2026-11-04T10:02:00Z");
});

test("migrated customer messages without an event id are not pending", () => {
  const view = project(
    entries(message("m1", customer, "2026-11-04T10:00:00Z")),
  );
  expect(view.answeredThroughSeq).toBe(0);
  expect(view.hasPendingInput).toBe(false);
});

const turn = (turnId: string, inputThroughSeq: number): EntryBody => ({
  type: "turn-start",
  turnId,
  trigger: "customer",
  inputThroughSeq,
  instructionsRevision: "r1",
});

test("input counts as answered only through turns that were not superseded or interrupted", () => {
  const view = project(
    entries(
      { ...message("m1", customer, "2026-11-04T10:00:00Z"), eventId: "e1" },
      turn("t1", 1),
      { type: "turn-end", turnId: "t1", outcome: "completed" },
      { ...message("m2", customer, "2026-11-04T10:01:00Z"), eventId: "e2" },
      turn("t2", 4),
      { type: "turn-end", turnId: "t2", outcome: "interrupted" },
    ),
  );
  expect(view.answeredThroughSeq).toBe(1);
  expect(view.hasPendingInput).toBe(true);
  expect(view.turns.map((t) => t.end?.outcome)).toEqual([
    "completed",
    "interrupted",
  ]);

  const answered = project(
    entries(
      { ...message("m1", customer, "2026-11-04T10:00:00Z"), eventId: "e1" },
      turn("t1", 1),
      { type: "turn-end", turnId: "t1", outcome: "skipped" },
    ),
  );
  expect(answered.answeredThroughSeq).toBe(1);
  expect(answered.hasPendingInput).toBe(false);
});

test("collects labels, records and attachment updates", () => {
  const withAttachment: EntryBody = {
    type: "message",
    message: {
      id: "m1",
      author: customer,
      sentAt: "2026-11-04T10:00:00Z",
      attachments: [{ id: "a1", category: "image", source: "s" }],
      delivery: "observed",
    },
  };
  const view = project(
    entries(
      withAttachment,
      {
        type: "attachment-update",
        messageId: "m1",
        attachmentId: "a1",
        file: "attachments/m1-a1.jpg",
      },
      { type: "labels", labels: ["handoff"] },
      { type: "labels", labels: ["handoff", "error"] },
      { type: "note", by: "system", kind: "info", text: "n" },
      { type: "handoff", path: "error", reason: "r" },
      { type: "trigger", turnId: "t", text: "Nudge" },
    ),
  );
  expect(view.messages[0]?.attachments[0]?.file).toBe("attachments/m1-a1.jpg");
  expect(view.localLabels).toEqual(["handoff", "error"]);
  expect([
    view.notes.length,
    view.handoffs.length,
    view.triggers.length,
  ]).toEqual([1, 1, 1]);
});
